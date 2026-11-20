// Text helpers for Practise This Skill: comparing questions, grading typed
// answers, and two small detectors used to explain a specific confusion.

// Lower case, straight quotes, keep letters/digits/'/' only, single spaces.
// '/' is kept so fractions like 2/3 still compare.
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}/ ]+/gu, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// Typed answers: also drop a leading article ("a pun" -> "pun").
function normalizeAnswer(text) {
  return normalize(text).replace(/^(a|an|the)\s+/, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'is', 'was', 'it', 'its']);

// Three words close together (within any 4 words) starting with the same
// letter, ignoring small words: "Busy birds built a nest" -> true.
function isAlliterative(text) {
  const words = normalize(text).split(' ').filter((w) => /^\p{L}/u.test(w) && !STOP.has(w));
  for (let i = 0; i < words.length; i += 1) {
    const first = words[i][0];
    const near = words.slice(i, i + 4).filter((w) => w[0] === first).length;
    if (near >= 3) return true;
  }
  return false;
}

const FRACTION = /(\d+)\s*\/\s*(\d+)/g;
function fractionsIn(text) {
  return [...String(text ?? '').matchAll(FRACTION)].map((m) => [Number(m[1]), Number(m[2])]);
}

// Did the student add the same number to the top and bottom of a fraction in
// the question? ("2/3" -> "3/4", or "3/5 = ?/10" -> "8").
function fractionAddedSame(questionText, studentAnswer) {
  const qs = fractionsIn(questionText);
  const ans = fractionsIn(studentAnswer);
  for (const [a, b] of qs) {
    for (const [p, q] of ans) if (p - a === q - b && p !== a) return true;
  }
  const lone = String(studentAnswer ?? '').trim().match(/^(\d+)$/);
  const blank = String(questionText ?? '').match(/(\d+)\s*\/\s*(\d+)\s*=\s*(?:\?|_+|□)\s*\/\s*(\d+)/);
  if (lone && blank) {
    const [a, b, d] = [Number(blank[1]), Number(blank[2]), Number(blank[3])];
    const n = Number(lone[1]);
    if (n - a === d - b && d !== b) return true;
  }
  return false;
}

module.exports = { normalize, normalizeAnswer, levenshtein, isAlliterative, fractionAddedSame };
