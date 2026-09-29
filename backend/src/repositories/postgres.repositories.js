'use strict';

const { getPool } = require('../db/postgres.service');

const asDate = (value) => value ? new Date(value).toISOString() : new Date().toISOString();
const asNumber = (value) => Number(value) || 0;

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, name: row.name || row.username, role: row.role || 'user', studentId: row.student_id || '', approved: row.approved !== false, createdAt: asDate(row.created_at) };
}

class PostgresUserRepository {
  constructor(options = {}) { this.pool = options.pool || getPool(options); }
  async findByUsername(username) { return (await this.pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username])).rows[0] || null; }
  async findById(id) { return (await this.pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null; }
  async insert(user) {
    const row = (await this.pool.query(`INSERT INTO users (id, username, name, password_hash, role, student_id, approved, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [user.id, user.username, user.name, user.password_hash, user.role, user.student_id, user.approved !== 0, user.created_at])).rows[0];
    return row;
  }
  async updatePassword(id, passwordHash) { return (await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *', [passwordHash, id])).rows[0] || null; }
}

class PostgresConversationRepository {
  constructor(options = {}) { this.pool = options.pool || getPool(options); }
  normalize(row) { return row ? { id: row.id, title: row.title, messages: row.messages_json || [], createdAt: asDate(row.created_at), updatedAt: asDate(row.updated_at) } : null; }
  async list(userId) { return (await this.pool.query('SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC', [userId])).rows.map((row) => this.normalize(row)); }
  async get(userId, id) { return this.normalize((await this.pool.query('SELECT * FROM conversations WHERE user_id = $1 AND id = $2', [userId, id])).rows[0]); }
  async create(userId, conversation) {
    const row = (await this.pool.query(`INSERT INTO conversations (id, user_id, title, messages_json, created_at, updated_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`, [conversation.id, userId, conversation.title, JSON.stringify(conversation.messages || []), conversation.createdAt, conversation.updatedAt])).rows[0];
    return this.normalize(row);
  }
  async save(userId, conversation) {
    const row = (await this.pool.query(`UPDATE conversations SET title = $1, messages_json = $2::jsonb, updated_at = $3
      WHERE user_id = $4 AND id = $5 RETURNING *`, [conversation.title, JSON.stringify(conversation.messages || []), conversation.updatedAt, userId, conversation.id])).rows[0];
    return this.normalize(row);
  }
  async delete(userId, id) { return (await this.pool.query('DELETE FROM conversations WHERE user_id = $1 AND id = $2', [userId, id])).rowCount > 0; }
}

class PostgresAttachmentRepository {
  constructor(options = {}) { this.pool = options.pool || getPool(options); }
  normalize(row) { return row ? { id: row.id, ownerUserId: row.owner_user_id, conversationId: row.conversation_id, storageName: row.storage_name, objectKey: row.object_key, originalName: row.original_name, mimetype: row.mimetype, size: asNumber(row.size), isImage: row.is_image === true, createdAt: asNumber(row.created_at), expiresAt: asNumber(row.expires_at) } : null; }
  async create(value) { return this.normalize((await this.pool.query(`INSERT INTO attachments (id, owner_user_id, conversation_id, storage_name, object_key, original_name, mimetype, size, is_image, created_at, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [value.id, value.ownerUserId, value.conversationId, value.storageName, value.objectKey, value.originalName, value.mimetype, value.size, value.isImage, value.createdAt, value.expiresAt])).rows[0]); }
  async getById(id) { return this.normalize((await this.pool.query('SELECT * FROM attachments WHERE id = $1', [id])).rows[0]); }
  async getByStorageName(name) { return this.normalize((await this.pool.query('SELECT * FROM attachments WHERE storage_name = $1', [name])).rows[0]); }
  async setObjectKey(id, objectKey) { return this.normalize((await this.pool.query('UPDATE attachments SET object_key = $1 WHERE id = $2 RETURNING *', [objectKey, id])).rows[0]); }
  async delete(id) { return (await this.pool.query('DELETE FROM attachments WHERE id = $1', [id])).rowCount > 0; }
  async listExpired(now) { return (await this.pool.query('SELECT * FROM attachments WHERE expires_at <= $1', [now])).rows.map((row) => this.normalize(row)); }
  async listAll() { return (await this.pool.query('SELECT * FROM attachments')).rows.map((row) => this.normalize(row)); }
}

class PostgresFeedbackRepository {
  constructor(options = {}) { this.pool = options.pool || getPool(options); }
  normalize(row) { return row ? { id: row.id, userId: row.user_id, conversationId: row.conversation_id, messageId: row.message_id, questionMessageId: row.question_message_id, rating: row.rating, question: row.question, answer: row.answer, traceId: row.trace_id, sources: row.sources_json || [], evalStatus: row.eval_status || undefined, evalStatusAt: row.eval_status_at ? asDate(row.eval_status_at) : undefined, createdAt: asDate(row.created_at) } : null; }
  async upsert(value) {
    const row = (await this.pool.query(`INSERT INTO rag_feedback (id,user_id,conversation_id,message_id,question_message_id,rating,question,answer,trace_id,sources_json,eval_status,eval_status_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
      ON CONFLICT (user_id,id) DO UPDATE SET rating=EXCLUDED.rating,question=EXCLUDED.question,answer=EXCLUDED.answer,trace_id=EXCLUDED.trace_id,sources_json=EXCLUDED.sources_json,eval_status=EXCLUDED.eval_status,eval_status_at=EXCLUDED.eval_status_at
      RETURNING *`, [value.id, value.userId, value.conversationId, value.messageId, value.questionMessageId || '', value.rating, value.question || '', value.answer || '', value.traceId || '', JSON.stringify(value.sources || []), value.evalStatus || null, value.evalStatusAt || null, value.createdAt || new Date().toISOString()])).rows[0];
    return this.normalize(row);
  }
  async get(userId, id) { return this.normalize((await this.pool.query('SELECT * FROM rag_feedback WHERE user_id = $1 AND id = $2', [userId, id])).rows[0]); }
  async list() { return (await this.pool.query('SELECT * FROM rag_feedback ORDER BY created_at DESC')).rows.map((row) => this.normalize(row)); }
}

class PostgresJobRepository {
  constructor(options = {}) { this.pool = options.pool || getPool(options); }
  normalize(row) { return row ? { id: row.id, type: row.type, payload: row.payload_json || {}, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: asNumber(row.available_at), lockedAt: row.locked_at === null ? null : asNumber(row.locked_at), lastError: row.last_error, idempotencyKey: row.idempotency_key, createdAt: asNumber(row.created_at), updatedAt: asNumber(row.updated_at), completedAt: row.completed_at === null ? null : asNumber(row.completed_at) } : null; }
  async get(id) { return this.normalize((await this.pool.query('SELECT * FROM background_jobs WHERE id = $1', [id])).rows[0]); }
  async enqueue(value) {
    const row = (await this.pool.query(`INSERT INTO background_jobs (id,type,payload_json,status,attempts,max_attempts,available_at,idempotency_key,created_at,updated_at)
      VALUES ($1,$2,$3::jsonb,'queued',0,$4,$5,$6,$7,$8)
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING *`, [value.id, value.type, JSON.stringify(value.payload || {}), value.maxAttempts, value.availableAt, value.idempotencyKey, value.createdAt, value.updatedAt])).rows[0];
    return this.normalize(row);
  }
  async list(options = {}) { const params=[]; let where=''; if (options.status) { params.push(options.status); where='WHERE status=$1'; } params.push(Math.min(Math.max(Number(options.limit)||50,1),200)); return (await this.pool.query(`SELECT * FROM background_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params)).rows.map((row)=>this.normalize(row)); }
}

function createPostgresRepositories(options = {}) {
  return { users: new PostgresUserRepository(options), conversations: new PostgresConversationRepository(options), attachments: new PostgresAttachmentRepository(options), feedback: new PostgresFeedbackRepository(options), jobs: new PostgresJobRepository(options), publicUser };
}

module.exports = { createPostgresRepositories, PostgresUserRepository, PostgresConversationRepository, PostgresAttachmentRepository, PostgresFeedbackRepository, PostgresJobRepository, publicUser };
