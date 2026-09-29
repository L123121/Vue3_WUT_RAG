'use strict';

require('dotenv').config();
const { getDatabasePath } = require('../src/db/migration-runner');
const { getPool, closePostgres } = require('../src/db/postgres.service');
const { importSqliteToPostgres } = require('../src/db/sqlite-postgres-import');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('请设置 DATABASE_URL');
  const Database = require('better-sqlite3');
  const sqlite = new Database(process.env.SQLITE_DB_PATH || getDatabasePath(), { readonly: true });
  const pool = getPool({ pool: new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL }) });
  const client = await pool.connect();
  try {
    const summary = await importSqliteToPostgres({ sqlite, client });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
    await closePostgres();
  }
}

main().catch((error) => {
  console.error(`[import-sqlite-to-postgres] ${error.message}`);
  process.exit(1);
});
