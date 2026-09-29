'use strict';

const { runPostgresMigrations } = require('./postgres.service');

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

function collectHashRows(sqlite, prefix) {
  return sqlite.prepare('SELECT key, field, value FROM hash WHERE key = ? OR key LIKE ?').all(prefix, `${prefix}%`);
}

function groupedHash(rows) {
  const groups = new Map();
  for (const row of rows) {
    const value = asObject(row.value) ?? row.value;
    groups.set(row.key, { ...(groups.get(row.key) || {}), [row.field]: value });
  }
  return groups;
}

function collectConversations(sqlite) {
  return collectHashRows(sqlite, 'conversations:')
    .filter((row) => row.key.startsWith('conversations:'))
    .map((row) => ({ userId: row.key.slice('conversations:'.length), value: asObject(row.value) }))
    .filter((row) => row.userId && row.value?.id);
}

function collectAttachments(sqlite) {
  return [...groupedHash(collectHashRows(sqlite, 'attachment:')).entries()]
    .filter(([key]) => key.startsWith('attachment:'))
    .map(([, value]) => value)
    .filter((value) => value?.id);
}

function collectFeedback(sqlite) {
  return collectHashRows(sqlite, 'rag_feedback:all')
    .filter((row) => row.key === 'rag_feedback:all')
    .map((row) => asObject(row.value))
    .filter((value) => value?.id && value?.userId);
}

async function importSqliteToPostgres({ sqlite, client, migrate = true } = {}) {
  if (!sqlite) throw new Error('缺少 SQLite 数据库连接');
  if (!client) throw new Error('缺少 PostgreSQL client');
  if (migrate) await runPostgresMigrations({ client });
  const summary = { users: 0, conversations: 0, jobs: 0, attachments: 0, feedback: 0 };

  const users = sqlite.prepare('SELECT * FROM users').all();
  for (const user of users) {
    await client.query(`INSERT INTO users (id,username,name,password_hash,role,student_id,approved,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,student_id=EXCLUDED.student_id,approved=EXCLUDED.approved`, [user.id, user.username, user.name, user.password_hash, user.role, user.student_id, Boolean(user.approved), user.created_at]);
    summary.users += 1;
  }

  for (const { userId, value } of collectConversations(sqlite)) {
    await client.query(`INSERT INTO conversations (id,user_id,title,messages_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,title=EXCLUDED.title,messages_json=EXCLUDED.messages_json,updated_at=EXCLUDED.updated_at`, [value.id, userId, value.title || '新会话', JSON.stringify(value.messages || []), value.createdAt || new Date().toISOString(), value.updatedAt || value.createdAt || new Date().toISOString()]);
    summary.conversations += 1;
  }

  const jobs = sqlite.prepare('SELECT * FROM background_jobs').all();
  for (const job of jobs) {
    await client.query(`INSERT INTO background_jobs (id,type,payload_json,status,attempts,max_attempts,available_at,locked_at,last_error,idempotency_key,created_at,updated_at,completed_at)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,attempts=EXCLUDED.attempts,payload_json=EXCLUDED.payload_json,updated_at=EXCLUDED.updated_at`, [job.id, job.type, job.payload_json || '{}', job.status, job.attempts, job.max_attempts, job.available_at, job.locked_at, job.last_error, job.idempotency_key, job.created_at, job.updated_at, job.completed_at]);
    summary.jobs += 1;
  }

  for (const item of collectAttachments(sqlite)) {
    if (!item.objectKey) continue;
    await client.query(`INSERT INTO attachments (id,owner_user_id,conversation_id,storage_name,object_key,original_name,mimetype,size,is_image,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET object_key=EXCLUDED.object_key,expires_at=EXCLUDED.expires_at`, [item.id, item.ownerUserId, item.conversationId, item.storageName, item.objectKey, item.originalName, item.mimetype, item.size || 0, item.isImage === true, item.createdAt, item.expiresAt]);
    summary.attachments += 1;
  }

  for (const item of collectFeedback(sqlite)) {
    await client.query(`INSERT INTO rag_feedback (id,user_id,conversation_id,message_id,question_message_id,rating,question,answer,trace_id,sources_json,eval_status,eval_status_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
      ON CONFLICT (user_id,id) DO UPDATE SET rating=EXCLUDED.rating,question=EXCLUDED.question,answer=EXCLUDED.answer,sources_json=EXCLUDED.sources_json,eval_status=EXCLUDED.eval_status,eval_status_at=EXCLUDED.eval_status_at`, [item.id, item.userId, item.conversationId, item.messageId, item.questionMessageId || '', item.rating, item.question || '', item.answer || '', item.traceId || '', JSON.stringify(item.sources || []), item.evalStatus || null, item.evalStatusAt || null, item.createdAt || new Date().toISOString()]);
    summary.feedback += 1;
  }

  return summary;
}

module.exports = { importSqliteToPostgres, collectConversations, collectAttachments, collectFeedback };
