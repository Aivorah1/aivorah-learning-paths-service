// AI Teacher: a spoken practice question for a non-arithmetic topic. The
// model writes candidates; each is validated, then answered again by the model
// WITHOUT the key, and only a question it answers the same way is used.
// Answers are short (1-4 words) so a spoken reply can be checked.
const { callWithFallback } = require('../llm/fallback');
const { parseJSON, withTimeout, clip, GenerationError } = require('../practiceFollowup/topicSkill');
const { buildSolvePrompt, verifiedOnly } = require('../practiceFollowup/questionAi');
const { normalize } = require('../practiceFollowup/text');
const { checkOutputSafety } = require('./safety');

async function generateQuestion({ topic, grade, language, lessonText, avoid = [] }, deps = {}) {
  const call = deps.callModel || ((p, temperature) => callWithFallback(p, { json: true, temperature }));
  const hi = language === 'hi';
  const prompt = `You are a school teacher. Write 3 NEW short-answer questions on "${topic.title}" (${topic.subject}, ${grade || ''}) that a student can answer OUT LOUD in 1-4 words. ${hi ? 'Write them in Hindi using Devanagari script.' : 'Write them in simple English.'} Reply with JSON only.
${lessonText ? `Use only facts from this curriculum text:\n"""\n${clip(lessonText, 3000)}\n"""` : 'Use only well-known facts a student of this grade learns.'}
Do not ask any of these again: ${avoid.slice(0, 15).map((q) => `"${clip(q, 120)}"`).join('; ') || 'none'}
Return {"questions":[{"question":"...","answers":["the answer","an accepted variant"],"explanation":"one sentence why"}]}`;
  const raw = parseJSON(await withTimeout(Promise.resolve(call(prompt, 0.5)), deps.timeoutMs || 45000));
  const seen = new Set(avoid.map((q) => normalize(q)));
  const candidates = (Array.isArray(raw?.questions) ? raw.questions : []).map((q) => {
    const question = clip(q?.question, 300);
    const answers = (Array.isArray(q?.answers) ? q.answers : [q?.answers]).map((a) => clip(a, 60)).filter((a) => a && a.split(/\s+/).length <= 4).slice(0, 3);
    if (!question || !answers.length || seen.has(normalize(question)) || !checkOutputSafety(`${question} ${answers.join(' ')}`)) return null;
    return { type: 'fill_blank', question, answers, explanation: clip(q?.explanation, 300) || '' };
  }).filter(Boolean);
  if (!candidates.length) throw new GenerationError('no valid question');
  const solved = parseJSON(await withTimeout(Promise.resolve(call(buildSolvePrompt({ grade, subject: topic.subject, topic: topic.title, lessonText }, candidates), 0)), deps.timeoutMs || 45000));
  const ok = verifiedOnly(candidates, solved);
  if (!ok.length) throw new GenerationError('no question passed the answer check');
  const q = ok[0];
  return { prompt: q.question, answers: q.answers, accept: [], explanation: q.explanation, answerFormat: 'text' };
}

// Curriculum lesson text + images for a topic, from the same index the
// Learning Paths lesson screen reads. null when unavailable (never invented).
async function curriculumContent(topic, deps = {}) {
  if (!topic?.key) return null;
  const { resolveTopicContent } = deps.qdrant || require('../qdrant');
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), deps.timeoutMs || 8000));
  let c = null;
  for (const name of [topic.title, topic.chapterTitle].filter(Boolean)) {
    c = await Promise.race([resolveTopicContent('CBSE', `Grade ${topic.grade}`, topic.subject, name).catch(() => null), timeout]);
    if (c) break;
  }
  if (!c) return null;
  const text = [c.intro, ...(Array.isArray(c.body) ? c.body : [])].filter((x) => typeof x === 'string').join('\n').trim();
  const images = (Array.isArray(c.images) ? c.images : []).filter((im) => im && /^https:\/\//.test(im.url || '')).slice(0, 6)
    .map((im) => ({ url: im.url, caption: clip(im.caption || im.description || '', 140) }));
  return text || images.length ? { text, images, source: c.sourceReference || null } : null;
}

module.exports = { generateQuestion, curriculumContent };
