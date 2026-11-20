/**
 * routes/practiceQuestion.js — the two actions under each wrong question of a
 * practice test report, sharing Ask Aivorah and the saved follow-up history:
 *
 *   [Explain This Question]  explanation first, one wrong question at a time
 *     POST /practice-followup/attempts/:attemptId/questions/:index/explain
 *          { action: 'first' | 'again' | 'another_way', lessonText? }
 *   [Practise This Skill]    a fresh question first, as many as the student asks;
 *                            a delayed memory check when 7+ days have passed
 *     POST /practice-followup/attempts/:attemptId/questions/:index/practice
 *          { action: 'start' | 'next', lessonText? }
 *     (answer / hint / solution / clarify / working: routes/practiceFollowup.js)
 *   "What you worked on" per wrong question (saved rows only)
 *     GET  /practice-followup/attempts/:attemptId/worked-on
 *   Parent (linked child) / teacher (linked student) download data
 *     GET  /practice-followup/report/students/:studentId
 *
 * The server checks the attempt belongs to the signed-in student and the
 * question was wrong in it, chooses and validates questions, grades, saves,
 * and decides when a memory check is due (server clock). The model only
 * teaches, writes candidate questions and explains mistakes.
 */
const express = require('express');
const { requireStudentAuth, requireParentOrTeacherAuth } = require('../middleware/auth');
const store = require('../services/practiceFollowup/store');
const session = require('../services/practiceFollowup/session');
const learning = require('../services/practiceFollowup/learning');
const questionAi = require('../services/practiceFollowup/questionAi');
const topicSkill = require('../services/practiceFollowup/topicSkill');
const { normalize } = require('../services/practiceFollowup/text');
const { UUID, clock, syncFollowups, loadSkill, lessonTextFor } = require('../services/practiceFollowup/context');

const router = express.Router();

const fail = (res, err) => {
  if (err instanceof topicSkill.GenerationError) {
    return res.status(503).json({ code: 'generation_failed', error: 'Aivorah couldn’t prepare that just now. Your progress is saved — please try again.' });
  }
  console.error('[practice-question] failed:', err?.message);
  return res.status(503).json({ code: 'save_failed', error: 'Your progress couldn’t be saved just now. Please try again.' });
};

// The signed-in student's attempt and one of its WRONG questions.
async function loadAttemptQuestion(req, res) {
  const { attemptId } = req.params;
  const index = Number(req.params.index);
  if (!UUID.test(attemptId) || !Number.isInteger(index) || index < 0) { res.status(404).json({ error: 'Not found' }); return null; }
  const attempt = await store.getAttempt(attemptId);
  if (!attempt || attempt.student_id !== req.auth.studentId) { res.status(404).json({ error: 'Not found' }); return null; }
  const wrong = learning.wrongQuestionsOf(attempt);
  const focus = wrong.find((w) => w.index === index);
  if (!focus) { res.status(400).json({ code: 'not_wrong', error: 'That question was not answered wrongly in this test.' }); return null; }
  const { followups } = await syncFollowups(attempt, req.body?.topicId || req.query.topicId);
  const f = learning.followupForIndex(followups, index);
  if (!f) { res.status(409).json({ code: 'reload', error: 'Please reload the report.' }); return null; }
  return { attempt, wrong, focus, index, f, followups };
}

const wrongList = (wrong) => wrong.map((w) => ({ index: w.index, question: w.question }));
const aiCtx = (f, lessonText) => ({ grade: f.grade, subject: f.subject, topic: f.topic, lessonText });

// ── Explain This Question ───────────────────────────────────────────────
router.post('/attempts/:attemptId/questions/:index/explain', requireStudentAuth, async (req, res) => {
  try {
    const c = await loadAttemptQuestion(req, res);
    if (!c) return;
    const action = ['first', 'again', 'another_way'].includes(req.body?.action) ? req.body.action : 'first';
    const mine = (await store.listExplanations({ attemptId: c.attempt.id })).filter((e) => e.question_index === c.index);
    const prev = mine[mine.length - 1];
    // Reopening shows the explanation already given (it is already recorded).
    if (action === 'first' && prev) return res.json(explainView(c, prev, mine, false));

    let method = 'rule';
    let repeated = false;
    if (action === 'again' && prev) method = prev.method;
    else if (action === 'another_way' && prev) ({ method, repeated } = questionAi.nextExplainMethod(mine.map((e) => e.method)));
    const variant = prev ? action : 'first';
    const exp = await questionAi.generateExplanation(aiCtx(c.f, await lessonTextFor(c.f, req.body?.lessonText)), {
      question: c.focus, method, variant: variant === 'first' ? 'first' : variant, previous: prev?.payload,
    });
    // Saved before it is shown: the report can say "Explanation reviewed".
    const saved = await store.insertExplanation({
      followup_id: c.f.id, student_id: c.attempt.student_id, attempt_id: c.attempt.id, question_index: c.index,
      method, variant: variant === 'first' ? 'first' : variant, skill_label: exp.skillLabel || null,
      payload: { title: exp.title, body: exp.body, example: exp.example || null, steps: exp.steps || null, table: exp.table || null, methodName: exp.methodName },
    });
    if (c.f.status === 'available') await store.updateFollowup(c.f.id, { status: 'in_progress' }).catch(() => null);
    res.json(explainView(c, saved, [...mine, saved], repeated));
  } catch (err) {
    fail(res, err);
  }
});

function explainView(c, e, all, repeated) {
  return {
    mode: 'explain',
    attemptId: c.attempt.id,
    questionIndex: c.index,
    followupId: c.f.id,
    question: { index: c.index, text: c.focus.question, yourAnswer: c.focus.studentAnswer, correctAnswer: c.focus.correctAnswer },
    explanation: { ...e.payload, method: e.method, variant: e.variant, at: e.created_at },
    skillLabel: e.skill_label || all.map((x) => x.skill_label).filter(Boolean).pop() || null,
    methodsUsed: [...new Set(all.map((x) => x.method))],
    repeated: !!repeated,
    wrongQuestions: wrongList(c.wrong),
  };
}

// ── Practise This Skill ─────────────────────────────────────────────────
router.post('/attempts/:attemptId/questions/:index/practice', requireStudentAuth, async (req, res) => {
  try {
    const c = await loadAttemptQuestion(req, res);
    if (!c) return;
    const action = req.body?.action === 'next' ? 'next' : 'start';
    let f = c.f;
    let generated = await store.listGeneratedQuestions(f.id);
    let skill = await loadSkill(f, generated);
    let responses = await store.listResponses(f.id);

    // A correct answer waiting for its explanation is finished first.
    const pending = responses.find((r) => r.credit === 'pending_clarification');
    if (pending) return res.json(practiceView(c, f, skill, responses, null));

    const current = f.current_question_id && !responses.some((r) => r.question_id === f.current_question_id) ? f.current_question_id : null;
    if (current && action === 'start' && f.current_focus_index === c.index) {
      return res.json(practiceView(c, f, skill, responses, null));
    }
    if (current) {
      // Asked for a new question (or moved to another wrong question) before
      // answering: the shown one is recorded as skipped.
      const q = skill._byId.get(current);
      const ins = await store.insertResponse({
        followup_id: f.id, student_id: f.student_id, skill_id: f.skill_id,
        question_id: current, question_type: q?.type || 'mcq', question_text: q?.question || '(question)',
        seq: responses.length + 1, answer: null, reasoning: null,
        help_shown: f.current_help === 'hint' ? 'hint' : 'none',
        grading_outcome: 'not_answered', reasoning_outcome: 'not_evaluated', credit: 'none',
        feedback: 'Skipped.', finalized_at: new Date(clock.now()).toISOString(), skipped: true,
        origin_question_index: f.current_focus_index ?? c.index, question_level: f.current_question_level || null, is_memory_check: !!f.current_is_memory_check,
      });
      if (!ins.duplicate) responses = [...responses, ins.row];
    }

    // Level and delayed memory check, from saved answers and server time.
    const all = await store.listFollowupsForStudents([f.student_id]);
    const sameSkill = new Set(all.filter((x) => x.skill_id === f.skill_id).map((x) => x.id));
    const [skillResponses, skillExplanations] = await Promise.all([
      store.listResponsesForStudents([f.student_id]).then((rs) => rs.filter((r) => r.skill_id === f.skill_id)),
      store.listExplanations({ studentId: f.student_id }).then((es) => es.filter((e) => sameSkill.has(e.followup_id))),
    ]);
    const firstIndex = (f.evidence || [])[0]?.index;
    const focusResponses = responses.filter((r) => (r.origin_question_index ?? firstIndex) === c.index);
    const decision = learning.decideServe({ skillResponses, skillExplanations, focusResponses, now: clock.now() });

    const attemptExplanations = await store.listExplanations({ attemptId: c.attempt.id });
    const lessonText = await lessonTextFor(f, req.body?.lessonText);
    const q = await pickOrGenerate({ c, f, skill, generated, responses, attemptExplanations, level: decision.level, lessonText });
    if (!q) return res.status(503).json({ code: 'no_fresh_question', error: 'I couldn’t make a new checked question right now. Please try again.' });
    if (q.generatedRows) { generated = [...generated, ...q.generatedRows]; skill = await loadSkill(f, generated); }

    const saved = await store.updateFollowup(f.id, {
      current_question_id: q.question.id, current_focus_index: c.index, current_question_level: q.question.level || decision.level,
      current_is_memory_check: decision.isMemoryCheck, current_help: 'none',
      ...(f.status === 'available' ? { status: 'in_progress' } : {}),
    }, { expectQuestionId: f.current_question_id || null });
    if (!saved) return res.status(409).json({ code: 'reload', error: 'Please try again.' });
    f = saved;
    res.json(practiceView(c, f, skill, responses, decision));
  } catch (err) {
    fail(res, err);
  }
});

// A fresh question for this wrong question: a vetted bank question or one
// already generated for it, else a newly generated and answer-checked batch.
async function pickOrGenerate({ c, f, skill, generated, responses, attemptExplanations, level, lessonText }) {
  const shown = new Set(responses.map((r) => r.question_id));
  if (f.current_question_id) shown.add(f.current_question_id);
  const ctx = session.exclusionContext(skill, c.attempt);
  // Already-shown questions and the worked examples in explanations can't come back reworded.
  for (const r of responses) ctx.originalQuestions.add(normalize(r.question_text));
  const worked = attemptExplanations.flatMap((e) => [e.payload?.example, ...(e.payload?.steps || [])]).filter(Boolean);
  ctx.workedBlob = `${ctx.workedBlob} | ${normalize(worked.join(' | '))}`;
  const fresh = (q) => !shown.has(q.id) && session.isFresh(q, ctx) && !worked.some((w) => session.overlap(w, q.question) >= 0.6);

  const bank = (skill.questions || []).filter((q) => !String(q.id).startsWith('gq-') && !String(q.id).startsWith('tq-') && fresh(q));
  const mineGen = generated.filter((r) => r.origin_question_index === c.index)
    .map((r) => ({ ...r.payload, id: r.question_id, level: r.level }))
    .filter(fresh)
    .sort((a, b) => Math.abs((a.level || 2) - level) - Math.abs((b.level || 2) - level));
  if (mineGen.length && (mineGen[0].level || 2) === level) return { question: mineGen[0] };
  if (bank.length) return { question: { ...bank[0], level: bank[0].level || 2 } };

  try {
    const avoid = [...c.attempt.per_question_results.filter(Boolean).map((q) => q.question), ...responses.map((r) => r.question_text), ...generated.map((g) => g.payload?.question)].filter(Boolean);
    const out = await questionAi.generateQuestions(aiCtx(f, lessonText), { focus: c.focus, level, avoid, workedExamples: worked });
    const existing = generated.map((g) => g.payload?.question).filter(Boolean);
    const rows = out.questions
      .filter((q) => fresh({ ...q, id: '' }) && !existing.some((e) => session.overlap(e, q.question) >= 0.7))
      .map((q) => {
        const id = `gq-${Math.random().toString(36).slice(2, 10)}`;
        return { followup_id: f.id, question_id: id, origin_question_index: c.index, level, payload: { ...q, id, skillLabel: out.skillLabel }, fingerprint: normalize(q.question).slice(0, 300) };
      });
    const inserted = await store.insertGeneratedQuestions(rows);
    if (inserted.length) return { question: { ...inserted[0].payload, id: inserted[0].question_id, level }, generatedRows: inserted };
  } catch (err) {
    if (!(err instanceof topicSkill.GenerationError)) throw err;
  }
  // Model unavailable or nothing passed the checks: an earlier fresh one at any level.
  if (mineGen.length) return { question: mineGen[0] };
  return null;
}

function practiceView(c, f, skill, responses, decision) {
  const pending = responses.find((r) => r.credit === 'pending_clarification');
  const pendingQ = pending ? skill._byId.get(pending.question_id) : null;
  const q = !pending && f.current_question_id ? skill._byId.get(f.current_question_id) : null;
  const memory = q ? !!f.current_is_memory_check : false;
  return {
    mode: 'practice',
    attemptId: c.attempt.id,
    questionIndex: c.index,
    followupId: f.id,
    skillLabel: q?.skillLabel || null,
    question: q ? {
      ...session.publicQuestion(q),
      level: f.current_question_level || q.level || 2,
      levelName: learning.LEVEL_NAME[f.current_question_level || q.level || 2],
      isMemoryCheck: memory,
      helpShown: f.current_help,
      hint: f.current_help === 'hint' ? q.hint : null,
    } : null,
    clarification: pendingQ ? { questionId: pendingQ.id, question: session.publicQuestion(pendingQ), yourAnswer: pending.answer, prompt: session.MESSAGES.clarify } : null,
    memoryCheck: memory ? { daysSince: decision?.daysSince ?? null } : null,
    wrongQuestions: wrongList(c.wrong),
  };
}

// ── What you worked on (per wrong question of one test) ─────────────────
router.get('/attempts/:attemptId/worked-on', requireStudentAuth, async (req, res) => {
  try {
    const { attemptId } = req.params;
    if (!UUID.test(attemptId)) return res.status(404).json({ error: 'Not found' });
    const attempt = await store.getAttempt(attemptId);
    if (!attempt || attempt.student_id !== req.auth.studentId) return res.status(404).json({ error: 'Not found' });
    res.json({ attemptId, questions: await workedOnForAttempt(attempt) });
  } catch (err) {
    fail(res, err);
  }
});

async function workedOnForAttempt(attempt) {
  const followups = await store.listFollowupsForAttempt(attempt.id);
  const [responses, explanations, generated] = await Promise.all([
    store.listResponses(followups.map((f) => f.id)),
    store.listExplanations({ attemptId: attempt.id }),
    Promise.all(followups.map((f) => store.listGeneratedQuestions(f.id))).then((x) => x.flat()),
  ]);
  return learning.wrongQuestionsOf(attempt).map((w) => {
    const f = learning.followupForIndex(followups, w.index);
    const firstIndex = (f?.evidence || [])[0]?.index;
    const rs = f ? responses.filter((r) => r.followup_id === f.id && (r.origin_question_index ?? firstIndex) === w.index) : [];
    const label = generated.find((g) => g.origin_question_index === w.index && g.payload?.skillLabel)?.payload.skillLabel
      || (f && !topicSkill.isTopicSkillId(f.skill_id) ? topicSkill.displayNames(f).shortName : null);
    return { index: w.index, question: w.question, ...learning.workedOn({ explanations: explanations.filter((e) => e.question_index === w.index), responses: rs, skillLabel: label }) };
  });
}

// ── Parent / teacher learning report ────────────────────────────────────
router.get('/report/students/:studentId', requireParentOrTeacherAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    const allowed = UUID.test(studentId) && (req.auth.role === 'parent'
      ? await store.isParentOf(req.auth.email, studentId)
      : (await store.teacherStudentIds(req.auth.teacherId)).includes(studentId));
    if (!allowed) return res.status(403).json({ error: 'Not authorised.' });
    const [student, attempts, followups, responses, explanations] = await Promise.all([
      store.getStudentBasic(studentId),
      store.listStudentAttempts(studentId),
      store.listFollowupsForStudents([studentId]),
      store.listResponsesForStudents([studentId]),
      store.listExplanations({ studentId }),
    ]);
    // Saved results only: no tutoring chat, reasoning text or answer keys.
    res.json(learning.studentLearningReport({
      student: student ? { id: student.id, name: student.name, grade: student.grade, curriculum: student.curriculum } : { id: studentId },
      attempts, followups, responses, explanations, names: topicSkill.displayNames,
    }));
  } catch (err) {
    console.error('[practice-question] report failed:', err.message);
    res.status(500).json({ error: 'Could not build the report.' });
  }
});

module.exports = router;
module.exports._test = { clock, workedOnForAttempt };
