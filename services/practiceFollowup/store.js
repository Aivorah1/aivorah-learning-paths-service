// Database access for Practise This Skill (tables from aivorah-db
// 0030_practice_followups.sql). Every function throws on a database error so
// the route can show a retry instead of a result that was never saved.
const supabase = require('../supabase');

const FOLLOWUP_COLS = 'id, student_id, attempt_id, skill_id, topic, topic_id, subject, grade, curriculum, original_score, evidence, evidence_question_count, status, teaching_methods_used, current_method, current_question_id, current_help, independent_streak, completed_at, created_at, updated_at';
const RESPONSE_COLS = 'id, followup_id, student_id, skill_id, question_id, question_type, question_text, seq, answer, reasoning, clarification, help_shown, grading_outcome, reasoning_outcome, credit, feedback, created_at, finalized_at';

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
  listResponses, insertResponse, resolvePendingResponse, listFollowupsForStudents, listResponsesForStudents,
  isParentOf, teacherStudentIds, countAssessments, listAttempts,
};
