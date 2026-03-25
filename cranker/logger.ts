export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  loop: string;
  market?: string;
  message: string;
  data?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function emit(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;
  const line = JSON.stringify(entry);
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export function createLogger(loop: string) {
  return {
    debug(message: string, data?: Record<string, unknown>, market?: string): void {
      emit({ timestamp: new Date().toISOString(), level: "debug", loop, market, message, data });
    },
    info(message: string, data?: Record<string, unknown>, market?: string): void {
      emit({ timestamp: new Date().toISOString(), level: "info", loop, market, message, data });
    },
    warn(message: string, data?: Record<string, unknown>, market?: string): void {
      emit({ timestamp: new Date().toISOString(), level: "warn", loop, market, message, data });
    },
    error(message: string, data?: Record<string, unknown>, market?: string): void {
      emit({ timestamp: new Date().toISOString(), level: "error", loop, market, message, data });
    },
  };
}
