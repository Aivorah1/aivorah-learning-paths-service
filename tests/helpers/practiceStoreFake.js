// In-memory stand-in for services/practiceFollowup/store.js with the same
// uniqueness rules as the 0030 migration (one follow-up per attempt+skill, one
// response per follow-up+question and per follow-up+seq).
const crypto = require('crypto');

function createFakeStore() {
  const db = { attempts: [], followups: [], responses: [], parentLinks: [], teacherLinks: [] };
  const failNext = { update: 0, insert: 0 };
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const now = () => new Date(Date.now() + db.responses.length).toISOString();

  const api = {
    db, failNext,
    StoreError: Error,
    async getAttempt(id) { return clone(db.attempts.find((a) => a.id === id) || null); },
    async listFollowupsForAttempt(attemptId) { return clone(db.followups.filter((f) => f.attempt_id === attemptId)); },
    async createFollowups(rows) {
      for (const r of rows) {
        if (db.followups.some((f) => f.attempt_id === r.attempt_id && f.skill_id === r.skill_id)) continue;
        db.followups.push({
          id: crypto.randomUUID(), teaching_methods_used: [], current_method: null, current_question_id: null,
          current_help: 'none', independent_streak: 0, completed_at: null, skill_pack: null, created_at: now(), updated_at: now(), ...clone(r),
        });
      }
    },
    async getFollowup(id) { return clone(db.followups.find((f) => f.id === id) || null); },
    async updateFollowup(id, patch, { expectQuestionId } = {}) {
      if (failNext.update > 0) { failNext.update -= 1; throw new Error('connection reset'); }
      const f = db.followups.find((x) => x.id === id);
      if (!f) return null;
      if (expectQuestionId !== undefined && (f.current_question_id || null) !== expectQuestionId) return null;
      Object.assign(f, clone(patch), { updated_at: now() });
      return clone(f);
    },
    async saveSkillPack(id, pack) {
      const f = db.followups.find((x) => x.id === id);
      if (!f || f.skill_pack) return null;
      f.skill_pack = clone(pack);
      return clone(f);
    },
    async getTopicLessonText() { return db.lessonText || ''; },
    async listStudentTopicAttempts(studentId, topic, subject) {
      return clone(db.attempts.filter((a) => a.student_id === studentId && a.topic === topic && (!subject || a.subject === subject))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    },
    async listResponses(ids) {
      const set = new Set(Array.isArray(ids) ? ids : [ids]);
      return clone(db.responses.filter((r) => set.has(r.followup_id)).sort((a, b) => a.seq - b.seq));
    },
    async insertResponse(row) {
      if (failNext.insert > 0) { failNext.insert -= 1; throw new Error('connection reset'); }
      if (db.responses.some((r) => r.followup_id === row.followup_id && (r.question_id === row.question_id || r.seq === row.seq))) return { duplicate: true };
      const saved = { id: crypto.randomUUID(), clarification: null, created_at: now(), ...clone(row) };
      db.responses.push(saved);
      return { row: clone(saved) };
    },
    async resolvePendingResponse(id, patch) {
      const r = db.responses.find((x) => x.id === id && x.credit === 'pending_clarification');
      if (!r) return null;
      Object.assign(r, clone(patch));
      return clone(r);
    },
    async listFollowupsForStudents(ids) { return clone(db.followups.filter((f) => ids.includes(f.student_id)).reverse()); },
    async listResponsesForStudents(ids) { return clone(db.responses.filter((r) => ids.includes(r.student_id))); },
    async isParentOf(email, childId) { return db.parentLinks.some((l) => l.email === String(email).toLowerCase() && l.childId === childId); },
    async teacherStudentIds(teacherId) { return db.teacherLinks.filter((l) => l.teacherId === teacherId).map((l) => l.studentId); },
    async countAssessments(studentId) { return db.attempts.filter((a) => a.student_id === studentId).length; },
    async listAttempts(ids) { return clone(db.attempts.filter((a) => ids.includes(a.id))); },
  };
  return api;
}

module.exports = { createFakeStore };
