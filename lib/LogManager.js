'use strict';

const fs = require('fs');
const path = require('path');

const SETTING_DEBUG_LOGGING = 'debug_logging_enabled';
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const MAX_LOG_FILES = 3; // app_debug.log, app_debug.1.log, app_debug.2.log
const MAX_QUEUE_SIZE = 2000;
const BASE_LOG_FILENAME = 'app_debug.log';

/**
 * Manages persistent, rotatable diagnostic logging for Homey Pro apps.
 */
class LogManager {
  /**
   * Initializes LogManager with app context.
   *
   * @public
   * @param {import('homey').App} app - The Homey App instance.
   */
  constructor(app) {
    this._app = app;
    this._isDebugEnabled = false;
    this._logDirectory = this._resolveLogDirectory();
    this._isWriting = false;
    this._writeQueue = [];
  }

  /**
   * Initializes the logger directory and reads saved debug setting.
   *
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * const logManager = new LogManager(this);
   * await logManager.init();
   */
  async init() {
    try {
      this._ensureLogDirectory();
      const savedSetting = this._app.homey.settings.get(SETTING_DEBUG_LOGGING);
      this._isDebugEnabled = Boolean(savedSetting);
      this._app.log(`[LogManager:init] Target log directory: ${this._logDirectory}`);
      this._app.log(`[LogManager:init] Debug logging is currently ${this._isDebugEnabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (error) {
      this._app.error('[LogManager:init] Failed to initialize LogManager:', error.message || error);
    }
  }

  /**
   * Checks if debug logging is currently enabled.
   *
   * @public
   * @returns {boolean} True if debug logging is active.
   * @example
   * if (logManager.isDebugEnabled()) { ... }
   */
  isDebugEnabled() {
    return this._isDebugEnabled;
  }

  /**
   * Updates debug logging state and persists it to Homey settings.
   *
   * @public
   * @async
   * @param {boolean} enabled - True to enable, false to disable.
   * @returns {Promise<boolean>} The updated debug state.
   * @example
   * await logManager.setDebugEnabled(true);
   */
  async setDebugEnabled(enabled) {
    this._isDebugEnabled = Boolean(enabled);
    this._app.homey.settings.set(SETTING_DEBUG_LOGGING, this._isDebugEnabled);
    this._app.log(`[LogManager:setDebugEnabled] Debug logging state changed to: ${this._isDebugEnabled}`);
    if (this._isDebugEnabled) {
      this.writeLog('INFO', 'LogManager:setDebugEnabled', 'Debug logging has been enabled by user.');
    }
    return this._isDebugEnabled;
  }

  /**
   * Enqueues a formatted, sanitized log message for background disk writing.
   *
   * @public
   * @param {string} level - Log level ('INFO', 'DEBUG', 'WARN', 'ERROR').
   * @param {string} tag - Context identifier (e.g. 'ClassName:methodName').
   * @param {any} message - Log payload (string, object, error).
   * @returns {void}
   * @example
   * logManager.writeLog('DEBUG', 'DeviceManager:sync', 'Processed device update');
   */
  writeLog(level, tag, message) {
    if (!this._isDebugEnabled && level === 'DEBUG') return;
    if (message === null || message === undefined) return;

    let textContent;
    if (message instanceof Error) {
      textContent = `${message.message || ''}${message.stack ? `\n${message.stack}` : ''}`;
    } else if (typeof message === 'object') {
      try {
        textContent = JSON.stringify(message);
      } catch (e) {
        textContent = String(message);
      }
    } else {
      textContent = String(message);
    }
    if (!textContent || textContent === 'null' || textContent === 'undefined') return;

    const timestamp = new Date().toISOString();
    textContent = this._sanitize(textContent);
    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${textContent}\n`;

    if (this._isDebugEnabled || level === 'ERROR' || level === 'WARN') {
      this._enqueueWrite(logLine);
    }
  }

  /**
   * Clears the in-memory write buffer.
   *
   * @public
   * @returns {void}
   * @example
   * logManager.clearWriteQueue();
   */
  clearWriteQueue() {
    this._writeQueue = [];
  }

  /**
   * Returns the absolute path of a log file by its rotation index.
   *
   * @public
   * @param {number} index - The rotation index (0 for active, 1+ for backups).
   * @returns {string} The absolute path to the log file.
   * @example
   * const path = logManager.getLogFilePath(0);
   */
  getLogFilePath(index) {
    return this._getLogFilePath(index);
  }

  /**
   * Clears and deletes all stored log files and resets the write buffer.
   *
   * @public
   * @async
   * @returns {Promise<boolean>} True if all log files were cleared.
   * @example
   * await logManager.clearLogs();
   */
  async clearLogs() {
    try {
      this._writeQueue = [];
      for (let i = 0; i < MAX_LOG_FILES; i++) {
        const filePath = this._getLogFilePath(i);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }
      this._app.log('[LogManager:clearLogs] All diagnostic log files cleared successfully.');
      return true;
    } catch (error) {
      this._app.error('[LogManager:clearLogs] Failed to clear log files:', error.message || error);
      throw error;
    }
  }

  /**
   * Resolves the persistent log directory (/userdata on Homey runtime).
   *
   * @private
   * @returns {string} Absolute directory path.
   */
  _resolveLogDirectory() {
    if (fs.existsSync('/userdata')) return '/userdata';
    if (this._app.homey && this._app.homey.dir) {
      return path.join(this._app.homey.dir, 'userdata');
    }
    return path.join(process.cwd(), 'userdata');
  }

  /**
   * Ensures the persistent log directory exists on disk.
   *
   * @private
   * @returns {void}
   */
  _ensureLogDirectory() {
    if (!fs.existsSync(this._logDirectory)) {
      try {
        fs.mkdirSync(this._logDirectory, { recursive: true });
      } catch (err) {
        // Ignored if directory already exists
      }
    }
  }

  /**
   * Generates file path for given rotation index.
   *
   * @private
   * @param {number} index - Rotation index.
   * @returns {string} File path.
   */
  _getLogFilePath(index) {
    if (index === 0) return path.join(this._logDirectory, BASE_LOG_FILENAME);
    return path.join(this._logDirectory, `app_debug.${index}.log`);
  }

  /**
   * Enqueues a line to write buffer and triggers async processing.
   *
   * @private
   * @param {string} line - Formatted log line.
   * @returns {void}
   */
  _enqueueWrite(line) {
    this._writeQueue.push(line);
    if (this._writeQueue.length > MAX_QUEUE_SIZE) {
      this._writeQueue.splice(0, this._writeQueue.length - MAX_QUEUE_SIZE);
    }
    this._scheduleProcessing();
  }

  /**
   * Schedules queue processing on next tick using setImmediate to avoid blocking the event loop.
   *
   * @private
   * @returns {void}
   */
  _scheduleProcessing() {
    if (this._isWriting) return;
    this._isWriting = true;

    setImmediate(async () => {
      try {
        await this._processWriteQueue();
      } catch (err) {
        this._app.error('[LogManager:_scheduleProcessing] Error writing log batch:', err.message || err);
      } finally {
        this._isWriting = false;
        if (this._writeQueue.length > 0) {
          this._scheduleProcessing();
        }
      }
    });
  }

  /**
   * Processes all queued log lines in chunks of up to 100 lines.
   *
   * @private
   * @async
   * @returns {Promise<void>}
   */
  async _processWriteQueue() {
    if (this._writeQueue.length === 0) return;
    this._ensureLogDirectory();
    const activeFilePath = this._getLogFilePath(0);

    while (this._writeQueue.length > 0) {
      await this._checkAndRotateFile(activeFilePath);
      const batch = this._writeQueue.splice(0, 100).join('');
      await fs.promises.appendFile(activeFilePath, batch, 'utf8');
      await this._checkAndRotateFile(activeFilePath);
    }
  }

  /**
   * Checks active file size and triggers rotation when exceeding MAX_FILE_SIZE_BYTES.
   *
   * @private
   * @async
   * @param {string} activeFilePath - Path to active log file.
   * @returns {Promise<void>}
   */
  async _checkAndRotateFile(activeFilePath) {
    try {
      if (!fs.existsSync(activeFilePath)) return;
      const stats = await fs.promises.stat(activeFilePath).catch(() => null);
      if (!stats || stats.size < MAX_FILE_SIZE_BYTES) return;

      const oldestIndex = MAX_LOG_FILES - 1;
      const oldestPath = this._getLogFilePath(oldestIndex);
      if (fs.existsSync(oldestPath)) await fs.promises.unlink(oldestPath).catch(() => {});

      for (let i = oldestIndex - 1; i >= 1; i--) {
        const currentPath = this._getLogFilePath(i);
        const nextPath = this._getLogFilePath(i + 1);
        if (fs.existsSync(currentPath)) {
          if (fs.existsSync(nextPath)) await fs.promises.unlink(nextPath).catch(() => {});
          await fs.promises.rename(currentPath, nextPath).catch(() => {});
        }
      }

      const firstBackupPath = this._getLogFilePath(1);
      if (fs.existsSync(firstBackupPath)) await fs.promises.unlink(firstBackupPath).catch(() => {});
      await fs.promises.rename(activeFilePath, firstBackupPath).catch(() => {});
    } catch (error) {
      this._app.error('[LogManager:_checkAndRotateFile] Error during rotation:', error.message || error);
    }
  }

  /**
   * Sanitizes a string or text payload by masking Bearer tokens, credentials,
   * session IDs, Athom ObjectIds, emails, and GPS coordinates.
   *
   * @public
   * @static
   * @param {string} text - Input text to sanitize.
   * @returns {string} Sanitized string safe for logging.
   * @example
   * const cleanText = LogManager.sanitize('Bearer secret123 lat=45.1 lng=9.2');
   * // → 'Bearer ***MASKED*** lat="***" lng="***"'
   */
  static sanitize(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      // 1. Mask Bearer authorization tokens (with optional base64 padding)
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***MASKED***')
      // 2. Mask sensitive credential fields (passwords, tokens, secrets, session IDs, API keys)
      .replace(/\b(password|client_secret|client_id|access_token|refresh_token|id_token|session_token|session_id|sessionId|api_key|apiKey|token|secret|auth_code|authorization_code)(["']?\s*[:=]\s*["']?)([^"'\s&,;]{1,500})(["']?)/gi, '$1$2***MASKED***$4')
      // 3. Mask OAuth authorization codes in URL query strings (?code=... or &code=...)
      .replace(/([?&]code=)[^"'\s&,;]+/gi, '$1***MASKED***')
      // 4. Mask 64-character hex session tokens (keep first 8 chars for log correlation)
      .replace(/\b([0-9a-fA-F]{8})[0-9a-fA-F]{56}\b/g, '$1...***')
      // 5. Mask 24-character Athom/Homey ObjectIds (keep 4-char prefix & suffix for debugging)
      .replace(/\b(homeyId|athomId|userId|user_id|owner_id|hub_id)(["']?\s*[:=]\s*["']?)([0-9a-fA-F]{4})[0-9a-fA-F]{16}([0-9a-fA-F]{4})(["']?)/gi, '$1$2$3***$4$5')
      // 6. Mask email addresses
      .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,10}\b/gi, '***@***.***')
      // 7. Mask GPS latitude coordinates (both plain text lat=... and JSON "lat": ..., preserving JSON syntax)
      .replace(/(["']?(?:lat|latitude)["']?\s*[:=]\s*)["']?-?\d+(?:\.\d+)?["']?/gi, '$1"***"')
      // 8. Mask GPS longitude coordinates (fixed precedence bug and JSON syntax preservation)
      .replace(/(["']?(?:lng|long|longitude)["']?\s*[:=]\s*)["']?-?\d+(?:\.\d+)?["']?/gi, '$1"***"');
  }

  /**
   * Sanitizes log line text to mask Bearer tokens, secrets, emails, and coordinates.
   * Delegates to static {@link LogManager.sanitize}.
   *
   * @private
   * @param {string} text - Input text.
   * @returns {string} Sanitized text safe for logging.
   * @example
   * const safe = this._sanitize('Bearer xyz');
   */
  _sanitize(text) {
    return LogManager.sanitize(text);
  }
}

module.exports = LogManager;
