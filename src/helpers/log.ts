/* eslint-disable no-console */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFunction = {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
};

export type LogOptions = {
  colors?: boolean;
  level?: LogLevel;
  timestamp?: boolean;
};

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  error: 3,
  info: 1,
  warn: 2
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\u001b[36m', // cyan
  error: '\u001b[31m', // red
  info: '\u001b[32m', // green
  warn: '\u001b[33m' // yellow
};

const RESET_COLOR = '\u001b[0m';

export const createLog = (
  prefix: string = '',
  options: LogOptions = {}
): LogFunction => {
  const { colors = true, level = 'info', timestamp = true } = options;

  const currentLevel = LOG_LEVELS[level];

  const formatMessage = (logLevel: LogLevel, message: string): string => {
    const parts: string[] = [];

    if (timestamp) {
      parts.push(new Date().toISOString());
    }

    if (prefix) {
      parts.push(`[${prefix}]`);
    }

    parts.push(`[${logLevel.toUpperCase()}]`, message);

    return parts.join(' ');
  };

  const log = (
    logLevel: LogLevel,
    message: string,
    ...args: unknown[]
  ): void => {
    if (LOG_LEVELS[logLevel] < currentLevel) {
      return;
    }

    const formattedMessage = formatMessage(logLevel, message);

    if (colors) {
      const color = LOG_COLORS[logLevel];
      console.log(`${color}${formattedMessage}${RESET_COLOR}`, ...args);
    } else {
      console.log(formattedMessage, ...args);
    }
  };

  return {
    debug: (message: string, ...args: unknown[]) =>
      log('debug', message, ...args),
    error: (message: string, ...args: unknown[]) =>
      log('error', message, ...args),
    info: (message: string, ...args: unknown[]) =>
      log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args)
  };
};
