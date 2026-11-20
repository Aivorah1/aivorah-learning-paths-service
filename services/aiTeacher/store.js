// AI Teacher database access (aivorah-db 0033 ai_teacher_questions + users).
const supabase = require('../supabase');

const Q_COLS = 'id, student_id, subject, topic_key, example_key, prompt, answer_format, answer, duration_seconds, source, status, student_answer, correct, answered_at, created_at';
const fail = (error) => { const e = new Error(error.message || 'database error'); e.code = error.code; throw e; };

async function getStudent(id) {
  const { data, error } = await supabase.from('users').select('id, name, grade, curriculum').eq('id', id).maybeSingle();
  if (error) fail(error);
  return data;
}

async function insertQuestion(row) {
  const { data, error } = await supabase.from('ai_teacher_questions').insert(row).select(Q_COLS).single();
  if (error) fail(error);
  return data;
}

async function getQuestion(id, studentId) {
  const { data, error } = await supabase.from('ai_teacher_questions').select(Q_COLS).eq('id', id).eq('student_id', studentId).maybeSingle();
  if (error) {
    if (/invalid input syntax for type uuid/i.test(error.message || '')) return null;
    fail(error);
  }
  return data;
}

// Closes an open question once (a repeated answer can't be graded twice).
async function closeQuestion(id, patch) {
  const { data, error } = await supabase.from('ai_teacher_questions').update(patch).eq('id', id).eq('status', 'open').select(Q_COLS);
  if (error) fail(error);
  return (data && data[0]) || null;
}

// Examples this student already had on a topic (so a new question differs).
async function seenExamples(studentId, topicKey) {
  const { data, error } = await supabase.from('ai_teacher_questions').select('example_key, prompt')
    .eq('student_id', studentId).eq('topic_key', topicKey).order('created_at', { ascending: false }).limit(100);
  if (error) fail(error);
  return data || [];
}

module.exports = { getStudent, insertQuestion, getQuestion, closeQuestion, seenExamples };
