// Database access for Practise This Skill (tables from aivorah-db
// 0030_practice_followups.sql). Every function throws on a database error so
// the route can show a retry instead of a result that was never saved.
const supabase = require('../supabase');

const FOLLOWUP_COLS = 'id, student_id, attempt_id, skill_id, topic, topic_id, subject, grade, curriculum, original_score, evidence, evidence_question_count, status, teaching_methods_used, current_method, current_question_id, current_help, independent_streak, completed_at, created_at, updated_at, skill_pack, current_focus_index, current_question_level, current_is_memory_check';
const RESPONSE_COLS = 'id, followup_id, student_id, skill_id, question_id, question_type, question_text, seq, answer, reasoning, clarification, help_shown, grading_outcome, reasoning_outcome, credit, feedback, created_at, finalized_at, origin_question_index, question_level, is_memory_check, skipped, mistake_tag';

class StoreError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (error) => { throw new StoreError(error.message || 'database error', error.code); };
const isUniqueViolation = (error) => error && (error.code === '23505' || /duplicate key/i.test(error.message || ''));

async function getAttempt(id) {
  const { data, error } = await supabase
    .from('topic_attempts')
    .select('id, student_id, topic, subject, grade, curriculum, score, attempt_number, per_question_results, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) fail(error);
  return data;
}

async function listFollowupsForAttempt(attemptId) {
  const { data, error } = await supabase.from('practice_followups').select(FOLLOWUP_COLS).eq('attempt_id', attemptId).order('created_at', { ascending: true });
  if (error) fail(error);
  return data || [];
}

// Creates the follow-ups a report recommends. Re-opening the report (or two
// tabs at once) never creates a second row: (attempt_id, skill_id) is unique.
async function createFollowups(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('practice_followups').upsert(rows, { onConflict: 'attempt_id,skill_id', ignoreDuplicates: true });
  if (error) fail(error);
}

async function getFollowup(id) {
  const { data, error } = await supabase.from('practice_followups').select(FOLLOWUP_COLS).eq('id', id).maybeSingle();
  if (error) {
    if (/invalid input syntax for type uuid/i.test(error.message || '')) return null;
    fail(error);
  }
  return data;
}

// Compare-and-set update: only applies while the follow-up is still on the
// expected question. Returns the updated row, or null if something else
// already moved it on (the caller reloads instead of advancing twice).
async function updateFollowup(id, patch, { expectQuestionId } = {}) {
  let q = supabase.from('practice_followups').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (expectQuestionId !== undefined) q = expectQuestionId === null ? q.is('current_question_id', null) : q.eq('current_question_id', expectQuestionId);
  const { data, error } = await q.select(FOLLOWUP_COLS);
  if (error) fail(error);
  return (data && data[0]) || null;
}

// Saves a generated topic pack once: a second, concurrent generation keeps
// the first one (null when another request already saved one).
async function saveSkillPack(id, pack) {
  const { data, error } = await supabase.from('practice_followups')
    .update({ skill_pack: pack, updated_at: new Date().toISOString() })
    .eq('id', id).is('skill_pack', null).select(FOLLOWUP_COLS);
  if (error) fail(error);
  return (data && data[0]) || null;
}

// The lesson text stored for a topic (teacher-published / curated resources).
async function getTopicLessonText(topicId) {
  if (!topicId) return '';
  const { data, error } = await supabase.from('topic_resources').select('static_payload')
    .eq('topic_id', topicId).eq('resource_type', 'AI_EXPLANATION').maybeSingle();
  if (error || !data) return '';
  const p = data.static_payload || {};
  const rt = p.readText || {};
  const body = (x) => (Array.isArray(x) ? x.map((b) => (typeof b === 'string' ? b : b?.text || b?.content || '')).join(' ') : '');
  return [rt.intro || p.intro || (typeof p.text === 'string' ? p.text : ''), body(rt.body || p.body), body(p.whatYoullLearn)].filter(Boolean).join(' ').trim();
}

// The student's latest practice tests for one topic (newest first).
async function listStudentTopicAttempts(studentId, topic, subject) {
  let q = supabase.from('topic_attempts')
    .select('id, student_id, topic, subject, grade, curriculum, score, attempt_number, per_question_results, created_at')
    .eq('student_id', studentId).eq('topic', topic).order('created_at', { ascending: false }).limit(5);
  if (subject) q = q.eq('subject', subject);
  const { data, error } = await q;
  if (error) fail(error);
  return data || [];
}

// ── Explain This Question / Practise This Skill ─────────────────────────
const EXPLANATION_COLS = 'id, followup_id, student_id, attempt_id, question_index, method, variant, skill_label, payload, created_at';
const GENERATED_COLS = 'id, followup_id, question_id, origin_question_index, level, payload, fingerprint, created_at';

async function insertExplanation(row) {
  const { data, error } = await supabase.from('practice_explanations').insert(row).select(EXPLANATION_COLS).single();
  if (error) fail(error);
  return data;
}

async function listExplanations({ attemptId, studentId, followupIds } = {}) {
  let q = supabase.from('practice_explanations').select(EXPLANATION_COLS);
  if (attemptId) q = q.eq('attempt_id', attemptId);
  if (studentId) q = q.eq('student_id', studentId);
  if (followupIds) { if (!followupIds.length) return []; q = q.in('followup_id', followupIds); }
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) fail(error);
  return data || [];
}

async function listGeneratedQuestions(followupId) {
  const { data, error } = await supabase.from('practice_generated_questions').select(GENERATED_COLS).eq('followup_id', followupId).order('created_at', { ascending: true });
  if (error) fail(error);
  return data || [];
}

// Saves fresh questions; a repeat (same id or same text) is skipped, not an error.
async function insertGeneratedQuestions(rows) {
  const saved = [];
  for (const row of rows) {
    const { data, error } = await supabase.from('practice_generated_questions').insert(row).select(GENERATED_COLS).single();
    if (error) { if (isUniqueViolation(error)) continue; fail(error); }
    saved.push(data);
  }
  return saved;
}

// Updates one saved answer once (e.g. adds the diagnosed mistake step).
async function updateResponseWhere(id, patch, { mistakeTagIsNull = false } = {}) {
  let q = supabase.from('practice_followup_responses').update(patch).eq('id', id);
  if (mistakeTagIsNull) q = q.is('mistake_tag', null);
  const { data, error } = await q.select(RESPONSE_COLS);
  if (error) fail(error);
  return (data && data[0]) || null;
}

async function getStudentBasic(id) {
  const { data, error } = await supabase.from('users').select('id, name, grade, curriculum').eq('id', id).maybeSingle();
  if (error) fail(error);
  return data;
}

async function listStudentAttempts(studentId, limit = 30) {
  const { data, error } = await supabase.from('topic_attempts')
    .select('id, topic, subject, grade, curriculum, score, total_questions, correct_answers, per_question_results, created_at')
    .eq('student_id', studentId).order('created_at', { ascending: false }).limit(limit);
  if (error) fail(error);
  return data || [];
}

async function listResponses(followupIds) {
  const ids = Array.isArray(followupIds) ? followupIds : [followupIds];
  if (!ids.length) return [];
  const { data, error } = await supabase.from('practice_followup_responses').select(RESPONSE_COLS).in('followup_id', ids).order('seq', { ascending: true });
  if (error) fail(error);
  return data || [];
}

// Inserts one answered question. { duplicate: true } when this question (or
// this order slot) was already saved — a repeated or concurrent submit.
async function insertResponse(row) {
  const { data, error } = await supabase.from('practice_followup_responses').insert(row).select(RESPONSE_COLS).single();
  if (error) {
    if (isUniqueViolation(error)) return { duplicate: true };
    fail(error);
  }
  return { row: data };
}

// Resolves a pending clarification exactly once.
async function resolvePendingResponse(id, patch) {
  const { data, error } = await supabase
    .from('practice_followup_responses')
    .update(patch)
    .eq('id', id)
    .eq('credit', 'pending_clarification')
    .select(RESPONSE_COLS);
  if (error) fail(error);
  return (data && data[0]) || null;
}

async function listFollowupsForStudents(studentIds) {
  if (!studentIds.length) return [];
  const { data, error } = await supabase.from('practice_followups').select(FOLLOWUP_COLS).in('student_id', studentIds).order('created_at', { ascending: false });
  if (error) fail(error);
  return data || [];
}

async function listResponsesForStudents(studentIds) {
  if (!studentIds.length) return [];
  const { data, error } = await supabase.from('practice_followup_responses').select(RESPONSE_COLS).in('student_id', studentIds).order('created_at', { ascending: true });
  if (error) fail(error);
  return data || [];
}

async function isParentOf(parentEmail, childId) {
  const { data, error } = await supabase.from('parent_children').select('child_id')
    .eq('parent_email', String(parentEmail || '').toLowerCase()).eq('child_id', childId).limit(1).maybeSingle();
  if (error) fail(error);
  return Boolean(data);
}

async function teacherStudentIds(teacherId) {
  const { data, error } = await supabase.from('teacher_student').select('student_id').eq('teacher_id', teacherId);
  if (error) fail(error);
  return [...new Set((data || []).map((r) => r.student_id))];
}

async function countAssessments(studentId) {
  const { count, error } = await supabase.from('topic_attempts').select('id', { count: 'exact', head: true }).eq('student_id', studentId).gt('total_questions', 0);
  if (error) fail(error);
  return count || 0;
}

async function listAttempts(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from('topic_attempts').select('id, topic, subject, score, created_at').in('id', ids);
  if (error) fail(error);
  return data || [];
}

module.exports = {
  StoreError, getAttempt, listFollowupsForAttempt, createFollowups, getFollowup, updateFollowup,
  saveSkillPack, getTopicLessonText, listStudentTopicAttempts,
  insertExplanation, listExplanations, listGeneratedQuestions, insertGeneratedQuestions, updateResponseWhere, getStudentBasic, listStudentAttempts,
  listResponses, insertResponse, resolvePendingResponse, listFollowupsForStudents, listResponsesForStudents,
  isParentOf, teacherStudentIds, countAssessments, listAttempts,
};
