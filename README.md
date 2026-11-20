# Aivorah Learning Paths Service

Standalone microservice for the Student Learning Path flow — syllabus
chapters/topics, resolved topic resources (Read/Listen/Practice content),
and IB PYP/CBSE practice quiz generation — extracted from `ai-mentor/server`.

## Structure

```
routes/
  syllabus.js   — GET /current, GET /topic/:topicId/resources
  ibpyp.js      — POST /quiz, /explain-wrong, /track-result
services/
  supabase.js               — Supabase client
  analytics.js               — event logging (logEvent)
  syllabus-map.js            — authoritative book chapter structure, read
                                from data/curricula/*.json
  curriculum/
    types.js                 — shared resource-type constants
    resourceResolver.js      — resolves a topic's 8 resource types from
                                the topic_resources table
data/
  curricula/                 — per-book chapter JSON (extracted from the
                                NCERT/CBSE textbook PDFs), read by
                                syllabus-map.js
```

The teacher-authoring side of syllabus management (upload a book, AI
extraction, review/publish) deliberately stayed in the `ai-mentor` monolith
— it's a separate concern from what a student reads here, and pulls in file
uploads and a job queue this service doesn't need. `GET /ibpyp/lesson-content`
(legacy scene-based lesson generation, used by `TopicLessonScreen`, not the
Learning Path flow) also stayed behind for the same reason.

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3014`).

## Endpoints

- `GET /teacher/syllabus/current?grade=&subject=&curriculum=&schoolId=` —
  a subject's full chapter/topic structure, merged against the book's
  authoritative chapter list (`syllabus-map.js`) so chapters without a
  published lesson yet still appear (`pending: true`) instead of vanishing.
- `GET /teacher/syllabus/topic/:topicId/resources` — resolves all 8 resource
  types (AI_EXPLANATION, IMAGES, AUDIO, PRACTICE, etc.) for one DB-backed
  topic from `topic_resources`.
- `POST /ibpyp/quiz` — `{ topic, grade, subject, curriculum, passageText?,
  topicId?, userEmail?, role? }` → `{ questions, topic, grade, subject }`.
  Serves the textbook's own stored exercises verbatim when a `topicId` has
  one; otherwise generates a 5-question mixed MCQ/fill-blank quiz via Groq.
- `POST /ibpyp/explain-wrong` — `{ topic, subject, grade, question,
  wrongAnswer, correctAnswer }` → `{ explanation }`. A warm, encouraging
  explanation for a wrong answer.
- `POST /ibpyp/track-result` — logs a completed quiz attempt to analytics.
- `/read-aloud/*` — student Read Aloud (signed-in student only, `Authorization:
  Bearer <Firebase ID token>`): `GET passages?grade=&lexile=`, `POST passage`,
  `GET calibration?grade=`, `GET|POST lexile`, `POST assess`, `GET history`,
  `POST transcribe` / `transcribe-live` (multipart `audio` + `passage`, Groq
  Whisper), `POST tts` (ElevenLabs, shipped passages only, cached on
  Cloudinary). Needs `GROQ_API_KEY`, `ELEVENLABS_API_KEY` and the
  `read_aloud_levels` / `read_aloud_sessions` tables (aivorah-db `0008`).
- `/practice-followup/*` — **Practise This Skill** (`routes/practiceFollowup.js`,
  Firebase ID token; needs the `practice_followups` /
  `practice_followup_responses` tables from aivorah-db `0030`). Follow-up
  practice for one curriculum skill from one practice test (`topic_attempts`).
  The vetted skill catalogue (teaching methods, fresh questions with answer
  keys, hints, solutions, reasoning rubric) is in `data/practice-skills/*.json`;
  answer keys never leave the server. Student (own data only):
  `GET attempts/:attemptId` (recommendations), `GET for-topic?topic=&subject=`
  (the follow-up Ask Aivorah opens for a topic), `GET :id` / `POST :id/open
  {lessonText}` (resumable session),
  `POST :id/explain-another-way|hint|solution|answer|clarify`, `GET :id/details`.
  Parent (linked children): `GET parent/children/:childId`. Teacher (linked
  students): `GET teacher/support` ("Needs topic help"),
  `GET teacher/students/:studentId/skills/:skillId`. The model only classifies
  the student's reasoning (supported / unclear / misconception); grading,
  question choice, hint history, progress and flags are server rules. Missed
  questions outside the catalogue become one "topic skill" per test
  (`topic:<topic>`): its teaching and 6 fresh questions with answer keys are
  generated once from the lesson text, validated, and saved in
  `practice_followups.skill_pack` (aivorah-db `0031`). Optional env:
  `PRACTICE_REASONING_TIMEOUT_MS` (default 20000),
  `PRACTICE_GENERATION_TIMEOUT_MS` (default 60000).
- `/practice-followup/attempts/:attemptId/...` — **Explain This Question** /
  **Practise This Skill** under each wrong question of a report
  (`routes/practiceQuestion.js`; aivorah-db `0032`). Student only, own attempt,
  and the question must have been wrong in it:
  `POST questions/:index/explain {action: first|again|another_way}` (methods
  rule → steps → visual, each saved in `practice_explanations`);
  `POST questions/:index/practice {action: start|next}` (one fresh question at a
  time, as many as asked; generated questions are kept only when the model
  answers them the same way WITHOUT the key, stored with server-only keys in
  `practice_generated_questions`; a new question before answering records the
  shown one as skipped; 7+ days after the last activity on the skill the first
  question is a memory check at the level shown before); `GET worked-on`
  ("What you worked on" per wrong question, from saved rows only).
  `POST /practice-followup/:id/working {questionId, working}` names the exact
  mistake step only when the working shows it. Parent (linked) / teacher
  (linked): `GET /practice-followup/report/students/:studentId` (download data;
  no chat or reasoning text).
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
