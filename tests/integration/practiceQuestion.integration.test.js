// Explain This Question / Practise This Skill per wrong question, end to end
// over the in-memory store (same uniqueness rules as aivorah-db 0030-0032).
// The model is mocked by prompt type; grading, freshness, access, memory
// checks and saved outcomes are the real server code.
const { createFakeStore } = require('../helpers/practiceStoreFake');

const mockStore = createFakeStore();
jest.mock('../../services/practiceFollowup/store', () => mockStore);

const mockModel = jest.fn();
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: (...a) => mockModel(...a) }));

jest.mock('../../middleware/auth', () => {
  const pick = (roles) => (req, res, next) => {
    const [role, id] = String(req.headers.authorization || '').replace('Bearer ', '').split(':');
    if (!roles.includes(role)) return res.status(role ? 403 : 401).json({ error: 'nope' });
    req.auth = role === 'student' ? { studentId: id } : role === 'parent' ? { role, email: id } : { role, teacherId: id };
    next();
  };
  return { requireStudentAuth: pick(['student']), requireParentAuth: pick(['parent']), requireAuth: pick(['teacher']), requireParentOrTeacherAuth: pick(['parent', 'teacher']) };
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/practice-followup', require('../../routes/practiceQuestion'));
app.use('/practice-followup', require('../../routes/practiceFollowup'));
const { clock } = require('../../services/practiceFollowup/context');

const STU = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const as = (who) => ({ Authorization: `Bearer ${who}` });
const DAY = 86400000;
let now = Date.parse('2026-11-20T10:00:00Z');

// Model mock: one answer per prompt type.
let genCount = 0;
let solveWrong = false;
function model(prompt) {
  if (/Explain ONE test question/.test(prompt)) {
    const method = /side-by-side comparison table/.test(prompt) ? 'visual' : /numbered steps/.test(prompt) ? 'steps' : 'rule';
    return JSON.stringify({ skillLabel: 'Adding fractions with different denominators', title: `Explained by ${method}${/AGAIN more simply/.test(prompt) ? ' (simpler)' : ''}`, body: 'Find a common denominator, then add the numerators.', example: '1/2 + 1/3 = 3/6 + 2/6 = 5/6', steps: method === 'steps' ? ['Find the LCM of 2 and 3', 'Rename both fractions', 'Add'] : undefined, table: method === 'visual' ? [['Right', 'Wrong'], ['5/6', '2/5']] : undefined });
  }
  if (/NEW practice questions that test the SAME idea/.test(prompt)) {
    const n = ++genCount;
    return JSON.stringify({ skillLabel: 'Adding fractions with different denominators', questions: [
      { type: 'mcq', question: `What is 1/${n + 2} + 1/${n + 3}? (set ${n})`, options: ['A', 'B', 'C'], answer: 1, hint: 'Find the LCM first.', solution: 'Use the LCM.', whyWrong: { 0: 'Check the LCM.' }, keyIdea: 'Use a common denominator.' },
      { type: 'fill_blank', question: `1/${n + 1} + 1/${n + 1} = ____ (set ${n})`, answers: [`2/${n + 1}`], hint: 'Same denominator.', solution: 'Add numerators.', wrongFeedback: 'Add the tops.' },
      // A lightly reworded copy of the original test question: must never be shown.
      { type: 'mcq', question: 'What is the value of 1/4 + 1/6?', options: ['5/12', '2/10', '1/24'], answer: 0, hint: 'h', solution: 's' },
    ] });
  }
  if (/Answer each question using only the lesson text/.test(prompt)) {
    const count = (prompt.match(/^\d+\. /gm) || []).length;
    const answers = [];
    const lines = prompt.split('\n');
    for (let i = 0; i < count; i += 1) {
      const line = lines.find((l) => l.startsWith(`${i + 1}. `)) || '';
      if (/choose one/.test(line)) answers.push(/value of 1\/4/.test(line) ? 0 : (solveWrong ? 0 : 1));
      else answers.push((line.match(/1\/(\d+) \+ 1\/\1/) || [])[1] ? `2/${line.match(/1\/(\d+) \+/)[1]}` : null);
    }
    return JSON.stringify({ answers });
  }
  if (/Name the exact step they got wrong/.test(prompt)) {
    const work = prompt.split('<student_working>')[1] || '';
    if (/LCM|lcm/.test(work) && /24/.test(work)) return JSON.stringify({ status: 'identified', step: 'finding the LCM', feedback: 'The LCM of 4 and 6 is 12, not 24.', confidence: 0.9 });
    if (/only changed the bottom|denominator/.test(work)) return JSON.stringify({ status: 'identified', step: 'changing the numerator too', feedback: 'Multiply the top by the same number as the bottom.', confidence: 0.9 });
    return JSON.stringify({ status: 'unclear', confidence: 0.3 });
  }
  if (/classifier/.test(prompt)) {
    const work = prompt.split('<student_explanation>')[1] || '';
    return JSON.stringify(/hmm maybe/.test(work) ? { outcome: 'unclear', confidence: 0.9 } : { outcome: 'supported', confidence: 0.9 });
  }
  return '{}';
}

function attempt(id, createdAt) {
  return { id, student_id: STU, topic: 'Adding fractions', subject: 'Mathematics', grade: 'Grade 6', curriculum: 'CBSE', score: 33, correct_answers: 1, total_questions: 3, created_at: createdAt,
    per_question_results: [
      { question: 'What is 1/4 + 1/6?', studentAnswer: '2/10', correctAnswer: '5/12', isCorrect: false, reasoning: 'I added the tops and bottoms' },
      { question: 'Write 3/4 as an equivalent fraction with denominator 12', studentAnswer: '3/12', correctAnswer: '9/12', isCorrect: false },
      { question: 'What is 1/2 of 10?', studentAnswer: '5', correctAnswer: '5', isCorrect: true },
      { type: 'spoken', question: 'Explain fractions', studentAnswer: '', isCorrect: false },
    ] };
}

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
beforeEach(() => {
  Object.assign(mockStore.db, { attempts: [attempt(A1, '2026-11-18T10:00:00Z'), attempt(A2, '2026-11-19T10:00:00Z')], followups: [], responses: [], parentLinks: [], teacherLinks: [], explanations: [], generated: [], users: [{ id: STU, name: 'Riya Test', grade: 'Grade 6', curriculum: 'CBSE' }] });
  genCount = 0; solveWrong = false;
  now = Date.parse('2026-11-20T10:00:00Z');
  clock.now = () => now;
  mockStore.db.clock = () => now;
  mockModel.mockReset();
  mockModel.mockImplementation(async (p) => model(p));
});

const explain = (idx, action, who = STU, att = A1) => request(app).post(`/practice-followup/attempts/${att}/questions/${idx}/explain`).set(as(`student:${who}`)).send({ action });
const practise = (idx, action = 'start', att = A1) => request(app).post(`/practice-followup/attempts/${att}/questions/${idx}/practice`).set(as(`student:${STU}`)).send({ action, lessonText: 'Add fractions by finding a common denominator.' });
const keyOf = (fid, qid) => {
  const g = mockStore.db.generated.find((x) => x.followup_id === fid && x.question_id === qid);
  if (g) return g.payload.type === 'mcq' ? g.payload.answer : g.payload.answers[0];
  const bank = require('../../services/practiceFollowup/catalog').getSkill('math.fractions.equivalent')._byId.get(qid);
  return bank.type === 'mcq' ? bank.answer : bank.answers[0];
};
const answer = (fid, qid, ans, reasoning = 'I found a common denominator first, then added') =>
  request(app).post(`/practice-followup/${fid}/answer`).set(as(`student:${STU}`)).send({ questionId: qid, answer: ans, reasoning });

describe('Explain This Question', () => {
  test('starts with the clicked (second) wrong question, can move to the other, and only wrong questions are offered', async () => {
    const r = await explain(1, 'first');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'explain', questionIndex: 1, question: { text: 'Write 3/4 as an equivalent fraction with denominator 12', yourAnswer: '3/12', correctAnswer: '9/12' } });
    expect(r.body.wrongQuestions.map((w) => w.index)).toEqual([0, 1]); // not the right one, not the voice question
    const next = await explain(0, 'first');
    expect(next.body.question.text).toBe('What is 1/4 + 1/6?');
    expect(mockStore.db.explanations.map((e) => e.question_index)).toEqual([1, 0]);
  });

  test('Explain Another Way changes the method each time and remembers what was used; Explain Again re-explains simply', async () => {
    const a = await explain(0, 'first');
    const b = await explain(0, 'another_way');
    const c = await explain(0, 'another_way');
    expect([a.body.explanation.method, b.body.explanation.method, c.body.explanation.method]).toEqual(['rule', 'steps', 'visual']);
    expect(b.body.explanation.steps).toHaveLength(3);
    expect(c.body.explanation.table).toBeTruthy();
    const again = await explain(0, 'again');
    expect(again.body.explanation).toMatchObject({ method: 'visual', variant: 'again', title: 'Explained by visual (simpler)' });
    // Reopening shows the saved explanation instead of generating a new one.
    const calls = mockModel.mock.calls.length;
    await explain(0, 'first');
    expect(mockModel.mock.calls.length).toBe(calls);
  });

  test('a question that was right, another student, or the voice question are refused', async () => {
    expect((await explain(2, 'first')).body.code).toBe('not_wrong');
    expect((await explain(3, 'first')).body.code).toBe('not_wrong');
    expect((await explain(0, 'first', OTHER)).status).toBe(404);
    expect(mockStore.db.explanations).toHaveLength(0);
  });

  test('AI failure: nothing saved, a retry is offered', async () => {
    mockModel.mockImplementation(async () => 'not json');
    const r = await explain(0, 'first');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('generation_failed');
    expect(mockStore.db.explanations).toHaveLength(0);
  });
});

describe('Practise This Skill', () => {
  test('starts with a fresh question (no explanation first) and keeps going past two; never repeats originals or earlier questions', async () => {
    const first = await practise(0);
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe('practice');
    expect(first.body.question.question).toMatch(/set 1/);
    expect(mockStore.db.explanations).toHaveLength(0);
    const fid = first.body.followupId;
    const seen = [first.body.question.id];
    let q = first.body.question;
    for (let i = 0; i < 4; i += 1) {
      const a = await answer(fid, q.id, keyOf(fid, q.id));
      expect({ i, status: a.status, body: a.body }).toMatchObject({ status: 200, body: { result: { code: 'independent' } } });
      expect(a.body.session.question).toBeNull(); // waits for the student to ask
      const n = await practise(0, 'next');
      expect(n.status).toBe(200);
      q = n.body.question;
      expect(seen).not.toContain(q.id);
      seen.push(q.id);
    }
    const texts = mockStore.db.generated.map((g) => g.payload.question);
    expect(texts).not.toContain('What is the value of 1/4 + 1/6?'); // reworded original never stored
    expect(mockStore.db.responses.filter((r) => r.origin_question_index === 0)).toHaveLength(4);
  });

  test('asking for a new question before answering records the shown one as skipped', async () => {
    const first = await practise(0);
    await practise(0, 'next');
    const skipped = mockStore.db.responses.find((r) => r.question_id === first.body.question.id);
    expect(skipped).toMatchObject({ skipped: true, credit: 'none', origin_question_index: 0 });
  });

  test('independent, assisted and unclear answers are each saved accurately', async () => {
    const q1 = await practise(0);
    const fid = q1.body.followupId;
    await answer(fid, q1.body.question.id, keyOf(fid, q1.body.question.id));
    const q2 = await practise(0, 'next');
    await request(app).post(`/practice-followup/${fid}/hint`).set(as(`student:${STU}`)).send({ questionId: q2.body.question.id });
    const assisted = await answer(fid, q2.body.question.id, keyOf(fid, q2.body.question.id));
    expect(assisted.body.result.code).toBe('assisted');
    const q3 = await practise(0, 'next');
    const unclear = await answer(fid, q3.body.question.id, keyOf(fid, q3.body.question.id), 'hmm maybe this one');
    expect(unclear.body.result.code).toBe('clarify');
    const rs = mockStore.db.responses.filter((r) => r.followup_id === fid);
    expect(rs.map((r) => r.credit)).toEqual(['independent', 'assisted', 'pending_clarification']);
    // While awaiting verification, practice returns the clarification instead of a new question.
    const blocked = await practise(0, 'next');
    expect(blocked.body.clarification.questionId).toBe(q3.body.question.id);
  });

  test('a generated question the independent answer check disagrees with is never shown', async () => {
    solveWrong = true; // the solver picks option 0, the key says 1 for the set-N MCQs
    const r = await practise(0);
    expect(r.status).toBe(200);
    expect(r.body.question.type).toBe('fill_blank');
    expect(mockStore.db.generated.every((g) => g.payload.type === 'fill_blank')).toBe(true);
  });

  test('the vetted catalogue is used first for a catalogue skill (equivalent fractions)', async () => {
    const r = await practise(1);
    expect(r.body.question.id).toMatch(/^ef-/);
  });

  test('wrong answer: the LCM step and the numerator step are named from the working; no working -> asks for a step, no guess', async () => {
    const q1 = await practise(0);
    const fid = q1.body.followupId;
    const lcm = await answer(fid, q1.body.question.id, 0, 'the LCM of 4 and 6 is 24 so I used 24');
    expect(lcm.body.result.code).toBe('incorrect');
    expect(lcm.body.result.message).toMatch(/LCM of 4 and 6 is 12/);
    expect(mockStore.db.responses.at(-1).mistake_tag).toBe('finding the LCM');

    const q2 = await practise(0, 'next');
    const bare = await answer(fid, q2.body.question.id, q2.body.question.type === 'mcq' ? 0 : 'wrong', '');
    expect(bare.body.result.message).toMatch(/Tell me one step of how you worked it out/);
    expect(mockStore.db.responses.at(-1).mistake_tag).toBeFalsy();
    const vague = await request(app).post(`/practice-followup/${fid}/working`).set(as(`student:${STU}`)).send({ questionId: q2.body.question.id, working: 'I just did it in my head' });
    expect(vague.body.identified).toBe(false);
    const clear = await request(app).post(`/practice-followup/${fid}/working`).set(as(`student:${STU}`)).send({ questionId: q2.body.question.id, working: 'I only changed the bottom number to 12' });
    expect(clear.body).toMatchObject({ identified: true, step: 'changing the numerator too' });

    const fq = await practise(1); // equivalent fractions: numerator not changed
    const ffid = fq.body.followupId;
    const wrongPick = fq.body.question.type === 'mcq' ? (keyOf(ffid, fq.body.question.id) + 1) % fq.body.question.options.length : '99';
    const conv = await answer(ffid, fq.body.question.id, wrongPick, 'I only changed the bottom number, the denominator');
    expect(conv.body.result.message).toMatch(/Multiply the top by the same number/);
  });
});

describe('Memory check a week later', () => {
  test('after 7+ days: the first question is a memory check at the level shown before, saved separately; then normal practice', async () => {
    const q1 = await practise(0);
    const fid = q1.body.followupId;
    await answer(fid, q1.body.question.id, keyOf(fid, q1.body.question.id)); // independent at level 2
    const q2 = await practise(0, 'next');
    expect(q2.body.question.level).toBe(3); // level goes up after an independent answer
    await answer(fid, q2.body.question.id, keyOf(fid, q2.body.question.id)); // independent at level 3

    now += 3 * 86400000; // 3 days: normal practice
    const early = await practise(0, 'next');
    expect(early.body.question.isMemoryCheck).toBe(false);
    await answer(fid, early.body.question.id, keyOf(fid, early.body.question.id));

    now += 8 * DAY; // back after 8 days
    const check = await practise(0, 'next');
    expect(check.body.question).toMatchObject({ isMemoryCheck: true, level: 3 });
    expect(check.body.explanation).toBeUndefined(); // question before any reteaching
    const res = await answer(fid, check.body.question.id, keyOf(fid, check.body.question.id));
    expect(res.body.result.code).toBe('independent');
    const saved = mockStore.db.responses.find((r) => r.question_id === check.body.question.id);
    expect(saved).toMatchObject({ is_memory_check: true, question_level: 3, help_shown: 'none' });
    const after = await practise(0, 'next');
    expect(after.body.question.isMemoryCheck).toBe(false);
  });

  test('too little earlier evidence: the memory check starts with a basic question', async () => {
    await explain(0, 'first');
    now += 10 * DAY;
    const check = await practise(0);
    expect(check.body.question).toMatchObject({ isMemoryCheck: true, level: 1 });
  });
});

describe('What you worked on', () => {
  test('is per wrong question and per test; the original score is untouched', async () => {
    await explain(0, 'first');
    await explain(0, 'another_way');
    const q1 = await practise(0);
    const fid = q1.body.followupId;
    await answer(fid, q1.body.question.id, keyOf(fid, q1.body.question.id));
    const r = await request(app).get(`/practice-followup/attempts/${A1}/worked-on`).set(as(`student:${STU}`));
    const q0 = r.body.questions.find((q) => q.index === 0);
    expect(q0.hasActivity).toBe(true);
    expect(q0.skillLabel).toBe('Adding fractions with different denominators');
    expect(q0.lines[0]).toMatch(/explained .* in 2 different ways\. Explanation reviewed\./);
    expect(q0.lines[1]).toBe('Practised 1 fresh question: 1 on your own.');
    expect(r.body.questions.find((q) => q.index === 1).hasActivity).toBe(false);
    const other = await request(app).get(`/practice-followup/attempts/${A2}/worked-on`).set(as(`student:${STU}`));
    expect(other.body.questions.every((q) => !q.hasActivity)).toBe(true);
    expect(mockStore.db.attempts.find((a) => a.id === A1).score).toBe(33);
    expect((await request(app).get(`/practice-followup/attempts/${A1}/worked-on`).set(as(`student:${OTHER}`))).status).toBe(404);
  });

  test('a mistake is only called recurring across two distinct questions', async () => {
    const q1 = await practise(0);
    const fid = q1.body.followupId;
    await answer(fid, q1.body.question.id, 0, 'the LCM of 4 and 6 is 24 so I used 24');
    let wo = (await request(app).get(`/practice-followup/attempts/${A1}/worked-on`).set(as(`student:${STU}`))).body.questions[0];
    expect(wo.recurringMistakes).toEqual([]);
    expect(wo.lines.join(' ')).toMatch(/Last mistake to work on: finding the LCM/);
    const q2 = await practise(0, 'next');
    const wrong = q2.body.question.type === 'mcq' ? 0 : 'nope';
    await answer(fid, q2.body.question.id, wrong, 'LCM is 24 again');
    wo = (await request(app).get(`/practice-followup/attempts/${A1}/worked-on`).set(as(`student:${STU}`))).body.questions[0];
    expect(wo.recurringMistakes).toEqual([{ step: 'finding the LCM', questions: 2 }]);
  });
});

describe('Parent and teacher report', () => {
  test('linked parent and linked teacher get the same saved results; others are refused; tests without follow-up still listed', async () => {
    await explain(0, 'first');
    const q1 = await practise(0);
    await answer(q1.body.followupId, q1.body.question.id, keyOf(q1.body.followupId, q1.body.question.id));
    mockStore.db.parentLinks.push({ email: 'meera@x.com', childId: STU });
    mockStore.db.teacherLinks.push({ teacherId: 't1', studentId: STU });
    const p = await request(app).get(`/practice-followup/report/students/${STU}`).set(as('parent:meera@x.com'));
    const t = await request(app).get(`/practice-followup/report/students/${STU}`).set(as('teacher:t1'));
    expect(p.status).toBe(200);
    expect(t.body.tests).toEqual(p.body.tests);
    expect(p.body.student).toMatchObject({ name: 'Riya Test', grade: 'Grade 6' });
    const t1 = p.body.tests.find((x) => x.attemptId === A1);
    expect(t1).toMatchObject({ subject: 'Mathematics', topic: 'Adding fractions', score: 33, explanationsShown: 1, hasFollowUp: true, practice: expect.objectContaining({ total: 1, independent: 1 }) });
    expect(t1.skillsReviewed).toContain('Adding fractions with different denominators');
    expect(p.body.tests.find((x) => x.attemptId === A2)).toMatchObject({ hasFollowUp: false, score: 33 });
    expect(JSON.stringify(p.body)).not.toMatch(/common denominator first, then added/); // no reasoning text
    expect((await request(app).get(`/practice-followup/report/students/${STU}`).set(as('parent:someone@x.com'))).status).toBe(403);
    expect((await request(app).get(`/practice-followup/report/students/${STU}`).set(as('teacher:t9'))).status).toBe(403);
    expect((await request(app).get(`/practice-followup/report/students/${STU}`).set(as(`student:${STU}`))).status).toBe(403);
  });
});
