// Vetted skill catalogue for "Practise This Skill" (data/practice-skills/*.json).
//
// Each skill holds the approved teaching content, a bank of fresh questions
// with their answer keys, hints and solutions, and a short reasoning rubric.
// Nothing here is sent to the browser as-is: publicQuestion() strips answer
// keys, and hints/solutions are only released by the routes after the help is
// saved. See docs/practise-this-skill.md.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'data', 'practice-skills');

function compile(skill) {
  const re = (s) => new RegExp(s, 'i');
  return {
    ...skill,
    _match: (skill.match?.patterns || []).map(re),
    _subject: re(skill.subjectPattern || skill.subject),
    _concepts: Object.fromEntries(Object.entries(skill.concepts || {}).map(([k, v]) => [k, re(v)])),
    _byId: new Map((skill.questions || []).map((q) => [q.id, q])),
  };
}

function validateSkill(skill) {
  const problems = [];
  if (!skill.id || !skill.label || !skill.shortName) problems.push('id, label and shortName are required');
  const methods = skill.teaching?.methods || [];
  if (methods.length < 2) problems.push('at least two teaching methods are required');
  const ids = new Set();
  for (const q of skill.questions || []) {
    if (ids.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.hint || !q.solution) problems.push(`${q.id}: hint and solution are required`);
    if (q.type === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`${q.id}: needs 2+ options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options || []).length) problems.push(`${q.id}: bad answer index`);
    } else if (q.type === 'fill_blank') {
      if (!Array.isArray(q.answers) || !q.answers.length) problems.push(`${q.id}: needs answers`);
    } else {
      problems.push(`${q.id}: unknown type ${q.type}`);
    }
  }
  return problems;
}

let cache = null;
function loadAll() {
  if (cache) return cache;
  const skills = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  for (const s of skills) {
    const problems = validateSkill(s);
    if (problems.length) throw new Error(`practice skill ${s.id}: ${problems.join('; ')}`);
  }
  cache = skills.map(compile);
  return cache;
}

function getSkill(id) {
  return loadAll().find((s) => s.id === id) || null;
}

function listSkills() {
  return loadAll();
}

// "Grade 8" / "8" / "Class 8" -> 8 (null when unknown).
function gradeNumber(grade) {
  const m = String(grade ?? '').match(/(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

// The skill a question tests, when the mapping is reliable: the attempt's
// subject and grade must be in the skill's scope AND the question itself must
// match one of the skill's patterns. Otherwise null (no recommendation).
function skillForQuestion({ subject, grade }, questionText, extraText = '') {
  const g = gradeNumber(grade);
  const text = `${questionText || ''} ${extraText || ''}`;
  for (const s of loadAll()) {
    if (!s._subject.test(String(subject || ''))) continue;
    if (g != null && Array.isArray(s.grades) && s.grades.length && !s.grades.includes(g)) continue;
    if (s._match.some((re) => re.test(text))) return s;
  }
  return null;
}

function conceptOf(skill, text) {
  for (const [k, re] of Object.entries(skill._concepts || {})) if (re.test(String(text || ''))) return k;
  return null;
}

// What the browser may see of a question: never the answer key, hint or solution.
function publicQuestion(q) {
  if (!q) return null;
  const base = { id: q.id, type: q.type, question: q.question };
  if (q.type === 'mcq') base.options = q.options.slice();
  base.reasoningPrompt = q.type === 'mcq' ? 'Why did you choose that option?' : 'Why did you write that answer?';
  return base;
}

module.exports = { compile, getSkill, listSkills, skillForQuestion, conceptOf, publicQuestion, gradeNumber, validateSkill, _reset: () => { cache = null; } };
