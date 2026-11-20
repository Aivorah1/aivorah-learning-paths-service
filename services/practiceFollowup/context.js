// Shared loaders for the practice follow-up routes.
const store = require('./store');
const catalog = require('./catalog');
const topicSkill = require('./topicSkill');
const { recommendForAttempt } = require('./recommend');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Server clock; tests replace now() to simulate coming back a week later.
const clock = { now: () => Date.now() };

// Creates (once) and returns the follow-ups one test attempt recommends.
async function syncFollowups(attempt, topicIdParam) {
  const { recommendations, unmapped } = recommendForAttempt(attempt);
  const existing = await store.listFollowupsForAttempt(attempt.id);
  const have = new Set(existing.map((f) => f.skill_id));
  const topicId = UUID.test(String(topicIdParam || '')) ? topicIdParam : null;
  const missing = recommendations.filter((r) => !have.has(r.skillId)).map((r) => ({
    student_id: attempt.student_id,
    attempt_id: attempt.id,
    skill_id: r.skillId,
    topic: attempt.topic,
    topic_id: topicId,
    subject: attempt.subject,
    grade: attempt.grade,
    curriculum: attempt.curriculum || '',
    original_score: attempt.score,
    evidence: r.evidence,
    evidence_question_count: r.evidence.length,
    status: 'available',
  }));
  await store.createFollowups(missing);
  const followups = missing.length ? await store.listFollowupsForAttempt(attempt.id) : existing;
  return { followups, unmapped };
}

// A topic follow-up practised question by question has no pack: give it a
// minimal skill (rubric only) so grading and reasoning checks work.
function liteSkill(f) {
  const names = topicSkill.displayNames(f);
  return catalog.compile({
    id: f.skill_id, label: names.label, shortName: names.shortName, subject: f.subject, subjectPattern: '.*',
    // Explanations are written per wrong question (Explain This Question);
    // this one entry only keeps the shared session view working.
    teaching: { refresher: null, methods: [{ id: 'rule', name: 'The idea', title: 'Ask Aivorah', body: `Ask Aivorah explains each question you missed in “${String(f.topic || '').slice(0, 60)}”.` }], confusions: [] },
    rubric: {
      keyIdeas: [`The answer matches what the lesson on “${String(f.topic || '').slice(0, 60)}” says.`],
      acceptableSimpleWording: [], misconceptionRules: [],
      misconceptionFeedback: 'Your answer is right, but the reason doesn’t quite match the lesson. Look back at what the lesson says about it.',
    },
    nextPractice: names.nextPractice,
    questions: [],
  });
}

// The skill for a follow-up with every question it can be asked: the vetted
// catalogue bank or saved topic pack, plus its generated practice questions.
async function loadSkill(f, generated) {
  const base = topicSkill.skillForFollowup(f) || (topicSkill.isTopicSkillId(f.skill_id) ? liteSkill(f) : null);
  if (!base) return null;
  const rows = generated || await store.listGeneratedQuestions(f.id);
  if (!rows.length) return base;
  const extra = rows.map((r) => ({ ...r.payload, id: r.question_id, level: r.level, originIndex: r.origin_question_index, examples: [] }));
  const { _match, _subject, _concepts, _byId, ...raw } = base;
  return catalog.compile({ ...raw, questions: [...(base.questions || []), ...extra] });
}

// Lesson text to ground explanations and questions: what the student sees
// (sent by the app), else the stored topic resources, else the catalogue text.
async function lessonTextFor(f, given) {
  const sent = typeof given === 'string' ? given.trim().slice(0, topicSkill.MAX_LESSON_CHARS) : '';
  if (sent) return sent;
  const stored = await store.getTopicLessonText(f.topic_id).catch(() => '');
  if (stored) return stored;
  const cat = catalog.getSkill(f.skill_id);
  if (cat) return [cat.teaching?.refresher?.body, ...(cat.teaching?.methods || []).map((m) => m.body)].filter(Boolean).join('\n');
  return '';
}

module.exports = { UUID, clock, syncFollowups, loadSkill, liteSkill, lessonTextFor };
