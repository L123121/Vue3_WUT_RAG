'use strict';

const { runMigrations } = require('../src/db/migration-runner');

try {
  const result = runMigrations();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[db:migrate] 迁移失败: ${error.message}`);
  process.exit(1);
}
