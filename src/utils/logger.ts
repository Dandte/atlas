// ═══════════════════════════════════════
// ATLAS — Logger (Winston)
// ═══════════════════════════════════════

import winston from 'winston';
import path from 'path';

const logsDir = path.resolve(__dirname, '..', '..', 'data', 'logs');
const isProd = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'atlas' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'atlas.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

export default logger;

/** Create a child logger with a module label for filtering */
export function createLogger(module: string): winston.Logger {
  return logger.child({ module });
}
