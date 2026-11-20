// AI Teacher: which curriculum topics a student may be taught, and which one
// a spoken request means. Built on syllabus-map.js (the textbook chapter
// structure the CBSE Learning Paths use), never on a model.
//
// Access: the student's own curriculum, their grade first, then earlier
// grades of the same curriculum (revision). Nothing above their grade.
const { chaptersFor, subjectsFor } = require('../syllabus-map');

const gradeNum = (g) => { const m = String(g ?? '').match(/(\d{1,2})/); return m ? Number(m[1]) : null; };
const isCbse = (c) => /^(cbse|ncert)$/i.test(String(c || '').trim());

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'for', 'me', 'about', 'what', 'is', 'are', 'explain', 'teach', 'tell', 'how', 'do', 'i', 'please', 'can', 'you', 'with', 'my', 'some', 'it', 'this', 'that', 'give', 'show', 'example', 'examples', 'question', 'problem']);

// Spoken names for book topics ("LCM" is taught in "Common Multiples and Common Factors").
const SYNONYMS = [
  [/\b(l ?c ?m|least common multiples?|lowest common multiples?)\b/, 'common multiples', 'lcm'],
  [/\b(h ?c ?f|g ?c ?d|highest common factors?|greatest common (factor|divisor)s?)\b/, 'common factors', 'hcf'],
  [/\bprime factori[sz]ation\b/, 'prime factorisation', null],
  [/\bfractions?\b/, 'fractions', null],
];

const SUBJECT_WORDS = [
  [/\b(maths?|mathematics|arithmetic|algebra|geometry)\b|गणित/, 'Mathematics'],
  [/\bhindi\b|हिंदी|हिन्दी/, 'Hindi'],
  [/\bscience\b|विज्ञान/, 'Science'],
  [/\benglish\b/, 'English'],
  [/\b(social science|history|geography|civics)\b/, 'Social Science'],
];

function scopeOf(student) {
  return { curriculum: student?.curriculum || '', grade: gradeNum(student?.grade), cbse: isCbse(student?.curriculum) };
}

const topicKey = (t) => ['CBSE', t.grade, t.subject, t.chapter, t.title].join('|');
function parseTopicKey(key) {
  const p = String(key || '').split('|');
  if (p.length !== 5) return null;
  return { curriculum: p[0], grade: Number(p[1]), subject: p[2], chapter: Number(p[3]), title: p[4] };
}

// Every topic the student may be taught (subtopics and whole chapters).
function topicIndex(scope, subject) {
  if (!scope.cbse || !scope.grade) return [];
  const out = [];
  for (let g = scope.grade; g >= 1; g -= 1) {
    for (const s of subjectsFor(g)) {
      if (subject && s.subject.toLowerCase() !== subject.toLowerCase()) continue;
      for (const ch of chaptersFor(g, s.subject)) {
        if (ch.placeholder) continue;
        const base = { grade: g, subject: s.subject, chapter: ch.chapter, chapterTitle: ch.title, book: ch.book };
        out.push({ ...base, title: ch.title, section: null, level: 'chapter' });
        for (const st of ch.subtopics || []) {
          if (st?.title) out.push({ ...base, title: st.title, section: st.section || null, level: 'section' });
        }
      }
    }
  }
  return out.map((t) => ({ ...t, key: topicKey(t) }));
}

function subjectIn(text) {
  const t = String(text || '').toLowerCase();
  return SUBJECT_WORDS.find(([re]) => re.test(t))?.[1] || null;
}

// What a request names: the expanded words, and an arithmetic kind (lcm / hcf) if any.
function expandQuery(text) {
  let t = norm(text);
  let arithmetic = null;
  for (const [re, words, kind] of SYNONYMS) {
    if (re.test(t)) { t = `${t} ${words}`; arithmetic = arithmetic || kind; }
  }
  return { text: t, arithmetic };
}

const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

// Ranked topic matches for a request (best first). Own grade and sections win ties.
function findTopics(request, scope, { subject } = {}) {
  const { text, arithmetic } = expandQuery(request);
  const want = new Set(tokens(text));
  if (!want.size) return [];
  const list = topicIndex(scope, subject);
  const scored = [];
  for (const t of list) {
    const have = tokens(`${t.title} ${t.level === 'section' ? t.chapterTitle : ''}`);
    if (!have.length) continue;
    const hit = have.filter((w) => want.has(w) || [...want].some((x) => x.length > 4 && (w.startsWith(x) || x.startsWith(w)))).length;
    if (!hit) continue;
    const titleHit = tokens(t.title).filter((w) => want.has(w)).length;
    const score = titleHit * 2 + hit + (t.grade === scope.grade ? 0.5 : 0) + (t.level === 'section' ? 0.3 : 0) - (scope.grade - t.grade) * 0.05;
    scored.push({ ...t, score, arithmetic, titleHits: titleHit, synonymHit: !!arithmetic });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// The topic a request means: one clear best match, or null + up to 2 options to ask about.
function resolveTopic(request, scope, opts = {}) {
  const ranked = findTopics(request, scope, opts);
  if (!ranked.length) return { topic: null, options: [] };
  const [best, second] = ranked;
  const clear = !second || best.score - second.score >= 1 || (second.subject === best.subject && second.chapter === best.chapter && second.grade === best.grade);
  if (clear) return { topic: best, options: [] };
  const options = [best, ...ranked.filter((r) => r.subject !== best.subject || r.chapter !== best.chapter).slice(0, 1)];
  return { topic: null, options };
}

// A topic the client says is active: only if this student may still see it.
function authorizedTopic(key, scope) {
  const p = parseTopicKey(key);
  if (!p || !scope.cbse || !scope.grade || p.grade > scope.grade || p.grade < 1) return null;
  return topicIndex({ ...scope, grade: p.grade }, p.subject).find((t) => t.key === key && t.grade === p.grade) || null;
}

const sourceLabel = (t) => (t ? `CBSE Grade ${t.grade} ${t.subject} · Ch ${t.chapter} ${t.chapterTitle}${t.section ? ` · ${t.section} ${t.title}` : ''}` : null);

module.exports = { gradeNum, isCbse, scopeOf, topicIndex, findTopics, resolveTopic, authorizedTopic, parseTopicKey, topicKey, subjectIn, expandQuery, sourceLabel };
