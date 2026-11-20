/**
 * routes/aiTeacher.js — AI Teacher (Student Portal), signed-in students only.
 *
 *   GET  /ai-teacher/me     first name, grade, curriculum (for the greeting)
 *   POST /ai-teacher/turn   { transcript, state? } -> one validated reply:
 *     { kind, language, board: 'replace'|'keep', topic, segments[], blocks[],
 *       practice?: { id, prompt, answerFormat, durationSeconds, released? },
 *       feedback?: { correct, expected, given, message }, state }
 *   `state` is echoed back by the app each turn (active subject/topic, the
 *   waiting question's id, recent example keys); the server re-checks the
 *   topic against the student's curriculum and the question against their id.
 */
const express = require('express');
const { requireStudentAuth } = require('../middleware/auth');
const store = require('../services/aiTeacher/store');
const { handleTurn, firstName } = require('../services/aiTeacher/turn');
const { classify } = require('../services/aiTeacher/intent');
const { lessonFromModel } = require('../services/aiTeacher/compose');
const { generateQuestion, curriculumContent } = require('../services/aiTeacher/question');

const router = express.Router();

const deps = {
  store,
  classify,
  lessonFromModel,
  generateQuestion,
  curriculumContent,
  curriculumText: async (topic) => (await curriculumContent(topic))?.text || '',
  now: () => Date.now(),
};

router.get('/me', requireStudentAuth, async (req, res) => {
  try {
    const s = await store.getStudent(req.auth.studentId);
    if (!s) return res.status(404).json({ error: 'Student not found' });
    res.json({ firstName: firstName(s.name), grade: s.grade || null, curriculum: s.curriculum || null });
  } catch (err) {
    console.error('[ai-teacher] me failed:', err.message);
    res.status(500).json({ error: 'Could not load your details.' });
  }
});

router.post('/turn', requireStudentAuth, async (req, res) => {
  try {
    const student = await store.getStudent(req.auth.studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const state = req.body?.state && typeof req.body.state === 'object' ? req.body.state : {};
    const out = await handleTurn({ student, transcript: req.body?.transcript, state }, deps);
    res.json(out);
  } catch (err) {
    console.error('[ai-teacher] turn failed:', err.message);
    res.status(503).json({ code: 'turn_failed', error: "I couldn't answer just now. Please ask again." });
  }
});

module.exports = router;
module.exports._deps = deps;
