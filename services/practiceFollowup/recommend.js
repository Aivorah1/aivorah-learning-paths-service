// Which skills a finished practice test should recommend follow-up practice
// for. Pure: reads one topic_attempts row, returns one item per skill.
//
// A question is evidence when, in the original test, the student:
//   - answered it incorrectly after the allowed attempts       -> 'incorrect'
//   - got it right on a second try, or after a hint was shown   -> 'second_try'
//   - got it right first time, but the reasoning they typed
//     matches one of the skill's known misconceptions          -> 'reasoning_misconception'
// The spoken (voice) question is never evidence: it is graded separately and
// an unclear or missing voice answer says nothing reliable about a skill.
// Questions without a reliable skill mapping are left out (no invented
// recommendation); the original report stays as it is.
const catalog = require('./catalog');
const { isAlliterative, fractionAddedSame } = require('./text');

function misconceptionRuleFor(skill, concept, reasoning) {
  const text = String(reasoning || '').trim();
  if (!text) return null;
  for (const rule of skill.rubric?.misconceptionRules || []) {
    if (rule.whenConcept && rule.whenConcept !== concept) continue;
    if (!new RegExp(rule.reasoningMatches, 'i').test(text)) continue;
    if (rule.unlessMatches && new RegExp(rule.unlessMatches, 'i').test(text)) continue;
    return rule;
  }
  return null;
}

function classify(q) {
  const attempts = Number(q.attempts) || 1;
  if (!q.isCorrect) return 'incorrect';
  if (attempts >= 2 || q.hintShown === true) return 'second_try';
  return 'first_try';
}

function confusionFor(skill, ev) {
  const concept = catalog.conceptOf(skill, ev.question);
  const wrong = ev.kind === 'incorrect' ? ev.studentAnswer : ev.firstAnswer;
  if (!wrong) return null;
  for (const c of skill.teaching?.confusions || []) {
    if (c.whenQuestionConcept && c.whenQuestionConcept !== concept) continue;
    const hit = c.whenStudentAnswer === 'alliterative' ? isAlliterative(wrong)
      : c.whenStudentAnswer === 'not_alliterative' ? !isAlliterative(wrong)
      : c.whenStudentAnswer === 'fraction_added_same' ? fractionAddedSame(ev.question, wrong)
      : false;
    if (hit) return c.id;
  }
  return null;
}

function recommendForAttempt(attempt) {
  const results = Array.isArray(attempt?.per_question_results) ? attempt.per_question_results : [];
  const scope = { subject: attempt?.subject, grade: attempt?.grade };
  const bySkill = new Map();
  let unmapped = 0;

  results.forEach((q, index) => {
    if (!q || typeof q !== 'object' || q.type === 'spoken') return;
    const skill = catalog.skillForQuestion(scope, q.question, q.correctAnswer);
    const kind0 = classify(q);
    let kind = kind0;
    if (kind0 === 'first_try') {
      if (!skill) return;
      const rule = misconceptionRuleFor(skill, catalog.conceptOf(skill, q.question), q.reasoning);
      if (!rule) return;
      kind = 'reasoning_misconception';
    }
    if (!skill) { unmapped += 1; return; }
    const ev = {
      index,
      kind,
      question: String(q.question || '').slice(0, 500),
      studentAnswer: String(q.studentAnswer ?? '').slice(0, 300),
      firstAnswer: q.firstAnswer != null ? String(q.firstAnswer).slice(0, 300) : null,
      correctAnswer: String(q.correctAnswer ?? '').slice(0, 300),
      at: attempt.created_at || null,
    };
    ev.confusion = confusionFor(skill, ev);
    if (!bySkill.has(skill.id)) bySkill.set(skill.id, { skill, evidence: [] });
    bySkill.get(skill.id).evidence.push(ev);
  });

  const recommendations = [...bySkill.values()].map(({ skill, evidence }) => ({
    skillId: skill.id,
    label: skill.label,
    shortName: skill.shortName,
    evidence,
  }));
  return { recommendations, unmapped };
}

module.exports = { recommendForAttempt, misconceptionRuleFor, classify };
