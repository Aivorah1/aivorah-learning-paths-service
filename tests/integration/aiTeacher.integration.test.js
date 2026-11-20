// AI Teacher routes end to end: real turn logic, curriculum access and
// arithmetic; in-memory question store; the model and the curriculum index are fakes.
const mockCrypto = require('crypto');

const mockDb = { users: [], questions: [] };
const mockClone = (x) => JSON.parse(JSON.stringify(x));
jest.mock('../../services/aiTeacher/store', () => ({
  async getStudent(id) { return mockClone(mockDb.users.find((u) => u.id === id) || null); },
  async insertQuestion(row) { const q = { id: mockCrypto.randomUUID(), status: 'open', created_at: new Date().toISOString(), ...mockClone(row) }; mockDb.questions.push(q); return mockClone(q); },
  async getQuestion(id, sid) { return mockClone(mockDb.questions.find((q) => q.id === id && q.student_id === sid) || null); },
  async closeQuestion(id, patch) { const q = mockDb.questions.find((x) => x.id === id && x.status === 'open'); if (!q) return null; Object.assign(q, patch); return mockClone(q); },
  async seenExamples(sid, key) { return mockClone(mockDb.questions.filter((q) => q.student_id === sid && q.topic_key === key)); },
}));
jest.mock('../../middleware/auth', () => ({
  requireStudentAuth: (req, res, next) => {
    const id = String(req.headers.authorization || '').replace('Bearer student:', '');
    if (!id || id.startsWith('Bearer')) return res.status(401).json({ error: 'nope' });
    req.auth = { studentId: id };
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const router = require('../../routes/aiTeacher');
const app = express();
app.use(express.json());
app.use('/ai-teacher', router);
const deps = router._deps;

const DEMO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const as = (id) => ({ Authorization: `Bearer student:${id}` });
const turn = (transcript, state, id = DEMO) => request(app).post('/ai-teacher/turn').set(as(id)).send({ transcript, state });

const lessonCalls = [];
beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
beforeEach(() => {
  mockDb.users = [{ id: DEMO, name: 'Demo Student', grade: 'Grade 8', curriculum: 'CBSE' }, { id: OTHER, name: 'Other Kid', grade: 'Grade 8', curriculum: 'CBSE' }];
  mockDb.questions = [];
  lessonCalls.length = 0;
  deps.classify = jest.fn(async () => ({ intent: 'unclear', topic: null, subject: null }));
  deps.curriculumContent = jest.fn(async () => null);
  deps.curriculumText = async () => '';
  deps.lessonFromModel = jest.fn(async (ctx) => {
    lessonCalls.push(ctx);
    return { title: ctx.topicTitle, blocks: [{ id: 'bx1', type: 'text', text: ctx.language === 'hi' ? 'कविता' : 'A common multiple is a multiple of both numbers.' }],
      segments: [{ id: 'sx1', caption: ctx.language === 'hi' ? 'कविता' : 'A common multiple is shared.', speech: 'A common multiple is shared.', reveal: ['bx1'] }] };
  });
  deps.generateQuestion = jest.fn(async () => ({ prompt: 'Name the capital of India.', answers: ['New Delhi', 'Delhi'], accept: [], explanation: 'New Delhi is the capital.', answerFormat: 'text' }));
});

test('GET /me gives the first name for the greeting; no token is refused', async () => {
  const r = await request(app).get('/ai-teacher/me').set(as(DEMO));
  expect(r.body).toEqual({ firstName: 'Demo', grade: 'Grade 8', curriculum: 'CBSE' });
  expect((await request(app).get('/ai-teacher/me')).status).toBe(401);
});

test('Explain LCM: curriculum-grounded board, computed worked example, clear note when the textbook text is missing', async () => {
  const r = await turn('Explain LCM');
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ kind: 'lesson', language: 'en', board: 'replace', topic: { title: 'Common Multiples and Common Factors', subject: 'Mathematics', grade: 6, grounded: true } });
  expect(r.body.topic.source).toBe('CBSE Grade 6 Mathematics · Ch 5 Prime Time · 5.1 Common Multiples and Common Factors');
  const eq = r.body.blocks.find((b) => b.type === 'equation');
  expect(eq.lines[2]).toMatch(/^LCM = .* = \d+$/);
  expect(r.body.blocks.find((b) => b.type === 'label').text).toBe('Worked example (generated)');
  expect(r.body.blocks[0]).toMatchObject({ type: 'note' });
  expect(r.body.blocks[0].text).toMatch(/couldn't find this lesson's text/);
  expect(lessonCalls[0]).toMatchObject({ arithmetic: 'lcm', curriculumText: '' });
  expect(r.body.state).toMatchObject({ subject: 'Mathematics', kind: 'lcm', activeQuestionId: null });
  // every segment reveals real blocks
  const ids = new Set(r.body.blocks.map((b) => b.id));
  r.body.segments.forEach((s) => s.reveal.forEach((id) => expect(ids.has(id)).toBe(true)));
});

test('with curriculum text and images, they are passed through and nothing is invented', async () => {
  deps.curriculumContent = jest.fn(async () => ({ text: 'Multiples common to both numbers…', images: [{ url: 'https://res.cloudinary.com/aivorah/fig.png', caption: 'Jumps' }] }));
  const r = await turn('Explain LCM with a diagram');
  expect(r.body.blocks.filter((b) => b.type === 'note').map((b) => b.text)).toEqual(['Take every prime factor with its highest power.']);
  expect(lessonCalls[0]).toMatchObject({ curriculumText: 'Multiples common to both numbers…', images: [{ url: 'https://res.cloudinary.com/aivorah/fig.png' }] });
});

test('missing curriculum media: asking for a diagram says there is none', async () => {
  deps.curriculumContent = jest.fn(async () => ({ text: 'Multiples…', images: [] }));
  const r = await turn('Explain LCM with a diagram');
  expect(r.body.blocks.find((b) => b.type === 'note').text).toMatch(/no diagram or video/);
});

test('problem → hidden answer → spoken answer graded → another question keeps LCM with a new example', async () => {
  const lesson = await turn('Explain LCM');
  const p1 = await turn('Give me a problem to solve', lesson.body.state);
  expect(p1.body.kind).toBe('practice');
  expect(p1.body.practice).toMatchObject({ answerFormat: 'number', durationSeconds: null });
  expect(p1.body.practice.prompt).toMatch(/^Find the LCM of \d+ and \d+\.$/);
  expect(p1.body.segments[0].caption).toMatch(/Say your answer aloud\./);
  const saved = mockDb.questions[0];
  expect(JSON.stringify(p1.body)).not.toContain(`"${saved.answer.values[0]}"`); // the answer is not sent
  expect(JSON.stringify(p1.body)).not.toMatch(/"values"|"answer":/);

  const fb = await turn(`I think it's ${saved.answer.values[0]}`, p1.body.state);
  expect(fb.body).toMatchObject({ kind: 'feedback', feedback: { correct: true, expected: saved.answer.values[0] }, practice: { released: true } });
  expect(mockDb.questions[0]).toMatchObject({ status: 'answered', correct: true });
  const again = await turn(`${saved.answer.values[0]}`, { ...p1.body.state });
  expect(again.body.kind).toBe('info'); // a repeated answer isn't graded twice

  const p2 = await turn('give me another question', fb.body.state);
  expect(p2.body.topic.title).toBe('Common Multiples and Common Factors');
  expect(mockDb.questions[1].example_key).not.toBe(mockDb.questions[0].example_key);
  expect(mockDb.questions[1].topic_key).toBe(mockDb.questions[0].topic_key);
});

test('a wrong answer gets the specific mistake and the steps; an unclear one asks to repeat and keeps the question', async () => {
  const p = await turn('give me a problem on LCM');
  const q = mockDb.questions[0];
  const unclear = await turn('umm I am not sure', p.body.state);
  expect(unclear.body.kind).toBe('unclear');
  expect(mockDb.questions[0].status).toBe('open');
  const common = q.answer.a * q.answer.b === q.answer.values[0] * 1 ? Number(q.answer.values[0]) * 2 : q.answer.a * q.answer.b;
  const wrong = await turn(String(common), p.body.state);
  expect(wrong.body.feedback.correct).toBe(false);
  expect(wrong.body.segments[0].caption).toMatch(/common multiple .* but not the least/);
  expect(wrong.body.blocks.find((b) => b.type === 'equation').lines).toHaveLength(3);
});

test('timed question uses the requested duration; asking for the solution releases it', async () => {
  const p = await turn('give me an LCM question in 2 minutes');
  expect(p.body.practice.durationSeconds).toBe(120);
  expect(p.body.segments[0].speech).toMatch(/You have 2 minutes/);
  const s = await turn('show me the answer', p.body.state);
  expect(s.body).toMatchObject({ kind: 'solution', feedback: { revealed: true, expected: mockDb.questions[0].answer.values[0] } });
  expect(mockDb.questions[0].status).toBe('revealed');
});

test('non-arithmetic topics use a checked generated question and accept spoken variants', async () => {
  deps.classify = jest.fn(async () => ({ intent: 'practice', topic: 'Square Numbers', subject: 'Mathematics' }));
  const p = await turn('quiz me on square numbers');
  expect(p.body.practice.answerFormat).toBe('text');
  const fb = await turn('it is delhi', p.body.state);
  expect(fb.body.feedback.correct).toBe(true);
});

test('Hindi subject sessions use Hindi', async () => {
  deps.classify = jest.fn(async () => ({ intent: 'explain', topic: 'वसंत', subject: 'Hindi' }));
  const r = await turn('हिंदी की कविता वसंत समझाओ');
  if (r.body.kind === 'clarify') { expect(r.body.segments[0].caption).toMatch(/Do you mean/); return; }
  expect(r.body.language).toBe('hi');
  expect(lessonCalls[0].language).toBe('hi');
});

test('unrelated requests are redirected; unsafe ones get the safety reply without any model call', async () => {
  deps.classify = jest.fn(async () => ({ intent: 'off_topic', topic: null, subject: null }));
  const r = await turn('who will win the cricket match today');
  expect(r.body.kind).toBe('redirect');
  expect(r.body.segments[0].caption).toMatch(/get back to your schoolwork/);
  deps.classify.mockClear();
  const s = await turn('I want to hurt myself');
  expect(s.body.kind).toBe('safety');
  expect(deps.classify).not.toHaveBeenCalled();
  expect(lessonCalls).toHaveLength(0);
});

test("forged state is ignored: a topic above the student's grade and another student's question", async () => {
  const forged = await turn('give me another question', { topicKey: 'CBSE|10|Mathematics|1|Real Numbers', kind: 'lcm' });
  expect(forged.body.topic?.grade ?? 0).toBeLessThanOrEqual(8);
  const p = await turn('give me a problem on LCM', {}, OTHER);
  const steal = await turn('24', { activeQuestionId: p.body.practice.id });
  expect(steal.body.kind).not.toBe('feedback');
  expect(mockDb.questions[0].status).toBe('open');
});

test('no topic named and none active: one short clarifying question', async () => {
  deps.classify = jest.fn(async () => ({ intent: 'explain', topic: null, subject: null }));
  const r = await turn('can you explain it');
  expect(r.body.kind).toBe('clarify');
  expect(r.body.segments[0].caption).toMatch(/Which topic/);
});

test('model failure: a retry message, no state change', async () => {
  deps.lessonFromModel = jest.fn(async () => { const { GenerationError } = require('../../services/practiceFollowup/topicSkill'); throw new GenerationError('down'); });
  const r = await turn('explain square numbers');
  expect(r.body.kind).toBe('error');
  expect(r.body.segments[0].caption).toMatch(/couldn't prepare that/);
});
