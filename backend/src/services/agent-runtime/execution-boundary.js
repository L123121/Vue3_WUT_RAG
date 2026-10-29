'use strict';

const path = require('path');

function isDedicatedWorker() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, '../../worker.js'));
}

module.exports = { isDedicatedWorker };
