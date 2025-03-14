import winston from 'winston';

const { format } = winston;

const customConsoleFormat = format.combine(
  // format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.printf(
    (info) => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}${info.stack ? `\nStack: ${info.stack}` : ''}`
  )
);

const logger = winston.createLogger({
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    verbose: 3,
    debug: 4,
  },
  format: format.combine(
    // format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'crypto-trading-bot' },
  transports: [
    new winston.transports.Console({
      format: customConsoleFormat,
    }),
    new winston.transports.File({
      filename: 'application.log',
      level: 'debug',
    }),
  ],
});

// Handle process-level warnings and errors
process.on('warning', (e) => {
  logger.warn(`Warning:`);
  logger.warn(e.stack);
  console.warn(e);
});

process.on('unhandledRejection', (ex) => {
  logger.error(`Unhandled rejection:`);
  logger.error(ex.stack);
  console.error(ex);
});

process.on('uncaughtException', (ex) => {
  logger.error(`Uncaught exception:`);
  logger.error(ex.stack);
  console.error(ex);
  process.exit(1);
});

export default logger;
