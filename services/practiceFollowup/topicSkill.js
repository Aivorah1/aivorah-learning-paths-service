// Practise This Skill for ANY topic. When a missed test question isn't covered
// by the vetted catalogue (data/practice-skills), the follow-up becomes a
// "topic skill": its teaching and fresh questions are generated ONCE from the
// topic's lesson text and the questions the student missed, validated
// strictly, and saved in practice_followups.skill_pack (aivorah-db 0031).
// The answer keys live only there (service role); the browser gets the same
// public view as for catalogue skills. Grading stays deterministic on the
// server against these saved keys.
const { callWithFallback } = require('../llm/fallback');
const catalog = require('./catalog');

const PREFIX = 'topic:';
const MAX_LESSON_CHARS = 6000;
const GEN_TIMEOUT_MS = Number(process.env.PRACTICE_GENERATION_TIMEOUT_MS) || 60000;
const MIN_QUESTIONS = 4;

class GenerationError extends Error {}

function slug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'topic';
}
const isTopicSkillId = (id) => String(id || '').startsWith(PREFIX);
const topicSkillId = (topic) => `${PREFIX}${slug(topic)}`;
const defaultLabel = (topic) => `Understanding “${String(topic || 'this topic').slice(0, 80)}”`;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function buildPrompt({ topic, subject, grade, curriculum, lessonText, evidence }) {
  const missed = (evidence || []).slice(0, 8).map((e, i) =>
    `${i + 1}. Question: ${clip(e.question, 300)}\n   Correct answer: ${clip(e.correctAnswer, 200)}\n   Student's answer: ${clip(e.kind === 'incorrect' ? e.studentAnswer : (e.firstAnswer || e.studentAnswer), 200)} (${e.kind === 'incorrect' ? 'wrong' : 'right only on a second try'})`).join('\n');
  const lesson = clip(lessonText, MAX_LESSON_CHARS);
  return `You are Aivorah, a warm school tutor. A ${grade} ${subject} student (${curriculum || 'school'} curriculum) took a practice test on the topic "${topic}" and needs help with what they missed. Write a short follow-up lesson and NEW practice questions. Reply with JSON only.

${lesson ? `LESSON TEXT (the only source of facts — do not use outside knowledge):\n"""\n${lesson}\n"""\n` : 'No lesson text is available: use only facts stated in the missed questions and their correct answers.\n'}
QUESTIONS THE STUDENT MISSED (do NOT reuse these questions or ask them again in other words):
${missed || '(none listed)'}

Write:
1. "label": a short name for the idea the missed questions test, max 8 words (e.g. "Key events in the story Quality").
2. "teaching": a "refresher" and exactly 3 "methods", each a DIFFERENT way to teach the same idea, in simple age-appropriate words, 2-4 sentences each, never mentioning the student:
   - id "explanation": a plain explanation with one worked example from the lesson.
   - id "key_points": the key facts side by side as a small table (first row = headers, 2-4 rows).
   - id "step_by_step": 3-4 short steps for working out answers like these.
3. "rubric": "keyIdeas" (2-3 short sentences a sound explanation would connect to) and "acceptableSimpleWording" (3 short examples of simple wording that is fine).
4. "questions": exactly 6 NEW questions on the same ideas, alternating "mcq" and "fill_blank", each answerable from the lesson text, different from the missed questions and from the worked examples:
   - mcq: "question", "options" (3 or 4 short distinct options), "answer" (0-based index of the one correct option), "hint" (a small clue, not the answer), "solution" (1-2 sentences), "whyWrong" (object: option index -> one supportive sentence why it is wrong).
   - fill_blank: "question" containing ____ for the blank, "answers" (1-3 accepted answers, each 1-4 words), "hint", "solution", "wrongFeedback" (one supportive sentence).

Return exactly this shape:
{"label":"...","teaching":{"refresher":{"title":"...","body":"..."},"methods":[{"id":"explanation","name":"Explanation","title":"...","body":"...","examples":[{"label":"Example","text":"..."}]},{"id":"key_points","name":"Key points side by side","title":"...","body":"...","table":[["...","..."],["...","..."]]},{"id":"step_by_step","name":"Step by step","title":"...","body":"...","steps":["...","..."]}]},"rubric":{"keyIdeas":["..."],"acceptableSimpleWording":["..."]},"questions":[{"type":"mcq","question":"...","options":["...","...","..."],"answer":0,"hint":"...","solution":"...","whyWrong":{"1":"...","2":"..."}},{"type":"fill_blank","question":"... ____ ...","answers":["..."],"hint":"...","solution":"...","wrongFeedback":"..."}]}`;
}

function parseJSON(raw) {
  const text = String(raw || '');
  try { return JSON.parse(text); } catch { /* maybe wrapped */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function cleanMethod(m, id, name) {
  if (!m || typeof m !== 'object') return null;
  const body = clip(m.body, 900);
  if (!body) return null;
  const out = { id, name, title: clip(m.title, 120) || name, body };
  if (Array.isArray(m.examples)) out.examples = m.examples.filter((e) => e && e.text).slice(0, 3).map((e) => ({ label: clip(e.label, 40) || 'Example', text: clip(e.text, 300) }));
  if (Array.isArray(m.table)) {
    const rows = m.table.filter(Array.isArray).slice(0, 6).map((r) => r.slice(0, 4).map((c) => clip(c, 120)));
    if (rows.length >= 2) out.table = rows;
  }
  if (Array.isArray(m.steps)) out.steps = m.steps.map((s) => clip(s, 200)).filter(Boolean).slice(0, 5);
  return out;
}

// Turns the model's reply into a safe pack, or throws. Drops any question
// that isn't fully valid; needs at least MIN_QUESTIONS good ones.
function validatePack(parsed, { topic }) {
  if (!parsed || typeof parsed !== 'object') throw new GenerationError('no JSON');
  const t = parsed.teaching || {};
  const methodsIn = Array.isArray(t.methods) ? t.methods : [];
  const want = [['explanation', 'Explanation'], ['key_points', 'Key points side by side'], ['step_by_step', 'Step by step']];
  const methods = want.map(([id, name], i) => cleanMethod(methodsIn.find((m) => m?.id === id) || methodsIn[i], id, name)).filter(Boolean);
  if (methods.length < 2) throw new GenerationError('not enough teaching methods');
  const refresher = cleanMethod(t.refresher, 'refresher', 'Quick refresher') || { ...methods[0], id: 'refresher', name: 'Quick refresher' };

  const questions = [];
  for (const q of Array.isArray(parsed.questions) ? parsed.questions : []) {
    if (!q || typeof q !== 'object') continue;
    const question = clip(q.question, 400);
    const hint = clip(q.hint, 300);
    const solution = clip(q.solution, 500);
    if (!question || !hint || !solution) continue;
    if (q.type === 'mcq') {
      const options = Array.isArray(q.options) ? q.options.map((o) => clip(o, 200)).filter(Boolean) : [];
      const distinct = new Set(options.map((o) => o.toLowerCase()));
      const answer = Number(q.answer);
      if (options.length < 3 || options.length > 4 || distinct.size !== options.length || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
      const whyWrong = {};
      for (const [k, v] of Object.entries(q.whyWrong || {})) if (Number(k) !== answer && options[Number(k)] && clip(v, 300)) whyWrong[String(Number(k))] = clip(v, 300);
      questions.push({ type: 'mcq', question, options, answer, hint, solution, whyWrong });
    } else if (q.type === 'fill_blank') {
      if (!/_{2,}/.test(question)) continue;
      const answers = (Array.isArray(q.answers) ? q.answers : [q.answers]).map((a) => clip(a, 60)).filter((a) => a && a.split(' ').length <= 4).slice(0, 3);
      if (!answers.length) continue;
      questions.push({ type: 'fill_blank', question, answers, accept: [], hint, solution, wrongFeedback: clip(q.wrongFeedback, 300) || solution });
    }
  }
  if (questions.length < MIN_QUESTIONS) throw new GenerationError(`only ${questions.length} valid questions`);
  questions.forEach((q, i) => { q.id = `tq-${i + 1}`; q.examples = []; });

  const r = parsed.rubric || {};
  const keyIdeas = (Array.isArray(r.keyIdeas) ? r.keyIdeas : []).map((k) => clip(k, 240)).filter(Boolean).slice(0, 4);
  const pack = {
    version: 1,
    generated: true,
    label: clip(parsed.label, 80) || defaultLabel(topic),
    shortName: clip(topic, 60),
    teaching: { refresher, methods, confusions: [] },
    rubric: {
      keyIdeas: keyIdeas.length ? keyIdeas : [`The answer matches what the lesson on "${clip(topic, 60)}" says.`],
      acceptableSimpleWording: (Array.isArray(r.acceptableSimpleWording) ? r.acceptableSimpleWording : []).map((k) => clip(k, 120)).filter(Boolean).slice(0, 4),
      misconceptionRules: [],
      misconceptionFeedback: 'Your answer is right, but the reason doesn’t quite match the lesson. Look back at what the lesson says about it.',
    },
    nextPractice: `Review the key ideas in “${clip(topic, 60)}” and answer new questions about them.`,
    questions,
  };
  const problems = catalog.validateSkill({ id: 'x', ...pack });
  if (problems.length) throw new GenerationError(problems.join('; '));
  return pack;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('generation timed out')), ms); })]).finally(() => clearTimeout(t));
}

async function generatePack(ctx, deps = {}) {
  const call = deps.callModel || ((prompt) => callWithFallback(prompt, { json: true, temperature: 0.4 }));
  const prompt = buildPrompt(ctx);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return validatePack(parseJSON(await withTimeout(Promise.resolve(call(prompt)), deps.timeoutMs || GEN_TIMEOUT_MS)), ctx);
    } catch (err) {
      lastErr = err;
      console.error(`[practice-followup] topic pack attempt ${attempt} failed:`, err.message);
    }
  }
  throw new GenerationError(lastErr?.message || 'generation failed');
}

// The skill object the routes use for a follow-up: the catalogue skill, or
// the follow-up's own saved topic pack. null when a topic pack isn't built yet.
function skillForFollowup(f) {
  const fromCatalog = catalog.getSkill(f?.skill_id);
  if (fromCatalog) return fromCatalog;
  if (!isTopicSkillId(f?.skill_id) || !f?.skill_pack?.questions) return null;
  return catalog.compile({ ...f.skill_pack, id: f.skill_id, subject: f.subject, subjectPattern: '.*' });
}

// Label / short name to show before a topic pack exists.
function displayNames(f) {
  const s = catalog.getSkill(f?.skill_id);
  if (s) return { label: s.label, shortName: s.shortName, nextPractice: s.nextPractice };
  return {
    label: f?.skill_pack?.label || defaultLabel(f?.topic),
    shortName: f?.skill_pack?.shortName || clip(f?.topic, 60) || 'This topic',
    nextPractice: f?.skill_pack?.nextPractice || `Review the key ideas in “${clip(f?.topic, 60)}” and answer new questions about them.`,
  };
}

module.exports = { PREFIX, GenerationError, isTopicSkillId, topicSkillId, defaultLabel, buildPrompt, validatePack, generatePack, skillForFollowup, displayNames, MAX_LESSON_CHARS };
