// Server-side grading for follow-up questions, against the catalogue's
// trusted answer key. The browser never sees the key for an active question.
const { normalizeAnswer, levenshtein } = require('./text');

const MAX_ANSWER_CHARS = 120;

// MCQ answers arrive as the chosen option's index. Returns null when the
// input is not a valid answer for this question (400 for the route).
function parseAnswer(question, raw) {
  if (question.type === 'mcq') {
    const n = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw ?? '').trim()) ? Number(raw) : NaN);
    if (!Number.isInteger(n) || n < 0 || n >= question.options.length) return null;
    return { index: n, text: question.options[n] };
  }
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_ANSWER_CHARS) return null;
  return { text };
}

function gradeAnswer(question, parsed) {
  if (question.type === 'mcq') return parsed.index === question.answer;
  const given = normalizeAnswer(parsed.text);
  const accepted = [...(question.answers || []), ...(question.accept || [])].map(normalizeAnswer);
  if (accepted.includes(given)) return true;
  // Spelling only matters when it is part of the skill: a catalogue question
  // can allow one small typo in a longer word ("aliteration").
  if (question.allowTypos) {
    return accepted.some((a) => a.length >= 6 && Math.abs(a.length - given.length) <= 1 && levenshtein(a, given) <= 1);
  }
  return false;
}

function correctAnswerText(question) {
  return question.type === 'mcq' ? question.options[question.answer] : question.answers[0];
}

// Supportive feedback for a wrong answer: the catalogue's note for that exact
// option (or the question's general note).
function wrongFeedback(question, parsed) {
  if (question.type === 'mcq') {
    return question.whyWrong?.[String(parsed.index)] || question.wrongFeedback || question.solution;
  }
  return question.wrongFeedback || question.solution;
}

module.exports = { parseAnswer, gradeAnswer, correctAnswerText, wrongFeedback, MAX_ANSWER_CHARS };
