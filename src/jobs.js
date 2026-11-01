'use strict';
async function runJob(logger, name, fn) {
  const t0 = Date.now();
  try {
    logger.debug('job started', { job: name });
    const result = await fn();
    logger.debug('job finished', { job: name, durationMs: Date.now() - t0 });
    return { ok: true, result };
  } catch (err) {
    logger.error('background job failed', { job: name, durationMs: Date.now() - t0, err });
    return { ok: false, error: err };
  }
}
function schedule(logger, name, intervalMs, fn) {
  const timer = setInterval(() => { runJob(logger, name, fn); }, intervalMs);
  timer.unref();
  return timer;
}
module.exports = { runJob, schedule };
