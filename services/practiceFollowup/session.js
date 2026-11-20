// The Practise This Skill session rules, as pure functions over the saved
// rows. The routes load rows, call these, and persist the result BEFORE
// showing it. Saved responses are the source of truth: progress (streak,
// completion) is always re-derived from them, so a failed or repeated write
// can never double-count or skip a step.
const catalog = require('./catalog');
const { normalize } = require('./text');

const NEEDED_IN_A_ROW = 2;

const MESSAGES = {
  independent: 'Correct — you got it right on your own.',
  assisted: 'Correct — you got it with a hint.',
  clarify: 'Correct! Now tell me a little more: why is that the answer? Use your own words.',
  clarifyUnclear: "That's the right answer, but I still can't tell why it's right from your explanation, so this one doesn't count yet. Let's try a new question — tell me your thinking in your own words.",
  incorrectLead: 'Good try! ',
  incorrectNext: " Let's try a different question.",
  solution: "Here's how this one works. You'll get a different question next.",
  completeTitle: 'Practice complete',
  completeBody: 'You answered two new questions correctly on your own and explained your thinking.',
  unavailable: "I don't have another new question for this skill right now, so this check isn't finished yet. You can come back later or go back to Learn.",
  evaluationUnavailable: "I couldn't check your explanation just now. Nothing has been saved yet — please try again.",
};

// ── Progress ────────────────────────────────────────────────────────────
// Two consecutive correct, independent answers with sound reasoning complete
// the skill. A finalized incorrect / assisted / no-credit answer breaks the
// streak; a pending clarification neither counts nor breaks it.
function deriveProgress(responses) {
  const sorted = [...(responses || [])].sort((a, b) => a.seq - b.seq);
  let streak = 0;
  let independent = 0;
  let completedAt = null;
  let pending = null;
  for (const r of sorted) {
    if (r.credit === 'pending_clarification') { pending = r; continue; }
    if (r.credit === 'independent') {
      streak += 1; independent += 1;
      if (streak >= NEEDED_IN_A_ROW && !completedAt) completedAt = r.finalized_at || r.created_at || new Date().toISOString();
    } else {
      streak = 0;
    }
  }
  const finalized = sorted.filter((r) => r.credit !== 'pending_clarification');
  return {
    streak: completedAt ? NEEDED_IN_A_ROW : streak,
    independent,
    completed: !!completedAt,
    completedAt,
    pending,
    last: finalized[finalized.length - 1] || null,
    answeredIds: new Set(sorted.map((r) => r.question_id)),
    lastTwoIncorrect: finalized.length >= 2 && finalized.slice(-2).every((r) => r.grading_outcome === 'incorrect'),
  };
}

// ── Teaching ────────────────────────────────────────────────────────────
function initialMethod(skill, followup) {
  const evidence = Array.isArray(followup.evidence) ? followup.evidence : [];
  const onlySecondTry = evidence.length > 0 && evidence.every((e) => e.kind === 'second_try');
  if (onlySecondTry && skill.teaching?.refresher) return 'refresher';
  return skill.teaching.methods[0].id;
}

// The next teaching method not yet shown (a refresh never repeats one). Once
// every method has been shown, starts again from the least recently used.
function nextMethod(skill, used) {
  const ids = skill.teaching.methods.map((m) => m.id);
  const seen = new Set(used || []);
  const fresh = ids.find((id) => !seen.has(id));
  if (fresh) return { id: fresh, repeated: false };
  const order = (used || []).filter((id) => ids.includes(id));
  return { id: order[0] || ids[0], repeated: true };
}

function teachingView(skill, methodId, followup) {
  const t = skill.teaching;
  const m = methodId === 'refresher' ? { id: 'refresher', name: 'Quick refresher', ...t.refresher } : t.methods.find((x) => x.id === methodId) || t.methods[0];
  // The confusion behind a wrong answer explains more than one behind a retry.
  const evidence = [...(followup?.evidence || [])].sort((a, b) => (a.kind === 'incorrect' ? 0 : 1) - (b.kind === 'incorrect' ? 0 : 1));
  const confusionId = evidence.map((e) => e.confusion).find(Boolean);
  const confusion = confusionId ? (t.confusions || []).find((c) => c.id === confusionId) : null;
  return {
    methodId: m.id,
    methodName: m.name || m.title,
    title: m.title,
    body: m.body,
    examples: m.examples || [],
    table: m.table || null,
    steps: m.steps || null,
    confusion: confusion ? confusion.text : null,
  };
}

// ── Fresh questions ─────────────────────────────────────────────────────
// Everything a fresh question must not repeat: every question in the
// original test (right or wrong), and the skill's worked examples.
function exclusionContext(skill, attempt) {
  const original = (attempt?.per_question_results || [])
    .filter((q) => q && typeof q === 'object')
    .map((q) => [q.question, q.correctAnswer, q.studentAnswer, q.firstAnswer, ...(Array.isArray(q.options) ? q.options : [])].filter(Boolean).join(' '));
  const teaching = skill.teaching;
  const shown = [
    JSON.stringify(teaching.refresher || {}),
    ...teaching.methods.map((m) => JSON.stringify(m)),
  ];
  return {
    // Original question + its correct answer, to catch the same fact asked again in other words.
    originalPairs: (attempt?.per_question_results || []).filter((q) => q && q.correctAnswer)
      .map((q) => ({ question: q.question, answer: normalize(q.correctAnswer) })),
    originalQuestions: new Set((attempt?.per_question_results || []).filter(Boolean).map((q) => normalize(q.question))),
    originalBlob: normalize(original.join(' | ')),
    workedBlob: normalize(shown.join(' | ')),
  };
}

const tokens = (t) => new Set(normalize(t).split(' ').filter((w) => w.length > 2));
// Share of words two questions have in common (0-1).
function overlap(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

function isFresh(q, ctx) {
  if (ctx.originalQuestions.has(normalize(q.question))) return false;
  // A reworded copy of an original test question isn't a new example either.
  for (const o of ctx.originalQuestions) if (overlap(o, q.question) >= 0.7) return false;
  // Same answer as an original question and similar wording: the same check again.
  const answer = normalize(q.type === 'mcq' ? q.options?.[q.answer] : q.answers?.[0]);
  for (const o of ctx.originalPairs || []) {
    if (answer && o.answer && (answer === o.answer || answer.includes(o.answer) || o.answer.includes(answer)) && overlap(o.question, q.question) >= 0.3) return false;
  }
  for (const ex of q.examples || []) {
    const e = normalize(ex);
    if (!e) continue;
    if (ctx.originalBlob.includes(e) || ctx.workedBlob.includes(e)) return false;
  }
  return true;
}

// Next fresh question: never one already used in this follow-up; prefers a
// different type from the last one (MCQ, then fill in the blank) and ones the
// student hasn't seen in other follow-ups for this skill.
function pickNextQuestion(skill, ctx, { usedIds = new Set(), lastType = null, seenElsewhere = new Set() } = {}) {
  const candidates = skill.questions.filter((q) => !usedIds.has(q.id) && isFresh(q, ctx));
  if (!candidates.length) return null;
  const score = (q) => (seenElsewhere.has(q.id) ? 2 : 0) + (lastType && q.type === lastType ? 1 : 0);
  return [...candidates].sort((a, b) => score(a) - score(b))[0];
}

// ── Outcomes (History, Parent) ──────────────────────────────────────────
function outcomeOf(followup, responses) {
  const p = deriveProgress(responses);
  if (followup.status === 'completed' || p.completed) {
    return {
      code: 'completed',
      label: 'Practice complete',
      text: 'Answered two new questions correctly on their own and explained both answers.',
      parentText: 'Later answered two new questions independently and explained both answers.',
      confirmed: NEEDED_IN_A_ROW,
    };
  }
  if (!responses?.length) {
    return followup.status === 'in_progress'
      ? { code: 'in_progress', label: 'In progress', text: 'Practice started — no answers saved yet.', parentText: 'Started follow-up practice.', confirmed: 0 }
      : { code: 'available', label: 'Recommended', text: 'Follow-up practice is ready.', parentText: 'Follow-up practice recommended; not started yet.', confirmed: 0 };
  }
  if (p.pending && (!p.last || p.pending.seq > p.last.seq)) {
    return { code: 'needs_explanation', label: 'Correct — explanation needed', text: 'Answered correctly; waiting for a short explanation.', parentText: 'Answered a new question correctly and is explaining why.', confirmed: p.streak };
  }
  if (p.streak >= 1) {
    return { code: 'confirmed_partial', label: `${p.streak} of ${NEEDED_IN_A_ROW} independent questions confirmed`, text: `${p.streak} of ${NEEDED_IN_A_ROW} independent questions confirmed.`, parentText: `Has answered ${p.streak} new question correctly on their own and explained it; one more to go.`, confirmed: p.streak };
  }
  const last = p.last;
  if (last?.credit === 'assisted') {
    return { code: 'assisted', label: 'Correct with a hint', text: 'Correct with a hint. An independent check is next.', parentText: 'Answered a new question correctly with a hint; still practising.', confirmed: 0 };
  }
  if (last?.help_shown === 'solution') {
    return { code: 'reviewed_solution', label: 'Reviewed a worked solution', text: 'Reviewed a worked solution. A new question is next.', parentText: 'Reviewed a worked solution; still practising.', confirmed: 0 };
  }
  if (last?.grading_outcome === 'correct') {
    return { code: 'reasoning_to_work_on', label: 'Correct — reasoning to work on', text: 'Answered correctly; the explanation needs more work.', parentText: 'Answered correctly but is still working on explaining why.', confirmed: 0 };
  }
  return { code: 'keep_practising', label: 'Keep practising', text: 'Not yet — keep practising with a new question.', parentText: 'Still practising this skill.', confirmed: 0 };
}

module.exports = {
  NEEDED_IN_A_ROW, MESSAGES,
  deriveProgress, initialMethod, nextMethod, teachingView,
  exclusionContext, isFresh, pickNextQuestion, outcomeOf, overlap,
  publicQuestion: catalog.publicQuestion,
};
