'use strict';
function installProcessHandlers(logger, { onShutdown } = {}) {
  let shuttingDown = false;
  process.on('uncaughtException', (err, origin) => {
    logger.critical('uncaught exception', { err, origin });
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    logger.critical('unhandled promise rejection', { err: reason instanceof Error ? reason : { message: String(reason) } });
    process.exit(1);
  });
  process.on('warning', w => logger.warn('node warning', { name: w.name, message: w.message }));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutdown requested', { signal });
      const timer = setTimeout(() => { logger.error('shutdown timed out, forcing exit'); process.exit(1); }, 10000);
      timer.unref();
      Promise.resolve(onShutdown && onShutdown())
        .then(() => { logger.info('shutdown complete'); process.exit(0); })
        .catch(err => { logger.error('shutdown failed', { err }); process.exit(1); });
    });
  }
  process.on('exit', code => logger.info('process exit', { code }));
}
module.exports = { installProcessHandlers };
