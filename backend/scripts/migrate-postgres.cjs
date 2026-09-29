'use strict';

require('dotenv').config();
const { runPostgresMigrations, closePostgres } = require('../src/db/postgres.service');

runPostgresMigrations()
  .then((result) => { console.log(JSON.stringify(result, null, 2)); })
  .catch((error) => { console.error(`[db:postgres:migrate] ${error.message}`); process.exitCode = 1; })
  .finally(() => closePostgres());
