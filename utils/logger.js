import winston from 'winston';

const { format } = winston;

const customConsoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(
    (info) => `${info.timestamp} [${info.level}]: ${info.message}${info.stack ? `\nStack: ${info.stack}` : ''}`
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
    // format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
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
  logger.warn('Warning: %j', e);
  logger.warn(e.stack);
});

process.on('unhandledRejection', (ex) => {
  logger.error('Unhandled rejection: %j', ex);
  logger.error(ex.stack);
});

process.on('uncaughtException', (ex) => {
  logger.error('Uncaught exception: %j', ex);
  logger.error(ex.stack);
  process.exit(1);
});

export default logger;
