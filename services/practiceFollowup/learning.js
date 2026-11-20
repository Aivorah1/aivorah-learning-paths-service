// Pure rules for "Explain This Question" / "Practise This Skill" built on the
// saved rows only — never on model text:
//   wrongQuestionsOf        the report's wrong questions (the voice question excluded)
//   decideServe             level + whether the next question is a delayed
//                           memory check (7+ days since the last activity on the skill)
//   outcomeOf               one saved answer -> independent | assisted | incorrect |
//                           skipped | awaiting_verification | solution_shown
//   workedOn                "What you worked on" facts + plain lines for one wrong question
//   recurringMistakes       a mistake step counts as recurring only across 2+ distinct questions
//   studentLearningReport   parent / teacher download data
const DAY_MS = 86400000;
const MEMORY_CHECK_DAYS = 7;
const DEFAULT_LEVEL = 2;

function wrongQuestionsOf(attempt) {
  return (Array.isArray(attempt?.per_question_results) ? attempt.per_question_results : [])
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => q && typeof q === 'object' && q.type !== 'spoken' && !q.isCorrect)
    .map(({ q, index }) => ({
      index,
      question: String(q.question || ''),
      studentAnswer: String(q.studentAnswer ?? ''),
      correctAnswer: String(q.correctAnswer ?? ''),
      reasoning: typeof q.reasoning === 'string' ? q.reasoning : '',
    }));
}

// The follow-up whose evidence includes this question of the test.
function followupForIndex(followups, index) {
  return (followups || []).find((f) => (f.evidence || []).some((e) => e.index === index)) || null;
}

const ms = (t) => { const n = t ? new Date(t).getTime() : NaN; return Number.isNaN(n) ? 0 : n; };
const clampLevel = (n) => Math.max(1, Math.min(3, n));

function outcomeOf(r) {
  if (r.skipped) return 'skipped';
  if (r.credit === 'pending_clarification') return 'awaiting_verification';
  if (r.help_shown === 'solution') return 'solution_shown';
  if (r.credit === 'independent') return 'independent';
  if (r.credit === 'assisted') return 'assisted';
  if (r.grading_outcome === 'incorrect') return 'incorrect';
  return 'correct_unverified';
}

// skillResponses / skillExplanations: everything this student did on this
// skill (any test). focusResponses: answers for this wrong question only.
function decideServe({ skillResponses = [], skillExplanations = [], focusResponses = [], now = Date.now() }) {
  const times = [...skillResponses.map((r) => ms(r.finalized_at || r.created_at)), ...skillExplanations.map((e) => ms(e.created_at))].filter(Boolean);
  const last = times.length ? Math.max(...times) : 0;
  if (last && now - last >= MEMORY_CHECK_DAYS * DAY_MS) {
    // Start from the level the student showed on their own before; basic when unsure.
    const shown = skillResponses.filter((r) => outcomeOf(r) === 'independent' && r.question_level).map((r) => r.question_level);
    return { isMemoryCheck: true, level: shown.length ? Math.max(...shown) : 1, daysSince: Math.floor((now - last) / DAY_MS) };
  }
  const answered = focusResponses.filter((r) => !r.skipped && r.credit !== 'pending_clarification').sort((a, b) => a.seq - b.seq);
  const prev = answered[answered.length - 1];
  if (!prev) return { isMemoryCheck: false, level: DEFAULT_LEVEL };
  const lvl = prev.question_level || DEFAULT_LEVEL;
  const o = outcomeOf(prev);
  return { isMemoryCheck: false, level: clampLevel(o === 'independent' ? lvl + 1 : (o === 'incorrect' || o === 'solution_shown') ? lvl - 1 : lvl) };
}

const tagKey = (t) => String(t || '').trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ');

function recurringMistakes(responses) {
  const byTag = new Map();
  for (const r of responses || []) {
    const k = tagKey(r.mistake_tag);
    if (!k) continue;
    if (!byTag.has(k)) byTag.set(k, { step: r.mistake_tag, questions: new Set() });
    byTag.get(k).questions.add(r.question_id);
  }
  return [...byTag.values()].filter((x) => x.questions.size >= 2).map((x) => ({ step: x.step, questions: x.questions.size }));
}

const LEVEL_NAME = { 1: 'basic', 2: 'standard', 3: 'challenge' };
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

function countsOf(responses) {
  const c = { independent: 0, assisted: 0, incorrect: 0, skipped: 0, awaiting_verification: 0, solution_shown: 0, correct_unverified: 0 };
  for (const r of responses) c[outcomeOf(r)] += 1;
  return c;
}

// Facts for one wrong question of one test, and plain lines built from them.
function workedOn({ explanations = [], responses = [], skillLabel = null }) {
  const exps = [...explanations].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const practice = responses.filter((r) => !r.is_memory_check);
  const checks = responses.filter((r) => r.is_memory_check).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const counts = countsOf(practice);
  const label = exps.map((e) => e.skill_label).filter(Boolean).pop() || skillLabel || null;
  const lines = [];
  if (exps.length) {
    const methods = new Set(exps.map((e) => e.method)).size;
    lines.push(`Ask Aivorah explained “${exps[exps.length - 1].payload?.title || label || 'this question'}”${methods > 1 ? ` in ${methods} different ways` : ''}. Explanation reviewed.`);
  }
  const tried = practice.length;
  if (tried) {
    const parts = [
      counts.independent && `${counts.independent} on your own`,
      counts.assisted && `${counts.assisted} with a hint`,
      counts.incorrect && `${counts.incorrect} not right yet`,
      counts.solution_shown && `${counts.solution_shown} with the solution shown`,
      counts.skipped && `${counts.skipped} skipped`,
      counts.awaiting_verification && `${counts.awaiting_verification} waiting for your explanation`,
    ].filter(Boolean);
    lines.push(`Practised ${tried} fresh question${tried === 1 ? '' : 's'}: ${parts.join(', ') || 'answered'}.`);
  }
  const rec = recurringMistakes(responses);
  if (rec.length) lines.push(`Still needs practice: ${rec.map((x) => `${x.step} (in ${x.questions} questions)`).join('; ')}.`);
  else {
    const lastTag = [...responses].reverse().find((r) => r.mistake_tag);
    if (lastTag) lines.push(`Last mistake to work on: ${lastTag.mistake_tag}.`);
  }
  for (const c of checks) {
    const o = outcomeOf(c);
    const what = o === 'independent' ? 'remembered it and answered on their own'
      : o === 'assisted' ? 'answered with a hint'
      : o === 'awaiting_verification' ? 'answered; explanation still being checked'
      : o === 'skipped' ? 'skipped the question'
      : 'needed more practice';
    lines.push(`Memory check on ${fmtDate(c.created_at)} (${LEVEL_NAME[c.question_level] || 'basic'} question): ${what}.`);
  }
  return {
    skillLabel: label,
    explanations: exps.map((e) => ({ method: e.method, variant: e.variant, title: e.payload?.title || null, at: e.created_at })),
    practice: { total: tried, ...counts },
    recurringMistakes: rec,
    memoryChecks: checks.map((c) => ({ at: c.created_at, level: c.question_level || null, outcome: outcomeOf(c), helpUsed: c.help_shown })),
    lines,
    hasActivity: exps.length > 0 || responses.length > 0,
  };
}

// The download for a linked parent or an authorised teacher: every test
// (score kept as taken) with the follow-up results from saved rows only.
function studentLearningReport({ student, attempts = [], followups = [], responses = [], explanations = [], names = () => ({}) }) {
  const tests = attempts
    .filter((a) => a && (a.total_questions || (a.per_question_results || []).length))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))
    .map((a) => {
      const fus = followups.filter((f) => f.attempt_id === a.id);
      const fuIds = new Set(fus.map((f) => f.id));
      const rs = responses.filter((r) => fuIds.has(r.followup_id));
      const ex = explanations.filter((e) => e.attempt_id === a.id);
      const practice = rs.filter((r) => !r.is_memory_check);
      const skills = [...new Set([...ex.map((e) => e.skill_label).filter(Boolean), ...fus.map((f) => names(f).shortName).filter(Boolean)])];
      return {
        attemptId: a.id,
        subject: a.subject || '',
        topic: a.topic || '',
        takenAt: a.created_at,
        score: a.score != null ? Number(a.score) : null,
        correct: a.correct_answers ?? null,
        total: a.total_questions ?? null,
        skillsReviewed: skills,
        explanationsShown: ex.length,
        practice: { total: practice.length, ...countsOf(practice) },
        recurringMistakes: recurringMistakes(rs),
        memoryChecks: rs.filter((r) => r.is_memory_check).map((r) => ({ at: r.created_at, level: r.question_level || null, outcome: outcomeOf(r), helpUsed: r.help_shown })),
        hasFollowUp: ex.length > 0 || rs.length > 0,
      };
    });
  return { student, generatedAt: new Date().toISOString(), tests };
}

module.exports = {
  DAY_MS, MEMORY_CHECK_DAYS, DEFAULT_LEVEL, LEVEL_NAME,
  wrongQuestionsOf, followupForIndex, decideServe, outcomeOf, recurringMistakes, workedOn, studentLearningReport,
};
