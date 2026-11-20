// AI Teacher — pure rules: curriculum access + topic matching, computed
// arithmetic, spoken numbers, intents, and validation of model lessons.
const curriculum = require('../../services/aiTeacher/curriculum');
const arithmetic = require('../../services/aiTeacher/arithmetic');
const { ruleIntent, requestedDuration, classify } = require('../../services/aiTeacher/intent');
const compose = require('../../services/aiTeacher/compose');
const { checkInputSafety } = require('../../services/aiTeacher/safety');

const G8 = curriculum.scopeOf({ curriculum: 'CBSE', grade: 'Grade 8' });

describe('curriculum access and topic matching', () => {
  test('"Explain LCM" resolves to the real CBSE book topic, at or below the student grade', () => {
    const { topic } = curriculum.resolveTopic('Explain LCM', G8);
    expect(topic).toMatchObject({ grade: 6, subject: 'Mathematics', chapter: 5, chapterTitle: 'Prime Time', title: 'Common Multiples and Common Factors', arithmetic: 'lcm' });
    expect(curriculum.sourceLabel(topic)).toBe('CBSE Grade 6 Mathematics · Ch 5 Prime Time · 5.1 Common Multiples and Common Factors');
    expect(curriculum.resolveTopic('teach me HCF', G8).topic.arithmetic).toBe('hcf');
  });

  test('a student never gets topics above their grade; a forged active topic is refused', () => {
    const g5 = curriculum.scopeOf({ curriculum: 'CBSE', grade: 'Grade 5' });
    expect(curriculum.topicIndex(g5).every((t) => t.grade <= 5)).toBe(true);
    const lcmKey = curriculum.resolveTopic('Explain LCM', G8).topic.key;
    expect(curriculum.authorizedTopic(lcmKey, G8)).toBeTruthy();
    expect(curriculum.authorizedTopic(lcmKey, g5)).toBeNull();
    expect(curriculum.authorizedTopic('CBSE|6|Mathematics|5|Made up topic', G8)).toBeNull();
    expect(curriculum.authorizedTopic('CBSE|6|Mathematics|5|Common Multiples and Common Factors', curriculum.scopeOf({ curriculum: 'IB PYP', grade: 'Grade 8' }))).toBeNull();
  });

  test('ambiguous requests give options to ask about; unknown ones give nothing', () => {
    const r = curriculum.resolveTopic('हिंदी कविता', G8);
    expect(r.topic).toBeNull();
    expect(r.options.length).toBeGreaterThan(0);
    expect(curriculum.resolveTopic('explain cricket rules', G8)).toEqual({ topic: null, options: [] });
  });
});

describe('computed arithmetic', () => {
  test('LCM and HCF steps in prime-factor notation', () => {
    expect(arithmetic.steps('lcm', 12, 18).lines).toEqual(['12 = 2² × 3', '18 = 2 × 3²', 'LCM = 2² × 3² = 36']);
    expect(arithmetic.steps('hcf', 12, 18).lines).toEqual(['12 = 2² × 3', '18 = 2 × 3²', 'HCF = 2 × 3 = 6']);
    expect(arithmetic.steps('lcm', 8, 12).value).toBe(24);
  });

  test('fresh practice pairs never repeat an example already given', () => {
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) {
      const p = arithmetic.freshPair('lcm', seen, 2);
      expect(seen.has(p.exampleKey)).toBe(false);
      expect(p.answer).toBe(arithmetic.lcm(p.a, p.b));
      expect(p.b % p.a).not.toBe(0);
      seen.add(p.exampleKey);
    }
  });

  test('wrong LCM/HCF claims in generated text are caught', () => {
    expect(arithmetic.wrongClaims('The LCM of 4 and 6 is 24.')).toEqual([{ claim: 'The LCM of 4 and 6 is 24'.replace('The ', ''), right: 12 }]);
    expect(arithmetic.wrongClaims('LCM(8, 12) = 24 and the HCF of 12 and 18 is 6.')).toEqual([]);
  });

  test('spoken numbers: digits, words, Hindi', () => {
    expect(['24', 'twenty four', 'thirty-six', 'one hundred and twenty', 'I think it is 36', 'चौबीस', 'no idea'].map(arithmetic.parseSpokenNumber))
      .toEqual([24, 24, 36, 120, 36, 24, null]);
  });
});

describe('intents', () => {
  test('clear phrasings are matched without the model', () => {
    expect(ruleIntent('Explain LCM')).toBe('explain');
    expect(ruleIntent('Give me a problem to solve')).toBe('practice');
    expect(ruleIntent('give me another question')).toBe('practice');
    expect(ruleIntent('show me another example')).toBe('example');
    expect(ruleIntent('what is the answer')).toBe('solution');
    expect(ruleIntent('try again')).toBe('retry_timer');
    expect(ruleIntent('thank you')).toBe('smalltalk');
    expect(ruleIntent('twenty four', { activeFormat: 'number' })).toBe('answer');
    expect(ruleIntent('it is 24', { activeFormat: 'number' })).toBe('answer');
    expect(ruleIntent('who won the cricket match')).toBeNull();
  });

  test('requested timer durations', () => {
    expect(requestedDuration('give me a question in 2 minutes')).toBe(120);
    expect(requestedDuration('90 seconds please')).toBe(90);
    expect(requestedDuration('give me a timed question')).toBe(90);
    expect(requestedDuration('give me a question')).toBeNull();
  });

  test('the model classifier is validated; garbage or failure is "unclear"', async () => {
    expect((await classify('hmm', {}, { callModel: () => '{"intent":"off_topic","topic":null}' })).intent).toBe('off_topic');
    expect((await classify('hmm', {}, { callModel: () => '{"intent":"hack the grades"}' })).intent).toBe('unclear');
    expect((await classify('hmm', {}, { callModel: () => { throw new Error('down'); } })).intent).toBe('unclear');
  });
});

describe('model lessons are validated before they are spoken', () => {
  const ctx = { topicTitle: 'Common Multiples', language: 'en', images: [{ url: 'https://res.cloudinary.com/x/fig1.png', caption: 'Number line' }] };
  const lesson = (over = {}) => ({
    title: 'LCM', segments: [{ caption: 'A multiple is…', speech: 'A multiple is…', reveal: ['b1'] }, { caption: 'Look', speech: 'Look at this', reveal: ['b2', 'b9'] }],
    blocks: [{ id: 'b1', type: 'text', text: 'Multiples of 4: 4, 8, 12' }, { id: 'b2', type: 'image', image: 0, caption: 'Jumps' }, { id: 'b9', type: 'image', image: 5 }, { id: 'b3', type: 'video', url: 'https://evil.example/v.mp4' }],
    ...over,
  });

  test('only curriculum images by number; invented media and unknown types are dropped; reveals map to real blocks', () => {
    const out = compose.validateLesson(lesson(), ctx);
    expect(out.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(out.blocks[1].url).toBe('https://res.cloudinary.com/x/fig1.png');
    expect(out.segments[1].reveal).toEqual([out.blocks[1].id]);
    expect(JSON.stringify(out)).not.toContain('evil.example');
  });

  test('wrong arithmetic, unsafe text, or English for a Hindi lesson are rejected', () => {
    expect(() => compose.validateLesson(lesson({ segments: [{ caption: 'The LCM of 4 and 6 is 24', speech: 'x', reveal: [] }] }), ctx)).toThrow(/wrong arithmetic/);
    expect(() => compose.validateLesson(lesson({ segments: [{ caption: 'how to make a bomb', speech: 'x', reveal: [] }] }), ctx)).toThrow(/unsafe/);
    expect(() => compose.validateLesson(lesson(), { ...ctx, language: 'hi' })).toThrow(/not in Hindi/);
    const hi = compose.validateLesson(lesson({ segments: [{ caption: 'कविता में लय होती है।', speech: 'कविता में लय होती है।', reveal: ['b1'] }] }), { ...ctx, language: 'hi' });
    expect(hi.segments[0].caption).toBe('कविता में लय होती है।');
  });

  test('worked example and feedback are computed; maths is spoken in words', () => {
    const ex = compose.workedExample('lcm', 12, 18);
    expect(ex.blocks.find((b) => b.type === 'equation').lines).toEqual(['12 = 2² × 3', '18 = 2 × 3²', 'LCM = 2² × 3² = 36']);
    expect(ex.blocks[0].text).toBe('Worked example (generated)');
    expect(ex.segments[1].speech).toContain('12 equals 2 squared times 3');
    expect(compose.arithmeticFeedback('lcm', 8, 12, 24)).toMatchObject({ correct: true, expected: '24' });
    expect(compose.arithmeticFeedback('lcm', 8, 12, 96).segments[0].caption).toMatch(/common multiple of 8 and 12, but not the least/);
    expect(compose.arithmeticFeedback('lcm', 8, 12, 4).segments[0].caption).toMatch(/is the HCF/);
  });

  test('safety rules match AI Coach', () => {
    expect(checkInputSafety('I want to hurt myself').safe).toBe(false);
    expect(checkInputSafety('explain LCM').safe).toBe(true);
  });
});
