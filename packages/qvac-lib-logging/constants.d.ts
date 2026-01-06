export interface LogLevels {
  readonly ERROR: "error";
  readonly WARN: "warn";
  readonly INFO: "info";
  readonly DEBUG: "debug";
  readonly OFF: "off";
}

export interface LevelPriorities {
  readonly [key: string]: number;
}

export const LOG_LEVELS: LogLevels;
export const DEFAULT_LEVEL: string;
export const LEVEL_PRIORITIES: LevelPriorities;
export const ENV_LOG_LEVEL: string;
