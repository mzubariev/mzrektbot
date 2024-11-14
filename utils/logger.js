import winston from 'winston';
const { format } = winston;

const logger = winston.createLogger({
  levels : {
    error   : 0,
    warn    : 1,
    info    : 2,
    verbose : 3,
    debug   : 4
  },
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'crypto-trading-bot' },
  transports: [
    new winston.transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(
          info => `${info.timestamp} ${info.level}: ${info.message}`,
          debug => `${debug.timestamp} ${debug.level}: ${debug.message}`,
          warn => `${warn.timestamp} ${warn.level}: ${warn.message}`,
          error => `${error.timestamp} ${inerrorfo.level}: ${error.message}`
        )
      )
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

process.on('warning', (e) => {
  logger.error('Warning: %j', e);
  logger.error(e.stack);
});

// Log unhandled promise rejections
process.on('unhandledRejection', (ex) => {
  logger.error('Unhandled rejection: %j', ex);
  logger.error(ex.stack);
  throw ex;
});

// Log uncaught exceptions
process.on('uncaughtException', (ex) => {
  logger.error('Uncaught exception: %j', ex);
  logger.error(ex.stack);
  process.exit(1);
});

export default logger;
