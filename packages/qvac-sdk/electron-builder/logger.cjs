const PREFIX = "[qvac:electron-builder]";

const EXPECTED_FS_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);

const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function getDefaultLevel() {
  const level = process.env.QVAC_LOG_LEVEL?.toLowerCase();
  return level && level in LOG_LEVELS ? level : "info";
}

let currentLevel = LOG_LEVELS[getDefaultLevel()];

function setLogLevel(level) {
  if (!(level in LOG_LEVELS)) {
    console.warn(
      `${PREFIX} Invalid log level "${level}", using "info". Valid: ${Object.keys(LOG_LEVELS).join(", ")}`
    );
    currentLevel = LOG_LEVELS.info;
    return;
  }
  currentLevel = LOG_LEVELS[level];
}

function format(message) {
  return `${PREFIX} ${message}`;
}

const logger = {
  error(message) {
    if (currentLevel >= LOG_LEVELS.error) {
      console.error(format(message));
    }
  },
  warn(message) {
    if (currentLevel >= LOG_LEVELS.warn) {
      console.warn(format(message));
    }
  },
  info(message) {
    if (currentLevel >= LOG_LEVELS.info) {
      console.log(format(message));
    }
  },
  debug(message) {
    if (currentLevel >= LOG_LEVELS.debug) {
      console.debug(format(message));
    }
  },

  /**
   * Logs an unexpected filesystem error (suppresses ENOENT, EACCES, etc.).
   * @param {string} context - Where the error occurred
   * @param {Error} err - The error object
   */
  fsError(context, err) {
    if (err && EXPECTED_FS_ERROR_CODES.has(err.code)) {
      // Expected FS errors are silently ignored
      return;
    }
    this.warn(`Unexpected error in ${context}: ${err?.message || err}`);
  },
};

module.exports = {
  logger,
  setLogLevel,
  LOG_LEVELS,
};
