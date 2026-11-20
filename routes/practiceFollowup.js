/**
 * routes/practiceFollowup.js — "Practise This Skill"
 *
 * Follow-up practice for one curriculum skill, started from a practice test
 * report and done in the topic's Ask Aivorah tab. The server owns the result:
 * who may see what, which fresh question is asked, grading against the
 * catalogue's answer key, hint history, the saved session and the support
 * flags. Model text never changes a score or marks a skill complete.
 *
 * Student (own data only, Firebase student token):
 *   GET  /practice-followup/attempts/:attemptId        recommendations for one test
 *   GET  /practice-followup/for-topic?topic=&subject=  open follow-up for a topic (Ask Aivorah)
 *   GET  /practice-followup/:id                        resumable session
 *   POST /practice-followup/:id/open                   { lessonText? } same, grounding a new topic pack
 *   POST /practice-followup/:id/explain-another-way    { message? }
 *   POST /practice-followup/:id/hint                   { questionId }
 *   POST /practice-followup/:id/solution               { questionId }
 *   POST /practice-followup/:id/answer                 { questionId, answer, reasoning }
 *   POST /practice-followup/:id/clarify                { questionId, reasoning }
 *   GET  /practice-followup/:id/details                finalized questions, answers, feedback
 * Parent (linked children only):
 *   GET  /practice-followup/parent/children/:childId
 * Teacher (their linked students only):
 *   GET  /practice-followup/teacher/support
 *   GET  /practice-followup/teacher/students/:studentId/skills/:skillId
 */
const express = require('express');
const { requireAuth, requireStudentAuth, requireParentAuth } = require('../middleware/auth');
const catalog = require('../services/practiceFollowup/catalog');
const store = require('../services/practiceFollowup/store');
const session = require('../services/practiceFollowup/session');
const { recommendForAttempt } = require('../services/practiceFollowup/recommend');
const { parseAnswer, gradeAnswer, correctAnswerText, wrongFeedback } = require('../services/practiceFollowup/grading');
const reasoningCheck = require('../services/practiceFollowup/reasoning');
const { computeTopicHelp } = require('../services/practiceFollowup/topicHelp');
const topicSkill = require('../services/practiceFollowup/topicSkill');
const ctxLoad = require('../services/practiceFollowup/context');
const questionAi = require('../services/practiceFollowup/questionAi');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { MESSAGES } = session;

const saveFailed = (res, err) => {
  if (err instanceof topicSkill.GenerationError) {
    return res.status(503).json({ code: 'generation_failed', error: 'Aivorah could not prepare your practice questions just now. Please try again.' });
  }
  console.error('[practice-followup] save failed:', err?.message);
  return res.status(503).json({ code: 'save_failed', error: "Your progress couldn't be saved just now. Please try again." });
};

// ── helpers ──────────────────────────────────────────────────────────────
async function loadOwnFollowup(req, res) {
  if (!UUID.test(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const f = await store.getFollowup(req.params.id);
  // Same answer for "missing" and "someone else's": never reveals another learner's data.
  if (!f || f.student_id !== req.auth.studentId) { res.status(404).json({ error: 'Not found' }); return null; }
  // The skill with its bank / topic pack and generated practice questions.
  // A topic skill opened the first way has no skill until its pack is built.
  const skill = (f.current_focus_index != null || topicSkill.skillForFollowup(f)) ? await ctxLoad.loadSkill(f) : null;
  if (!skill && !topicSkill.isTopicSkillId(f.skill_id)) { res.status(410).json({ code: 'skill_unavailable', error: 'This practice is no longer available.' }); return null; }
  return { f, skill };
}

// Actions on a question need the built skill.
function requireBuilt(own, res) {
  if (own.skill) return true;
  res.status(409).json({ code: 'reload', error: 'Please reload this practice.' });
  return false;
}

// Builds and saves a topic pack the first time a topic follow-up is opened.
async function ensurePack(f, lessonText) {
  if (topicSkill.skillForFollowup(f)) return f;
  const text = String(lessonText || '').slice(0, topicSkill.MAX_LESSON_CHARS) || await store.getTopicLessonText(f.topic_id);
  const pack = await topicSkill.generatePack({
    topic: f.topic, subject: f.subject, grade: f.grade, curriculum: f.curriculum, lessonText: text, evidence: f.evidence,
  });
  return (await store.saveSkillPack(f.id, pack)) || store.getFollowup(f.id);
}

// Brings a session up to date (teaching method saved, a fresh question
// chosen) and SAVES it before anything is shown. Returns the saved state.
async function ensureSession(f0, skill0, { lessonText } = {}) {
  const f = await ensurePack(f0, lessonText);
  const skill = skill0 || topicSkill.skillForFollowup(f);
  const [attempt, responses] = await Promise.all([store.getAttempt(f.attempt_id), store.listResponses(f.id)]);
  const p = session.deriveProgress(responses);
  const patch = {};
  if (p.completed) {
    if (f.status !== 'completed') Object.assign(patch, { status: 'completed', completed_at: p.completedAt, independent_streak: session.NEEDED_IN_A_ROW, current_question_id: null, current_help: 'none' });
  } else {
    if (!f.current_method) {
      const m = session.initialMethod(skill, f);
      patch.current_method = m;
      patch.teaching_methods_used = [...(f.teaching_methods_used || []), m];
    }
    if (f.status === 'available') patch.status = 'in_progress';
    if (f.independent_streak !== p.streak) patch.independent_streak = p.streak;
    if (!p.pending) {
      const currentOk = f.current_question_id && !p.answeredIds.has(f.current_question_id) && skill._byId.has(f.current_question_id);
      if (!currentOk) {
        const ctx = session.exclusionContext(skill, attempt);
        const next = session.pickNextQuestion(skill, ctx, { usedIds: p.answeredIds, lastType: p.last?.question_type });
        if ((next?.id || null) !== (f.current_question_id || null)) {
          patch.current_question_id = next ? next.id : null;
          patch.current_help = 'none';
        }
      }
    }
  }
  let saved = f;
  if (Object.keys(patch).length) {
    saved = await store.updateFollowup(f.id, patch, { expectQuestionId: f.current_question_id || null });
    // Another request moved it on first: show what is saved now.
    if (!saved) saved = await store.getFollowup(f.id);
  }
  const fresh = saved === f ? responses : await store.listResponses(f.id);
  return { f: saved, responses: fresh, attempt, skill };
}

function sessionView(f, skill, responses) {
  const p = session.deriveProgress(responses);
  const pendingQ = p.pending ? skill._byId.get(p.pending.question_id) : null;
  const q = !p.completed && !p.pending && f.current_question_id ? skill._byId.get(f.current_question_id) : null;
  const view = {
    followupId: f.id,
    attemptId: f.attempt_id,
    skill: { id: skill.id, label: skill.label, shortName: skill.shortName },
    topic: f.topic, subject: f.subject, grade: f.grade,
    originalScore: f.original_score != null ? Number(f.original_score) : null,
    status: p.completed ? 'completed' : f.status,
    progress: { confirmed: p.streak, needed: session.NEEDED_IN_A_ROW },
    teaching: session.teachingView(skill, f.current_method || session.initialMethod(skill, f), f),
    question: q ? { ...session.publicQuestion(q), number: responses.length + 1, helpShown: f.current_help, hint: f.current_help === 'hint' ? q.hint : null } : null,
    clarification: pendingQ ? {
      questionId: pendingQ.id,
      question: session.publicQuestion(pendingQ),
      yourAnswer: p.pending.answer,
      prompt: MESSAGES.clarify,
    } : null,
    unavailable: !p.completed && !q && !pendingQ ? MESSAGES.unavailable : null,
    complete: p.completed ? { title: MESSAGES.completeTitle, body: MESSAGES.completeBody } : null,
    outcome: session.outcomeOf(f, responses),
    answeredCount: responses.length,
  };
  return view;
}

function responseView(skill, r) {
  const q = skill._byId.get(r.question_id);
  return {
    seq: r.seq,
    questionId: r.question_id,
    type: r.question_type,
    question: r.question_text,
    options: q?.type === 'mcq' ? q.options : null,
    yourAnswer: r.answer,
    yourReasoning: r.reasoning,
    clarification: r.clarification,
    helpUsed: r.help_shown,
    correct: r.grading_outcome === 'correct',
    gradingOutcome: r.grading_outcome,
    reasoningOutcome: r.reasoning_outcome,
    credit: r.credit,
    feedback: r.feedback,
    // A finalized question's answer is released for review.
    correctAnswer: r.credit !== 'pending_clarification' && q ? correctAnswerText(q) : null,
    answeredAt: r.finalized_at || r.created_at,
  };
}

// After a question is finalized: next fresh question, and a new teaching
// method after two wrong answers in a row. Saved with a compare-and-set on
// the question just answered, so a repeat can't advance twice.
async function advanceAfter(f, skill, responses, answeredQuestionId) {
  const attempt = await store.getAttempt(f.attempt_id);
  const p = session.deriveProgress(responses);
  const patch = { independent_streak: p.streak, current_help: 'none', status: p.completed ? 'completed' : 'in_progress' };
  if (f.current_focus_index != null) {
    // Practise This Skill (per wrong question): no automatic next question,
    // the student asks for another; the 2-in-a-row rule never ends practice.
    if (p.completed && f.status !== 'completed') patch.completed_at = p.completedAt;
    if (!p.pending) Object.assign(patch, { current_question_id: null, current_is_memory_check: false });
  } else if (p.completed) {
    Object.assign(patch, { completed_at: p.completedAt, current_question_id: null });
  } else if (!p.pending) {
    const next = session.pickNextQuestion(skill, session.exclusionContext(skill, attempt), { usedIds: p.answeredIds, lastType: p.last?.question_type });
    patch.current_question_id = next ? next.id : null;
    if (p.lastTwoIncorrect) {
      const m = session.nextMethod(skill, f.teaching_methods_used);
      patch.current_method = m.id;
      patch.teaching_methods_used = [...(f.teaching_methods_used || []), m.id];
    }
  }
  const saved = await store.updateFollowup(f.id, patch, { expectQuestionId: answeredQuestionId });
  return saved || store.getFollowup(f.id);
}

function requireQuestionId(req, res) {
  const id = String(req.body?.questionId || '');
  if (!id || id.length > 64) { res.status(400).json({ error: 'questionId is required' }); return null; }
  return id;
}

// ── Recommendations for one test report ─────────────────────────────────
router.get('/attempts/:attemptId', requireStudentAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.attemptId)) return res.status(404).json({ error: 'Not found' });
    const attempt = await store.getAttempt(req.params.attemptId);
    if (!attempt || attempt.student_id !== req.auth.studentId) return res.status(404).json({ error: 'Not found' });

    const { followups, unmapped } = await syncFollowups(attempt, req.query.topicId);
    const responses = await store.listResponses(followups.map((f) => f.id));

    const items = followups.map((f) => {
      const names = topicSkill.displayNames(f);
      const mine = responses.filter((r) => r.followup_id === f.id);
      return {
        followupId: f.id,
        skillId: f.skill_id,
        label: names.label,
        shortName: names.shortName,
        status: session.deriveProgress(mine).completed ? 'completed' : f.status,
        evidenceCount: f.evidence_question_count,
        outcome: session.outcomeOf(f, mine),
        answeredCount: mine.filter((r) => r.credit !== 'pending_clarification').length,
      };
    });
    res.json({ attemptId: attempt.id, originalScore: Number(attempt.score), recommendations: items, unmappedQuestions: unmapped });
  } catch (err) {
    saveFailed(res, err);
  }
});

const { syncFollowups } = ctxLoad;

// ── Ask Aivorah on a topic: the follow-up to open there ─────────────────
// The newest test on this topic that recommends practice, and its first
// unfinished follow-up (created now if needed). null when there is none.
router.get('/for-topic', requireStudentAuth, async (req, res) => {
  try {
    const topic = String(req.query.topic || '').trim();
    if (!topic || topic.length > 300) return res.status(400).json({ error: 'topic is required' });
    const subject = String(req.query.subject || '').trim() || null;
    const attempts = await store.listStudentTopicAttempts(req.auth.studentId, topic, subject);
    for (const attempt of attempts) {
      const { followups } = await syncFollowups(attempt, req.query.topicId);
      if (!followups.length) continue;
      const responses = await store.listResponses(followups.map((f) => f.id));
      const open = followups.find((f) => f.status !== 'completed' && !session.deriveProgress(responses.filter((r) => r.followup_id === f.id)).completed);
      const pick = open || followups[0];
      // The first question that was wrong in that test (for Ask Aivorah to open).
      const wrongIdx = (attempt.per_question_results || []).findIndex((q, i) => q && q.type !== 'spoken' && !q.isCorrect && (pick.evidence || []).some((e) => e.index === i));
      return res.json({ followupId: pick.id, attemptId: attempt.id, completed: !open, questionIndex: wrongIdx >= 0 ? wrongIdx : null });
    }
    res.json({ followupId: null, attemptId: attempts[0]?.id || null, hasTest: attempts.length > 0 });
  } catch (err) {
    saveFailed(res, err);
  }
});

// ── Parent: linked child's saved follow-up outcomes ─────────────────────
router.get('/parent/children/:childId', requireParentAuth, async (req, res) => {
  try {
    const { childId } = req.params;
    if (!UUID.test(childId) || !(await store.isParentOf(req.auth.email, childId))) return res.status(403).json({ error: 'Not authorised.' });
    const [followups, responses, assessments] = await Promise.all([
      store.listFollowupsForStudents([childId]),
      store.listResponsesForStudents([childId]),
      store.countAssessments(childId),
    ]);
    const items = followups.map((f) => {
      const skill = topicSkill.displayNames(f);
      const mine = responses.filter((r) => r.followup_id === f.id);
      const outcome = session.outcomeOf(f, mine);
      return {
        followupId: f.id,
        topic: f.topic,
        subject: f.subject,
        skill: skill.shortName,
        skillLabel: skill.label,
        originalScore: f.original_score != null ? Number(f.original_score) : null,
        status: outcome.code === 'completed' ? 'completed' : f.status,
        outcome: outcome.parentText,
        outcomeLabel: outcome.label,
        updatedAt: f.completed_at || (mine[mine.length - 1]?.finalized_at) || f.updated_at,
      };
    }).filter(Boolean);
    // Tutoring conversations are never included: only saved outcomes.
    res.json({ childId, hasAssessments: assessments > 0, followups: items });
  } catch (err) {
    console.error('[practice-followup] parent view failed:', err.message);
    res.status(500).json({ error: 'Could not load learning follow-up.' });
  }
});

// ── Teacher: Needs topic help for their students ────────────────────────
router.get('/teacher/support', requireAuth, async (req, res) => {
  try {
    const ids = await store.teacherStudentIds(req.auth.teacherId);
    const [followups, responses] = await Promise.all([store.listFollowupsForStudents(ids), store.listResponsesForStudents(ids)]);
    const flags = computeTopicHelp(followups, responses);
    res.json({ students: [...flags.entries()].map(([studentId, topicHelp]) => ({ studentId, topicHelp })) });
  } catch (err) {
    console.error('[practice-followup] teacher support failed:', err.message);
    res.status(500).json({ error: 'Could not load topic help.' });
  }
});

router.get('/teacher/students/:studentId/skills/:skillId', requireAuth, async (req, res) => {
  try {
    const { studentId, skillId } = req.params;
    const ids = UUID.test(studentId) ? await store.teacherStudentIds(req.auth.teacherId) : [];
    if (!ids.includes(studentId)) return res.status(403).json({ error: 'Not authorised.' });
    const [followupsAll, responsesAll] = await Promise.all([store.listFollowupsForStudents([studentId]), store.listResponsesForStudents([studentId])]);
    const followups = followupsAll.filter((f) => f.skill_id === skillId);
    if (!followups.length && !catalog.getSkill(skillId)) return res.status(404).json({ error: 'Unknown skill' });
    const names = topicSkill.displayNames(followups.find((f) => f.skill_pack) || followups[0] || { skill_id: skillId });
    const skill = { id: skillId, label: names.label, shortName: names.shortName, subject: followups[0]?.subject || catalog.getSkill(skillId)?.subject || null, nextPractice: names.nextPractice };
    const responses = responsesAll.filter((r) => r.skill_id === skillId);
    const flag = (computeTopicHelp(followups, responses).get(studentId) || []).find((x) => x.skillId === skillId) || null;
    const attempts = await store.listAttempts([...new Set(followups.map((f) => f.attempt_id))]);
    const recentAttempts = followups.slice(0, 5).map((f) => {
      const a = attempts.find((x) => x.id === f.attempt_id) || {};
      const mine = responses.filter((r) => r.followup_id === f.id);
      const outcome = session.outcomeOf(f, mine);
      return {
        attemptId: f.attempt_id, topic: f.topic, subject: f.subject,
        score: a.score != null ? Number(a.score) : (f.original_score != null ? Number(f.original_score) : null),
        takenAt: a.created_at || f.created_at,
        questions: (f.evidence || []).map((e) => ({ question: e.question, kind: e.kind })),
        followupStatus: outcome.code, followupOutcome: outcome.parentText,
      };
    });
    res.json({
      studentId,
      skill: { id: skill.id, label: skill.label, shortName: skill.shortName, subject: skill.subject },
      needsTopicHelp: !!flag,
      flag,
      practiseNext: skill.nextPractice,
      recentAttempts,
    });
  } catch (err) {
    console.error('[practice-followup] teacher skill view failed:', err.message);
    res.status(500).json({ error: 'Could not load skill progress.' });
  }
});

// ── Student session ──────────────────────────────────────────────────────
async function openSession(req, res) {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    const lessonText = typeof req.body?.lessonText === 'string' ? req.body.lessonText : '';
    const { f, responses, skill } = await ensureSession(own.f, own.skill, { lessonText });
    res.json(sessionView(f, skill, responses));
  } catch (err) {
    saveFailed(res, err);
  }
}
router.get('/:id', requireStudentAuth, openSession);
// Same, with the lesson text the student is looking at, used (once) to
// ground a topic skill's teaching and questions.
router.post('/:id/open', requireStudentAuth, openSession);

router.get('/:id/details', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    const responses = await store.listResponses(own.f.id);
    if (!own.skill) return res.json({ followupId: own.f.id, skill: { id: own.f.skill_id, ...topicSkill.displayNames(own.f) }, topic: own.f.topic, outcome: session.outcomeOf(own.f, responses), questions: [] });
    res.json({
      followupId: own.f.id,
      skill: { id: own.skill.id, label: own.skill.label, shortName: own.skill.shortName },
      topic: own.f.topic,
      outcome: session.outcomeOf(own.f, responses),
      questions: responses.filter((r) => r.credit !== 'pending_clarification').map((r) => responseView(own.skill, r)),
    });
  } catch (err) {
    saveFailed(res, err);
  }
});

const NEED_ANOTHER_WAY = /(don'?t|do not|dont|didn'?t|not)\s+(understand|get|like|follow)|confus|another way|different way|explain (it |that )?again|not clear|makes? no sense|too hard|\bhuh\b|what\?/i;

router.post('/:id/explain-another-way', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 300) : '';
    // A typed message is only checked for "I don't understand"-style requests;
    // it is never passed on as an instruction.
    if (message && !NEED_ANOTHER_WAY.test(message)) {
      return res.json({ understood: false, reply: "I can explain this skill another way, give you a hint, or you can try the question. Tap Explain Another Way for a new explanation." });
    }
    const m = session.nextMethod(own.skill, own.f.teaching_methods_used);
    // Saved before it is shown, so a refresh never repeats this method.
    const saved = await store.updateFollowup(own.f.id, {
      current_method: m.id,
      teaching_methods_used: [...(own.f.teaching_methods_used || []), m.id],
      ...(own.f.status === 'available' ? { status: 'in_progress' } : {}),
    });
    if (!saved) return res.status(409).json({ code: 'reload', error: 'Please reload.' });
    const responses = await store.listResponses(saved.id);
    res.json({ understood: true, repeated: m.repeated, session: sessionView(saved, own.skill, responses) });
  } catch (err) {
    saveFailed(res, err);
  }
});

router.post('/:id/hint', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const questionId = requireQuestionId(req, res);
    if (!questionId) return;
    const { f } = own;
    if (f.current_question_id !== questionId || (f.status === 'completed' && f.current_focus_index == null)) return res.status(409).json({ code: 'stale', error: 'This question has changed. Please reload.' });
    const q = own.skill._byId.get(questionId);
    if (f.current_help === 'none') {
      // Save that help was shown BEFORE showing it: this question can no
      // longer earn independent credit.
      const saved = await store.updateFollowup(f.id, { current_help: 'hint' }, { expectQuestionId: questionId });
      if (!saved) return res.status(409).json({ code: 'stale', error: 'This question has changed. Please reload.' });
    }
    res.json({ questionId, hint: q.hint, helpShown: 'hint' });
  } catch (err) {
    saveFailed(res, err);
  }
});

router.post('/:id/solution', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const questionId = requireQuestionId(req, res);
    if (!questionId) return;
    const { f, skill } = own;
    const q = skill._byId.get(questionId);
    const responses = await store.listResponses(f.id);
    const existing = responses.find((r) => r.question_id === questionId);
    if (existing) return res.json({ duplicate: true, solution: q?.solution, correctAnswer: q ? correctAnswerText(q) : null, session: sessionView(f, skill, responses) });
    if (f.current_question_id !== questionId || (f.status === 'completed' && f.current_focus_index == null)) return res.status(409).json({ code: 'stale', error: 'This question has changed. Please reload.' });
    const inserted = await store.insertResponse({
      followup_id: f.id, student_id: f.student_id, skill_id: f.skill_id,
      question_id: q.id, question_type: q.type, question_text: q.question,
      seq: responses.length + 1,
      answer: null, reasoning: null,
      help_shown: 'solution', grading_outcome: 'not_answered', reasoning_outcome: 'not_evaluated', credit: 'none',
      feedback: q.solution, finalized_at: new Date(ctxLoad.clock.now()).toISOString(),
      ...focusFields(f),
    });
    if (inserted.duplicate) return res.status(409).json({ code: 'reload', error: 'Please reload.' });
    const all = [...responses, inserted.row];
    const saved = await advanceAfter(f, skill, all, questionId);
    res.json({ solution: q.solution, correctAnswer: correctAnswerText(q), message: MESSAGES.solution, session: sessionView(saved, skill, all) });
  } catch (err) {
    saveFailed(res, err);
  }
});

// Which wrong question / level / memory check an answer belongs to.
function focusFields(f) {
  if (f.current_focus_index == null) return {};
  return { origin_question_index: f.current_focus_index, question_level: f.current_question_level || null, is_memory_check: !!f.current_is_memory_check };
}

const ASK_FOR_WORKING = ' Tell me one step of how you worked it out, and I’ll find exactly where it went wrong.';

// A wrong answer's feedback: the exact step when the working shows it,
// otherwise the general correction plus a request for one working step.
async function diagnosisFor(f, q, parsed, working) {
  const d = await questionAi.diagnoseMistake(
    { grade: f.grade, subject: f.subject, topic: f.topic, lessonText: await ctxLoad.lessonTextFor(f) },
    { question: q, answerText: parsed.text, working },
  );
  if (d.status === 'identified') return { mistake_tag: d.step, reasoning_outcome: 'misconception', feedback: `${MESSAGES.incorrectLead}${d.feedback}` };
  return { feedback: `${MESSAGES.incorrectLead}${wrongFeedback(q, parsed)}${ASK_FOR_WORKING}` };
}

// The student explains how they worked out a wrong answer: Aivorah names the
// step only when the working supports it. The answer itself stays wrong.
router.post('/:id/working', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const questionId = requireQuestionId(req, res);
    if (!questionId) return;
    const working = reasoningCheck.cleanReasoning(req.body?.working);
    if (!working) return res.status(400).json({ error: 'Tell me one step of how you worked it out.' });
    const responses = await store.listResponses(own.f.id);
    const r = responses.find((x) => x.question_id === questionId);
    const q = own.skill._byId.get(questionId);
    if (!r || !q || r.grading_outcome !== 'incorrect') return res.status(409).json({ code: 'stale', error: 'Please reload.' });
    if (r.mistake_tag) return res.json({ duplicate: true, identified: true, step: r.mistake_tag, feedback: r.feedback });
    const d = await questionAi.diagnoseMistake(
      { grade: own.f.grade, subject: own.f.subject, topic: own.f.topic, lessonText: await ctxLoad.lessonTextFor(own.f) },
      { question: q, answerText: r.answer, working },
    );
    if (d.status !== 'identified') {
      await store.updateResponseWhere(r.id, { clarification: working });
      return res.json({ identified: false, feedback: 'Thanks! I still can’t tell exactly which step went wrong, so I won’t guess. Try a fresh question and show each step.' });
    }
    const updated = await store.updateResponseWhere(r.id, { clarification: working, mistake_tag: d.step, reasoning_outcome: 'misconception', feedback: `${MESSAGES.incorrectLead}${d.feedback}` }, { mistakeTagIsNull: true });
    res.json({ identified: true, step: d.step, feedback: (updated || r).feedback });
  } catch (err) {
    saveFailed(res, err);
  }
});

router.post('/:id/answer', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const questionId = requireQuestionId(req, res);
    if (!questionId) return;
    const { f, skill } = own;
    const q = skill._byId.get(questionId);
    const responses = await store.listResponses(f.id);

    // A repeated submit (double tap, retry after a timeout) returns the saved
    // result and adds no new evidence.
    const existing = responses.find((r) => r.question_id === questionId);
    if (existing) return res.json({ duplicate: true, result: resultView(skill, existing), session: sessionView(f, skill, responses) });
    if (!q || f.current_question_id !== questionId || (f.status === 'completed' && f.current_focus_index == null)) {
      return res.status(409).json({ code: 'stale', error: 'This question has changed. Please reload.' });
    }
    if (responses.some((r) => r.credit === 'pending_clarification')) return res.status(409).json({ code: 'clarification_pending', error: 'Finish your explanation first.' });

    const parsed = parseAnswer(q, req.body?.answer);
    if (!parsed) return res.status(400).json({ error: q.type === 'mcq' ? 'Choose one option.' : 'Type a short answer.' });
    const reasoning = reasoningCheck.cleanReasoning(req.body?.reasoning);
    const correct = gradeAnswer(q, parsed);
    const helped = f.current_help === 'hint';

    let row;
    if (!correct) {
      row = { grading_outcome: 'incorrect', reasoning_outcome: 'not_evaluated', credit: 'none', feedback: `${MESSAGES.incorrectLead}${wrongFeedback(q, parsed)}${MESSAGES.incorrectNext}` };
      if (f.current_focus_index != null) Object.assign(row, await diagnosisFor(f, q, parsed, reasoning));
    } else if (helped) {
      row = { grading_outcome: 'correct', reasoning_outcome: 'not_evaluated', credit: 'assisted', feedback: MESSAGES.assisted };
    } else {
      const ev = await reasoningCheck.evaluateReasoning({ skill, question: q, answerText: parsed.text, reasoning });
      if (ev.outcome === 'unable_to_evaluate') {
        // Never guess: nothing is saved; the student can submit again.
        return res.status(503).json({ code: 'evaluation_unavailable', error: MESSAGES.evaluationUnavailable });
      }
      if (ev.outcome === 'supported') row = { grading_outcome: 'correct', reasoning_outcome: 'supported', credit: 'independent', feedback: MESSAGES.independent };
      else if (ev.outcome === 'unclear') row = { grading_outcome: 'correct', reasoning_outcome: 'unclear', credit: 'pending_clarification', feedback: MESSAGES.clarify };
      else row = { grading_outcome: 'correct', reasoning_outcome: 'misconception', credit: 'none', feedback: `${ev.feedback || skill.rubric.misconceptionFeedback} Let's try another new question.` };
    }

    const inserted = await store.insertResponse({
      followup_id: f.id, student_id: f.student_id, skill_id: f.skill_id,
      question_id: q.id, question_type: q.type, question_text: q.question,
      seq: responses.length + 1,
      answer: parsed.text, reasoning: reasoning || null,
      help_shown: helped ? 'hint' : 'none',
      ...row,
      finalized_at: row.credit === 'pending_clarification' ? null : new Date(ctxLoad.clock.now()).toISOString(),
      ...focusFields(f),
    });
    if (inserted.duplicate) {
      const now = await store.listResponses(f.id);
      const saved = now.find((r) => r.question_id === questionId);
      return res.json({ duplicate: true, result: saved ? resultView(skill, saved) : null, session: sessionView(f, skill, now) });
    }
    const all = [...responses, inserted.row];
    let saved = f;
    if (row.credit !== 'pending_clarification') saved = await advanceAfter(f, skill, all, questionId);
    res.json({ result: resultView(skill, inserted.row), session: sessionView(saved, skill, all) });
  } catch (err) {
    saveFailed(res, err);
  }
});

router.post('/:id/clarify', requireStudentAuth, async (req, res) => {
  try {
    const own = await loadOwnFollowup(req, res);
    if (!own) return;
    if (!requireBuilt(own, res)) return;
    const questionId = requireQuestionId(req, res);
    if (!questionId) return;
    const { f, skill } = own;
    const responses = await store.listResponses(f.id);
    const r = responses.find((x) => x.question_id === questionId);
    if (!r) return res.status(409).json({ code: 'stale', error: 'Please reload.' });
    if (r.credit !== 'pending_clarification') return res.json({ duplicate: true, result: resultView(skill, r), session: sessionView(f, skill, responses) });

    const q = skill._byId.get(questionId);
    const clarification = reasoningCheck.cleanReasoning(req.body?.reasoning);
    if (!clarification) return res.status(400).json({ error: 'Tell me why in a few words.' });
    const combined = [r.reasoning, clarification].filter(Boolean).join(' ');
    const ev = await reasoningCheck.evaluateReasoning({ skill, question: q, answerText: r.answer, reasoning: combined.slice(0, reasoningCheck.MAX_REASONING_CHARS) });
    if (ev.outcome === 'unable_to_evaluate') return res.status(503).json({ code: 'evaluation_unavailable', error: MESSAGES.evaluationUnavailable });

    const patch = ev.outcome === 'supported'
      ? { reasoning_outcome: 'supported', credit: 'independent', feedback: MESSAGES.independent }
      : ev.outcome === 'misconception'
        ? { reasoning_outcome: 'misconception', credit: 'none', feedback: `${ev.feedback || skill.rubric.misconceptionFeedback} Let's try another new question.` }
        : { reasoning_outcome: 'unclear', credit: 'none', feedback: MESSAGES.clarifyUnclear };
    const updated = await store.resolvePendingResponse(r.id, { ...patch, clarification, finalized_at: new Date(ctxLoad.clock.now()).toISOString() });
    if (!updated) {
      const now = await store.listResponses(f.id);
      const saved = now.find((x) => x.id === r.id);
      return res.json({ duplicate: true, result: saved ? resultView(skill, saved) : null, session: sessionView(f, skill, now) });
    }
    const all = responses.map((x) => (x.id === r.id ? updated : x));
    const saved = await advanceAfter(f, skill, all, f.current_question_id || null);
    res.json({ result: resultView(skill, updated), session: sessionView(saved, skill, all) });
  } catch (err) {
    saveFailed(res, err);
  }
});

function resultView(skill, r) {
  const v = responseView(skill, r);
  const code = r.credit === 'independent' ? 'independent'
    : r.credit === 'assisted' ? 'assisted'
    : r.credit === 'pending_clarification' ? 'clarify'
    : r.help_shown === 'solution' ? 'solution'
    : r.grading_outcome === 'incorrect' ? 'incorrect'
    : r.reasoning_outcome === 'misconception' ? 'misconception' : 'unclear';
  return { ...v, code, message: r.feedback, correctAnswer: code === 'clarify' ? null : v.correctAnswer };
}

module.exports = router;
module.exports._test = { ensureSession, sessionView, NEED_ANOTHER_WAY };
