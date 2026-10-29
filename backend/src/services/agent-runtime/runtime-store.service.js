'use strict';

const { getDatabasePath, runMigrations } = require('../../db/migration-runner');
const { isPostgresEnabled, getPool } = require('../../db/postgres.service');
const { runtimeError } = require('./runtime-values');

const unpack = row => row ? { revision: Number(row.revision), value: { ...JSON.parse(row.state_json), ...(row.generation !== undefined ? { generation: row.generation } : {}) } } : null;

class AgentRuntimeStore {
  constructor({ dbPath, database, pool, backend } = {}) {
    this.backend = backend || (pool || isPostgresEnabled() ? 'postgres' : 'sqlite');
    this.pool = pool;
    this.dbPath = dbPath;
    this.database = database;
  }

  db() {
    if (!this.database) {
      const dbPath = getDatabasePath({ dbPath: this.dbPath });
      runMigrations({ dbPath });
      this.database = new (require('better-sqlite3'))(dbPath);
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('busy_timeout = 5000');
    }
    return this.database;
  }

  async query(sql, args = []) {
    if (this.backend === 'postgres') {
      let index = 0;
      const converted = sql.replace(/\?/g, () => `$${++index}`);
      return (this.pool || getPool()).query(converted, args);
    }
    const statement = this.db().prepare(sql);
    if (/^\s*SELECT/i.test(sql)) {
      const rows = statement.all(...args);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...args);
    return { rows: [], rowCount: result.changes };
  }

  serialize(value) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw runtimeError('运行状态超过存储上限', 'STATE_TOO_LARGE', 409);
    return json;
  }

  async getRun(id) {
    return unpack((await this.query('SELECT generation, revision, state_json FROM agent_runs WHERE id = ?', [id])).rows[0]);
  }

  async createRun(run) {
    const sql = `INSERT INTO agent_runs
      (id, owner_id, generation, revision, status, available_at, lease_until, state_json, created_at, updated_at)
      SELECT ?, ?, ?, 1, ?, ?, 0, ?, ?, ? WHERE (SELECT COUNT(*) FROM agent_runs WHERE owner_id = ?) < 50
      ON CONFLICT (id) DO NOTHING`;
    const args = [run.id, run.ownerId, run.generation, run.status, run.availableAt, this.serialize(run), run.createdAt, run.updatedAt, run.ownerId];
    if (this.backend !== 'postgres') return (await this.query(sql, args)).rowCount === 1;
    const client = await (this.pool || getPool()).connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-quota:${run.ownerId}`]);
      let index = 0;
      const result = await client.query(sql.replace(/\?/g, () => `$${++index}`), args);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async saveRun(record, run) {
    if (run.generation !== record.value.generation) return false;
    const result = await this.query(`UPDATE agent_runs SET revision = revision + 1, status = ?, available_at = ?,
      lease_until = ?, lease_token = ?, state_json = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ? AND generation = ?`,
    [run.status, run.availableAt, run.lease?.until || 0, run.lease?.token || '', this.serialize(run), run.updatedAt, run.id, run.ownerId, record.revision, record.value.generation]);
    return result.rowCount === 1;
  }

  async listRuns(ownerId) {
    const result = await this.query('SELECT generation, revision, state_json FROM agent_runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 51', [ownerId]);
    return result.rows.map(unpack);
  }

  async dueRuns(now, limit = 8) {
    const result = await this.query(`SELECT generation, revision, state_json FROM agent_runs
      WHERE status NOT IN ('completed', 'cancelled', 'expired')
      AND available_at <= ? AND lease_until <= ? ORDER BY available_at ASC, created_at ASC LIMIT ?`, [now, now, limit]);
    return result.rows.map(unpack);
  }

  async removeRun(record) {
    const sql = 'DELETE FROM agent_runs WHERE id = ? AND owner_id = ? AND revision = ? AND generation = ?';
    const args = [record.value.id, record.value.ownerId, record.revision, record.value.generation];
    const keys = record.value.steps.map(step => `${record.value.id}:${step.id}`);
    if (this.backend !== 'postgres') {
      const db = this.db();
      return db.transaction(() => {
        if (db.prepare(sql).run(...args).changes !== 1) return false;
        const remove = db.prepare("DELETE FROM agent_runtime_kv WHERE namespace = 'artifact' AND entry_key = ?");
        for (const key of keys) remove.run(key);
        return true;
      })();
    }
    const client = await (this.pool || getPool()).connect();
    try {
      await client.query('BEGIN');
      let index = 0;
      const deleted = await client.query(sql.replace(/\?/g, () => `$${++index}`), args);
      if (deleted.rowCount === 1) {
        for (const key of keys) await client.query("DELETE FROM agent_runtime_kv WHERE namespace = 'artifact' AND entry_key = $1", [key]);
      }
      await client.query('COMMIT');
      return deleted.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async getValue(namespace, key) {
    return unpack((await this.query('SELECT revision, state_json FROM agent_runtime_kv WHERE namespace = ? AND entry_key = ?', [namespace, key])).rows[0]);
  }

  async setValue(namespace, key, before, value) {
    const json = this.serialize(value);
    if (!before) {
      return (await this.query(`INSERT INTO agent_runtime_kv (namespace, entry_key, revision, state_json)
        VALUES (?, ?, 1, ?) ON CONFLICT (namespace, entry_key) DO NOTHING`, [namespace, key, json])).rowCount === 1;
    }
    return (await this.query(`UPDATE agent_runtime_kv SET revision = revision + 1, state_json = ?
      WHERE namespace = ? AND entry_key = ? AND revision = ?`, [json, namespace, key, before.revision])).rowCount === 1;
  }

  async saveArtifactIfActive(key, value, guard, now) {
    if (!guard?.generation || !guard.leaseToken || guard.runId !== value.runId || guard.ownerId !== value.ownerId || guard.generation !== value.generation) throw runtimeError('产物缺少执行器凭据', 'LEASE_LOST', 409);
    const result = await this.query(`INSERT INTO agent_runtime_kv (namespace, entry_key, revision, state_json)
      SELECT 'artifact', ?, 1, ? WHERE EXISTS (
        SELECT 1 FROM agent_runs WHERE id = ? AND owner_id = ? AND revision = ? AND generation = ? AND lease_token = ? AND status = 'running' AND lease_until > ?
      ) AND COALESCE((SELECT revision FROM agent_runtime_kv WHERE namespace = 'policy' AND entry_key = 'tools'), 0) = ?
      ON CONFLICT (namespace, entry_key) DO NOTHING`,
    [key, this.serialize(value), guard.runId, guard.ownerId, guard.revision, guard.generation, guard.leaseToken, now, guard.policyVersion]);
    return result.rowCount === 1;
  }

  async deleteValue(namespace, key) {
    await this.query('DELETE FROM agent_runtime_kv WHERE namespace = ? AND entry_key = ?', [namespace, key]);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

let store;
const getAgentRuntimeStore = () => (store ||= new AgentRuntimeStore());

module.exports = { AgentRuntimeStore, getAgentRuntimeStore };
