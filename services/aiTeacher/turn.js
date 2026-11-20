// AI Teacher: one spoken turn → a validated, structured reply.
// The server decides everything that matters: which topics the student may
// be taught, what the turn asks for, which question is asked (answers kept in
// ai_teacher_questions until answered or revealed), grading, and safety. The
// model only writes explanations and non-arithmetic questions, and its output
// is validated first.
const curriculum = require('./curriculum');
const arithmetic = require('./arithmetic');
const compose = require('./compose');
const { ruleIntent, classify, requestedDuration } = require('./intent');
const { checkInputSafety } = require('./safety');
const { normalizeAnswer, levenshtein } = require('../practiceFollowup/text');
const { GenerationError } = require('../practiceFollowup/topicSkill');

const MAX_TRANSCRIPT = 300;
const GENERIC = new Set('give me a an another one more new different question questions problem problems sum sums solve to please quick timed timer minute minutes seconds second example examples explain again it this that show can you i want try let us lets do some with in for of the and teach tell about what is are now समझाओ बताओ क्या है में के की का को'.split(' '));

const langOf = (subject) => (/hindi/i.test(String(subject || '')) ? 'hi' : 'en');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

const LINES = {
  en: {
    unclear: "Sorry, I didn't catch that. Could you say it again?",
    unclearNumber: "I didn't catch a number. Please say your answer again.",
    which: 'Which topic would you like to learn? For example, say "Explain LCM".',
    offTopic: "That's not something I can help with here. Let's get back to your schoolwork — ask me about any topic from your lessons!",
    retryLater: "I couldn't prepare that just now. Please ask me again.",
    noQuestion: "There's no question waiting right now. Say \"give me a problem\" and I'll ask you one.",
    already: "You've already answered that one. Say \"another question\" for a new one.",
    say: 'Say your answer aloud.',
  },
  hi: {
    unclear: 'माफ़ कीजिए, मैं ठीक से सुन नहीं पाया। कृपया फिर से कहिए।',
    unclearNumber: 'मुझे संख्या सुनाई नहीं दी। कृपया अपना उत्तर फिर से बोलिए।',
    which: 'आप कौन-सा विषय पढ़ना चाहेंगे? जैसे कहिए, "कविता समझाओ"।',
    offTopic: 'मैं यहाँ उसमें मदद नहीं कर सकता। चलिए अपनी पढ़ाई पर लौटते हैं!',
    retryLater: 'मैं अभी यह तैयार नहीं कर पाया। कृपया फिर से पूछिए।',
    noQuestion: 'अभी कोई प्रश्न नहीं है। "प्रश्न दो" कहिए।',
    already: 'आप इसका उत्तर दे चुके हैं। नया प्रश्न माँगिए।',
    say: 'अपना उत्तर बोलकर बताइए।',
  },
};

function topicView(t, grounded) {
  if (!t) return null;
  return {
    key: t.key || null, title: t.title, subject: t.subject, grade: t.grade || null,
    chapter: t.chapter || null, chapterTitle: t.chapterTitle || null, section: t.section || null,
    source: t.key ? curriculum.sourceLabel(t) : null, grounded: !!grounded,
  };
}

function reply(kind, parts, extra = {}) {
  return { kind, language: extra.language || 'en', board: extra.board || 'keep', topic: extra.topic ?? null, practice: extra.practice || null,
    feedback: extra.feedback || null, segments: parts.segments || [], blocks: parts.blocks || [], state: extra.state };
}

// Words left after removing request words: is a topic actually named?
const namesTopic = (text) => curriculum.expandQuery(text).text.split(' ').some((w) => w.length > 2 && !GENERIC.has(w));

function grade(q, transcript) {
  if (q.answer_format === 'number') {
    const n = arithmetic.parseSpokenNumber(transcript);
    if (n == null) return { unclear: true };
    if (q.answer?.kind === 'lcm' || q.answer?.kind === 'hcf') return { given: String(n), ...compose.arithmeticFeedback(q.answer.kind, q.answer.a, q.answer.b, n) };
    const correct = (q.answer?.values || []).some((v) => Number(v) === n);
    return { given: String(n), correct, expected: String(q.answer?.values?.[0] ?? '') };
  }
  const given = normalizeAnswer(transcript);
  const accepted = [...(q.answer?.values || []), ...(q.answer?.accept || [])].map(normalizeAnswer).filter(Boolean);
  const correct = accepted.some((a) => given === a || ` ${given} `.includes(` ${a} `) || (a.length >= 6 && levenshtein(a, given) <= 1));
  return { given: transcript.trim().slice(0, 120), correct, expected: String(q.answer?.values?.[0] ?? '') };
}

async function handleTurn({ student, transcript, state = {} }, deps) {
  const t = String(transcript || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT);
  const scope = curriculum.scopeOf(student);
  // The active topic only counts if this student may still be taught it.
  let active = state.topicKey ? curriculum.authorizedTopic(state.topicKey, scope) : null;
  if (active && state.kind) active = { ...active, arithmetic: state.kind };
  const subjectNow = active?.subject || (typeof state.subject === 'string' ? state.subject.slice(0, 40) : null);
  let language = langOf(subjectNow);
  const L = () => LINES[language];
  const examples = Array.isArray(state.examples) ? state.examples.filter((x) => typeof x === 'string').slice(-10) : [];
  const keep = (patch = {}) => ({ subject: subjectNow, topicKey: active?.key || null, topicTitle: active?.title || state.topicTitle || null, kind: active?.arithmetic || null, activeQuestionId: state.activeQuestionId || null, examples, ...patch });

  if (!t) return reply('unclear', compose.say(L().unclear, { language }), { language, state: keep() });

  const safety = checkInputSafety(t);
  if (!safety.safe) return reply('safety', compose.say(safety.response), { language, state: keep({ activeQuestionId: null }) });

  // The waiting question, if it is this student's (an answered one stays known so a repeat gets "already answered").
  const activeQ = state.activeQuestionId ? await deps.store.getQuestion(state.activeQuestionId, student.id) : null;

  // An answer-shaped reply to a question already answered still counts as an answer (and gets "already answered").
  let intent = ruleIntent(t, { activeFormat: activeQ ? activeQ.answer_format : null });
  let named = null;
  let namedSubject = curriculum.subjectIn(t);
  if (!intent) {
    const c = await deps.classify(t, { grade: student.grade, curriculum: student.curriculum, subject: subjectNow, topic: active?.title, activeQuestion: activeQ?.status === 'open' ? activeQ.prompt : null });
    intent = c.intent;
    named = c.topic;
    namedSubject = namedSubject || c.subject;
  }

  // ── answers, solutions, timer retries for the waiting question ──
  if (intent === 'answer' || intent === 'solution' || intent === 'retry_timer') {
    if (!activeQ) return reply('info', compose.say(L().noQuestion, { language }), { language, state: keep({ activeQuestionId: null }) });
    if (activeQ.status !== 'open') return reply('info', compose.say(L().already, { language }), { language, state: keep({ activeQuestionId: null }) });
    const practice = { id: activeQ.id, prompt: activeQ.prompt, answerFormat: activeQ.answer_format, durationSeconds: activeQ.duration_seconds };
    if (intent === 'retry_timer') {
      return reply('practice', { segments: compose.practiceSegments(activeQ.prompt, { duration: activeQ.duration_seconds, language }) }, { language, practice, state: keep() });
    }
    if (intent === 'solution') {
      const closed = await deps.store.closeQuestion(activeQ.id, { status: 'revealed', answered_at: new Date(deps.now()).toISOString() });
      if (!closed) return reply('info', compose.say(L().already, { language }), { language, state: keep({ activeQuestionId: null }) });
      const fb = activeQ.answer?.kind ? compose.arithmeticFeedback(activeQ.answer.kind, activeQ.answer.a, activeQ.answer.b, -1) : null;
      const expected = String(activeQ.answer?.values?.[0] ?? '');
      const text = `The answer is ${expected}.${activeQ.answer?.explanation ? ` ${activeQ.answer.explanation}` : ''}`;
      const parts = fb ? { segments: [compose.say(text).segments[0], ...fb.segments.slice(1)], blocks: fb.blocks.slice(1) } : compose.say(text);
      return reply('solution', parts, { language, practice: { ...practice, released: true }, feedback: { correct: null, revealed: true, expected, message: text }, state: keep({ activeQuestionId: null }) });
    }
    const g = grade(activeQ, t);
    if (g.unclear) return reply('unclear', compose.say(L().unclearNumber, { language }), { language, practice, state: keep() });
    const closed = await deps.store.closeQuestion(activeQ.id, { status: 'answered', student_answer: g.given, correct: !!g.correct, answered_at: new Date(deps.now()).toISOString() });
    if (!closed) return reply('info', compose.say(L().already, { language }), { language, state: keep({ activeQuestionId: null }) });
    const parts = g.segments ? { segments: g.segments, blocks: g.blocks } : compose.say(g.correct
      ? `Yes, that's right! ${activeQ.answer?.explanation || ''}`.trim()
      : `Not quite. The answer is ${g.expected}. ${activeQ.answer?.explanation || ''}`.trim(), { language });
    const message = parts.segments[0]?.caption || '';
    return reply('feedback', parts, { language, practice: { ...practice, released: true }, feedback: { correct: !!g.correct, expected: g.expected, given: g.given, message }, state: keep({ activeQuestionId: null }) });
  }

  if (intent === 'repeat') return reply('repeat', { segments: [] }, { language, state: keep() });
  if (intent === 'off_topic') return reply('redirect', compose.say(L().offTopic, { language }), { language, state: keep() });
  if (intent === 'smalltalk') {
    const text = /thank|धन्यवाद/i.test(t) ? "You're welcome! What would you like to learn next?" : `Hi ${firstName(student.name)}! What would you like to learn today?`;
    return reply('smalltalk', compose.say(text), { language, state: keep() });
  }
  if (intent === 'unclear') return reply('unclear', compose.say(L().unclear, { language }), { language, state: keep() });

  // ── explain / example / practice: which topic? ──
  let topic = active;
  let grounded = !!active;
  const request = named || t;
  if (namesTopic(request) || !active) {
    const subj = namedSubject && /^(Mathematics|Hindi|Science|English|Social Science)$/.test(namedSubject) ? namedSubject : undefined;
    let r = curriculum.resolveTopic(request, scope, { subject: subj });
    // A weak match (one word of a title, no known synonym) may be a non-school
    // request that happens to share a word: the model decides before we teach it.
    if (r.topic && !named && r.topic.titleHits < 2 && !r.topic.synonymHit) {
      const c = await deps.classify(t, { grade: student.grade, curriculum: student.curriculum, subject: subjectNow, topic: active?.title });
      if (c.intent === 'off_topic') return reply('redirect', compose.say(L().offTopic, { language }), { language, state: keep() });
      if (c.topic && curriculum.resolveTopic(c.topic, scope, { subject: subj }).topic?.key !== r.topic.key) {
        named = c.topic;
        namedSubject = namedSubject || c.subject;
        r = curriculum.resolveTopic(c.topic, scope, { subject: subj });
      }
    }
    if (r.topic) { topic = r.topic; grounded = true; } else if (r.options.length) {
      const opts = r.options.map((o) => `${o.title} (Grade ${o.grade} ${o.subject})`).join(' or ');
      return reply('clarify', compose.say(`Do you mean ${opts}?`), { language, state: keep() });
    } else {
      const { arithmetic: kind } = curriculum.expandQuery(request);
      // Named but not in the Learning Paths: a clearly labelled general explanation of what was asked.
      const asked = named || (namesTopic(request) ? request.split(/\s+/).filter((w) => !GENERIC.has(w.toLowerCase())).join(' ').slice(0, 60) : null);
      const title = asked || (kind ? kind.toUpperCase() : null);
      if (!title) return reply('clarify', compose.say(L().which, { language }), { language, state: keep() });
      topic = { key: null, title, subject: namedSubject || (kind ? 'Mathematics' : subjectNow || 'General'), grade: scope.grade, arithmetic: kind };
      grounded = false;
    }
  }
  const kind = curriculum.expandQuery(t).arithmetic || topic.arithmetic || (active && topic.key === active.key ? active.arithmetic : null) || null;
  topic = { ...topic, arithmetic: kind };
  language = langOf(topic.subject);
  const view = topicView(topic, grounded);
  const nextState = (patch = {}) => ({ subject: topic.subject, topicKey: topic.key || null, topicTitle: topic.title, kind, activeQuestionId: null, examples, ...patch });
  const gradeLabel = scope.grade ? `Grade ${scope.grade}` : 'your grade';

  if (intent === 'practice') {
    const duration = requestedDuration(t);
    const seen = topic.key ? await deps.store.seenExamples(student.id, topic.key) : [];
    const seenKeys = new Set([...seen.map((s) => s.example_key), ...examples]);
    let row;
    if (kind) {
      const pair = arithmetic.freshPair(kind, seenKeys, 2);
      if (!pair) return reply('info', compose.say(L().retryLater, { language }), { language, topic: view, state: nextState() });
      row = { example_key: pair.exampleKey, prompt: `Find the ${kind.toUpperCase()} of ${pair.a} and ${pair.b}.`, answer_format: 'number', source: 'computed',
        answer: { values: [String(pair.answer)], kind, a: pair.a, b: pair.b } };
    } else {
      let q;
      try {
        q = await deps.generateQuestion({ topic, grade: student.grade, language, lessonText: await deps.curriculumText(topic).catch(() => ''), avoid: seen.map((s) => s.prompt) });
      } catch (err) {
        if (!(err instanceof GenerationError)) throw err;
        return reply('error', compose.say(L().retryLater, { language }), { language, topic: view, state: nextState() });
      }
      row = { example_key: `q:${q.prompt.toLowerCase().slice(0, 120)}`, prompt: q.prompt, answer_format: q.answerFormat, source: 'generated', answer: { values: q.answers, accept: q.accept || [], explanation: q.explanation } };
    }
    const saved = await deps.store.insertQuestion({ student_id: student.id, subject: topic.subject, topic_key: topic.key || `general|${topic.subject}|${topic.title}`, duration_seconds: duration, ...row });
    const practice = { id: saved.id, prompt: saved.prompt, answerFormat: saved.answer_format, durationSeconds: saved.duration_seconds };
    return reply('practice', { segments: compose.practiceSegments(saved.prompt, { duration, language }) }, { language, topic: view, practice, state: nextState({ activeQuestionId: saved.id, examples: [...examples, row.example_key].slice(-10) }) });
  }

  // explain / example
  const content = await deps.curriculumContent(topic).catch(() => null);
  const notes = [];
  const hi = language === 'hi';
  if (!grounded) notes.push(hi ? 'यह आपके Learning Paths में नहीं है, इसलिए यह एक सामान्य व्याख्या है।' : `This isn't in your Learning Paths, so here is a general ${gradeLabel} explanation.`);
  else if (!content?.text) notes.push(hi ? `मुझे अभी आपकी पाठ्यपुस्तक में यह पाठ नहीं मिला, इसलिए यह एक सामान्य व्याख्या है (${curriculum.sourceLabel(topic)})।` : `I couldn't find this lesson's text in your textbook just now, so this is a general explanation (${curriculum.sourceLabel(topic)}).`);
  if (/\b(diagram|picture|image|video|chart|figure)\b|चित्र|वीडियो/i.test(t) && !(content?.images || []).length) notes.push(hi ? 'इसके लिए आपके पाठ्यक्रम में कोई चित्र या वीडियो नहीं है, इसलिए मैं शब्दों में समझाऊँगा।' : "There's no diagram or video for this in your curriculum, so I'll explain it in words.");

  const blocks = notes.map((text) => ({ id: `n${Math.random().toString(36).slice(2, 8)}`, type: 'note', text }));
  const segments = [];
  if (notes.length) segments.push({ id: `sn${Math.random().toString(36).slice(2, 8)}`, caption: notes[0], speech: notes[0], reveal: blocks.map((b) => b.id) });
  let title = topic.title;
  let newExamples = examples;
  const skipModel = intent === 'example' && kind;
  if (!skipModel) {
    try {
      const lesson = await deps.lessonFromModel({ kind: intent === 'example' ? 'example' : 'explain', language, grade: student.grade, subject: topic.subject, topicTitle: topic.title,
        request: t, sourceLabel: curriculum.sourceLabel(topic) || 'general', curriculumText: content?.text || '', images: content?.images || [], arithmetic: kind, avoidExamples: examples });
      title = lesson.title || title;
      blocks.push(...lesson.blocks);
      segments.push(...lesson.segments);
    } catch (err) {
      if (!(err instanceof GenerationError)) throw err;
      if (!kind) return reply('error', compose.say(L().retryLater, { language }), { language, topic: view, state: keep() });
    }
  }
  if (kind) {
    const pair = arithmetic.freshPair(kind, new Set(examples), 2);
    if (pair) {
      const ex = compose.workedExample(kind, pair.a, pair.b);
      blocks.push(...ex.blocks);
      segments.push(...ex.segments);
      newExamples = [...examples, pair.exampleKey].slice(-10);
    }
  }
  return reply(intent === 'example' ? 'example' : 'lesson', { segments, blocks }, { language, board: 'replace', topic: { ...view, title }, state: nextState({ examples: newExamples }) });
}

module.exports = { handleTurn, langOf, firstName, grade, LINES };
