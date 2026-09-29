import { describe, expect, it } from 'vitest';

const { importSqliteToPostgres } = require('../src/db/sqlite-postgres-import');

function sqliteFixture() {
  const hashRows = [
    { key: 'conversations:user_a', field: 'conv_1', value: JSON.stringify({ id: 'conv_1', title: '会话', messages: [{ id: 'm1' }], createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' }) },
    { key: 'attachment:att_12345678901234567890', field: 'id', value: 'att_12345678901234567890' },
    { key: 'attachment:att_12345678901234567890', field: 'ownerUserId', value: 'user_a' },
    { key: 'attachment:att_12345678901234567890', field: 'storageName', value: 'upload-1-2.txt' },
    { key: 'attachment:att_12345678901234567890', field: 'objectKey', value: 'attachments/a/file.txt' },
    { key: 'attachment:att_12345678901234567890', field: 'originalName', value: 'a.txt' },
    { key: 'attachment:att_12345678901234567890', field: 'mimetype', value: 'text/plain' },
    { key: 'attachment:att_12345678901234567890', field: 'size', value: '1' },
    { key: 'attachment:att_12345678901234567890', field: 'isImage', value: 'false' },
    { key: 'attachment:att_12345678901234567890', field: 'createdAt', value: '1' },
    { key: 'attachment:att_12345678901234567890', field: 'expiresAt', value: '2' },
    { key: 'rag_feedback:all', field: 'user_a:conv_1:m1', value: JSON.stringify({ id: 'conv_1:m1', userId: 'user_a', conversationId: 'conv_1', messageId: 'm1', rating: 'like', sources: [] }) },
  ];
  return {
    prepare(sql) {
      return {
        all: () => {
          if (/SELECT \* FROM users/.test(sql)) return [{ id: 'user_a', username: 'alice', name: 'Alice', password_hash: 'scrypt$x$y', role: 'user', student_id: '', approved: 1, created_at: '2026-09-29T00:00:00.000Z' }];
          if (/SELECT \* FROM background_jobs/.test(sql)) return [{ id: 'job_1', type: 'audit', payload_json: '{}', status: 'queued', attempts: 0, max_attempts: 3, available_at: 1, locked_at: null, last_error: null, idempotency_key: null, created_at: 1, updated_at: 1, completed_at: null }];
          if (/FROM hash/.test(sql)) return hashRows;
          return [];
        },
      };
    },
  };
}

describe('SQLite → PostgreSQL importer', () => {
  it('导入用户、会话、Job、对象化附件和反馈', async () => {
    const queries = [];
    const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    const summary = await importSqliteToPostgres({ sqlite: sqliteFixture(), client, migrate: false });
    expect(summary).toEqual({ users: 1, conversations: 1, jobs: 1, attachments: 1, feedback: 1 });
    expect(queries.some((item) => item.sql.includes('INSERT INTO users'))).toBe(true);
    expect(queries.some((item) => item.sql.includes('INSERT INTO conversations'))).toBe(true);
    expect(queries.some((item) => item.sql.includes('INSERT INTO background_jobs'))).toBe(true);
    expect(queries.some((item) => item.sql.includes('INSERT INTO attachments'))).toBe(true);
    expect(queries.some((item) => item.sql.includes('INSERT INTO rag_feedback'))).toBe(true);
  });
});
