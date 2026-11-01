'use strict';
// Offline diagnostics: reads the log files on disk, works even when the server is down.
//   node src/cli.js diagnostics [--out report.json]
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const { Logger } = require('./logger');
const { Auth } = require('./auth');
const { Settings } = require('./settings');
const { buildReport } = require('./diagnostics');

function run(argv) {
  if (argv[0] !== 'diagnostics') {
    process.stderr.write('usage: node src/cli.js diagnostics [--out file.json]\n');
    return 2;
  }
  let config;
  try { config = loadConfig(process.env); } catch (err) {
    if (err instanceof ConfigError) { process.stderr.write('Configuration problems:\n - ' + err.problems.join('\n - ') + '\n'); return 1; }
    throw err;
  }
  const logger = new Logger({ dir: path.join(config.dataDir, 'logs'), level: 'CRITICAL', maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles, stdout: false });
  const settings = new Settings({ dir: config.dataDir, logger, envPrefix: config.transportPathPrefix, panelPath: config.panelPath });
  const report = buildReport({ config, logger, authStatus: () => Auth.statusOf(config.dataDir), settings });
  const text = JSON.stringify(report, null, 2);
  const i = argv.indexOf('--out');
  if (i !== -1 && argv[i + 1]) { fs.writeFileSync(argv[i + 1], text, { mode: 0o600 }); process.stdout.write(`written to ${argv[i + 1]}\n`); } else process.stdout.write(text + '\n');
  return 0;
}

if (require.main === module) process.exit(run(process.argv.slice(2)));
module.exports = { run };
