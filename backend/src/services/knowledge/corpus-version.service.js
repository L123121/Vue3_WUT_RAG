'use strict';

const { logEvent } = require('../observability/observability.service');

let corpusVersion = 0;

const getCorpusVersion = () => corpusVersion;

const bumpCorpusVersion = ({ reason = 'unknown', docId = null } = {}) => {
  corpusVersion += 1;
  logEvent('info', 'rag_corpus_version_bumped', {
    version: corpusVersion,
    reason,
    docId,
  });
  return corpusVersion;
};

const resetCorpusVersionForTest = (value = 0) => {
  corpusVersion = Math.max(0, Number(value) || 0);
  return corpusVersion;
};

module.exports = { bumpCorpusVersion, getCorpusVersion, resetCorpusVersionForTest };
