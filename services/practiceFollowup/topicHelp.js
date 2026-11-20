// Teacher "Needs topic help": a student needs help with a skill when the
// difficulty is backed by at least two DISTINCT questions for that skill and
// is still unresolved. Pure; reads saved follow-up rows only.
//
// Evidence, per student + skill:
//   - each original test question recommended for follow-up (wrong, right on
//     a second try / after a hint, or a known misconception). A wrong answer
//     and its retry are the same question, so they count once.
//   - each follow-up question answered incorrectly, or correctly with a
//     misconception in the reasoning.
// Resolved: the student met the independent follow-up rule (two in a row)
// for that skill after the latest evidence. New evidence later raises it again.
const { displayNames } = require('./topicSkill');

const MIN_DISTINCT_QUESTIONS = 2;

function ms(t) {
  const n = t ? new Date(t).getTime() : NaN;
  return Number.isNaN(n) ? 0 : n;
}

function computeTopicHelp(followups, responses) {
  const groups = new Map(); // `${student}|${skill}` -> { items: Map(key -> time), resolvedAt, meta }
  const group = (studentId, skillId) => {
    const k = `${studentId}|${skillId}`;
    if (!groups.has(k)) groups.set(k, { studentId, skillId, items: new Map(), resolvedAt: 0, topics: new Map() });
    return groups.get(k);
  };

  for (const f of followups || []) {
    const g = group(f.student_id, f.skill_id);
    for (const e of Array.isArray(f.evidence) ? f.evidence : []) {
      const key = `orig:${f.attempt_id}:${e.index}`;
      g.items.set(key, Math.max(g.items.get(key) || 0, ms(e.at || f.created_at)));
    }
    if (!g.names || f.skill_pack) g.names = displayNames(f);
    const at = ms(f.created_at);
    const prev = g.topics.get(f.topic);
    if (!prev || at > prev.at) g.topics.set(f.topic, { topic: f.topic, subject: f.subject, at });
    if (f.status === 'completed') g.resolvedAt = Math.max(g.resolvedAt, ms(f.completed_at));
  }

  for (const r of responses || []) {
    const failed = r.grading_outcome === 'incorrect' || (r.grading_outcome === 'correct' && r.reasoning_outcome === 'misconception');
    if (!failed) continue;
    const g = group(r.student_id, r.skill_id);
    const key = `fu:${r.question_id}`;
    g.items.set(key, Math.max(g.items.get(key) || 0, ms(r.finalized_at || r.created_at)));
  }

  const byStudent = new Map();
  for (const g of groups.values()) {
    const open = [...g.items.values()].filter((t) => t > g.resolvedAt);
    if (open.length < MIN_DISTINCT_QUESTIONS) continue;
    const names = g.names || displayNames({ skill_id: g.skillId });
    const latestTopic = [...g.topics.values()].sort((a, b) => b.at - a.at)[0] || {};
    const item = {
      skillId: g.skillId,
      label: names.label || g.skillId,
      shortName: names.shortName || g.skillId,
      nextPractice: names.nextPractice || null,
      topic: latestTopic.topic || null,
      subject: latestTopic.subject || null,
      evidenceCount: open.length,
      lastEvidenceAt: new Date(Math.max(...open)).toISOString(),
    };
    if (!byStudent.has(g.studentId)) byStudent.set(g.studentId, []);
    byStudent.get(g.studentId).push(item);
  }
  return byStudent; // studentId -> [{ skillId, label, ... }]
}

module.exports = { computeTopicHelp, MIN_DISTINCT_QUESTIONS };
