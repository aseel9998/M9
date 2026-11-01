'use strict';
const pkg = require('../package.json');
module.exports = { VERSION: pkg.version, BUILD: process.env.BUILD_ID || 'dev' };
