'use strict';

const { isPostgresEnabled } = require('../db/postgres.service');
const { createPostgresRepositories } = require('./postgres.repositories');

let repositories = null;

function getRepositories(options = {}) {
  if (options.repositories) return options.repositories;
  if (!isPostgresEnabled()) return null;
  if (!repositories) repositories = createPostgresRepositories(options);
  return repositories;
}

function getRepositoryBackend() {
  return isPostgresEnabled() ? 'postgres' : 'sqlite';
}

function resetRepositoriesForTests() { repositories = null; }

module.exports = { getRepositories, getRepositoryBackend, resetRepositoriesForTests };
