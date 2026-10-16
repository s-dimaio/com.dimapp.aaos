'use strict';

const Homey = require('homey');

const LogManager = require('./lib/LogManager');

/** @constant {string} TAG - Log tag used in all messages emitted by this class. */
const TAG = 'HomeyAaosCompanionApp';

/**
 * @constant {number} SESSION_TTL_MS
 * How long an auth session is kept alive before being considered expired, in milliseconds.
 */
const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * @constant {number} MAX_PENDING_SESSIONS
 * Maximum number of concurrent pending authentication sessions kept in memory.
 */
const MAX_PENDING_SESSIONS = 3;

/**
 * @constant {number} RATE_LIMIT_AUTH_START_MAX
 * Maximum allowed invocations of startAuth within the sliding window.
 */
const RATE_LIMIT_AUTH_START_MAX = 5;

/**
 * @constant {number} RATE_LIMIT_AUTH_START_WINDOW_MS
 * Duration of the sliding rate limiting window for startAuth (5 minutes in milliseconds).
 */
const RATE_LIMIT_AUTH_START_WINDOW_MS = 5 * 60 * 1000;

/**
 * @constant {number} RATE_LIMIT_AUTH_REFRESH_MAX
 * Maximum allowed invocations of refreshAuth within the sliding window.
 */
const RATE_LIMIT_AUTH_REFRESH_MAX = 10;

/**
 * @constant {number} RATE_LIMIT_AUTH_REFRESH_WINDOW_MS
 * Duration of the sliding rate limiting window for refreshAuth (5 minutes in milliseconds).
 */
const RATE_LIMIT_AUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * @constant {string} ATHOM_TOKEN_URL
 * Athom Cloud OAuth2 token endpoint used to exchange the authorization code for tokens.
 */
const ATHOM_TOKEN_URL = 'https://api.athom.com/oauth2/token';

/**
 * Main application class for the Homey AAOS Companion app.
 *
 * This app acts as an OAuth2 relay between the HomeyAutomotive Android Automotive OS
 * application and the Athom Cloud. It exposes two public HTTP API endpoints (no token
 * required) that the AAOS app uses to bootstrap the OAuth2 Authorization Code flow:
 *
 *  - `POST /auth/start`  → Creates a new auth session via `createOAuth2Callback` and
 *                          returns the Athom authorization URL to be shown as a QR code.
 *  - `GET  /auth/poll`   → Returns the current state of the session. When the user has
 *                          authorized the app on their phone, the access and refresh tokens
 *                          are included in the response and the session is immediately deleted.
 *
 * Sessions are kept in memory (a plain `Map`) and automatically pruned after `SESSION_TTL_MS`.
 *
 * @extends {Homey.App}
 * @example
 * // This class is instantiated automatically by the Homey runtime. No manual
 * // instantiation is required.
 */
class HomeyAaosCompanionApp extends Homey.App {

  /**
   * Map of active auth sessions keyed by sessionId.
   * Each entry has shape:
   * ```js
   * {
   *   authUrl: string,              // The Athom authorization URL to show as QR
   *   status:  'pending'|'complete'|'error',
   *   token:   object|null,         // access_token, refresh_token, expires_in (when complete)
   *   timer:   TimeoutId,           // auto-cleanup handle
   *   oauthCallback: object|null    // Homey Cloud OAuth2 callback object for listener cleanup
   * }
   * ```
   * @private
   * @type {Map<string, object>}
   */
  _sessions = new Map();

  /**
   * In-memory sliding window rate limiter timestamp log keyed by action identifier.
   * @private
   * @type {Map<string, number[]>}
   */
  _rateLimits = new Map();

  /**
   * Cached identifier of the HomeyScript execution proxy script.
   * @private
   * @type {string|null}
   */
  _homeyScriptProxyId = null;

  /**
   * Internal guard preventing recursive logging during LogManager operations.
   * @private
   * @type {boolean}
   */
  _isLoggingInternal = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Called by Homey when the app starts.
   *
   * @public
   * @returns {Promise<void>}
   */
  async onInit() {
    this._logManager = new LogManager(this);
    await this._logManager.init();

    this.log(`[${TAG}:onInit] Homey AAOS Companion App v${this.manifest.version} initialized.`);

    const homeDevices = this.homey.settings.get('home_devices_ids') || [];
    const geofenceDevices = this.homey.settings.get('geofence_device_ids') || [];
    const thermometersConfig = this.homey.settings.get('thermometers_config') || {};
    this.log(`[${TAG}:onInit] Stored configuration: home_devices=${homeDevices.length}, geofence_devices=${geofenceDevices.length}, thermometers=${Object.keys(thermometersConfig).length}`);

    try {
      const lat = this.homey.geolocation.getLatitude();
      const lng = this.homey.geolocation.getLongitude();
      this.log(`[${TAG}:onInit] Home location configured: lat=***, lng=***`);
    } catch (err) {
      this.log(`[${TAG}:onInit] Home location not configured or unavailable: ${err.message}`);
    }

    const isDebug = this.isDebugLoggingEnabled();
    this.log(`[${TAG}:onInit] Debug logging is ${isDebug ? 'ENABLED' : 'DISABLED'}.`);

    this.homey.settings.on('set', async (key) => {
      if (key === 'debug_logging_enabled') {
        const state = this.isDebugLoggingEnabled();
        if (this._logManager) {
          await this._logManager.setDebugEnabled(state);
        }
        this.log(`[${TAG}:onInit] Debug logging state changed: ${state ? 'ENABLED' : 'DISABLED'}`);
      }
    });
  }

  // ── Public Methods (called from api.js) ────────────────────────────────────

  /**
   * Creates a new OAuth2 auth session for a given sessionId.
   *
   * Enforces sliding window rate limiting (max 5 requests per 5 minutes) and memory pool
   * constraints (maximum 3 concurrent sessions). Internally calls `this.homey.cloud.createOAuth2Callback(baseAuthUrl)`.
   * Athom replaces the `redirect_uri` with `https://callback.athom.com/oauth2/callback/{TOKEN}`
   * and emits:
   *  - `url`  → the modified authorization URL (to be shown as QR code on the car screen)
   *  - `code` → the authorization code once the user has granted access
   *
   * @public
   * @param {string} sessionId - A 64-character hex string generated with SecureRandom by the
   *                             AAOS app. Used as a unique session identifier.
   * @returns {Promise<{authUrl: string}>} The authorization URL to display as QR code.
   * @throws {Error} If rate limit is exceeded (HTTP 429), sessionId is missing (HTTP 400), or OAuth callback creation fails.
   * @example
   * // Called from api.js:
   * const { authUrl } = await homey.app.startAuthSession('a1b2c3...');
   */
  async startAuthSession(sessionId) {
    // 1. Enforce sliding window rate limit (max 5 requests per 5 minutes)
    this._checkRateLimit('auth_start', RATE_LIMIT_AUTH_START_MAX, RATE_LIMIT_AUTH_START_WINDOW_MS);

    if (!sessionId || typeof sessionId !== 'string') {
      throw Object.assign(new Error('Missing or invalid sessionId.'), { statusCode: 400 });
    }

    // 2. Invalidate any pre-existing session for this ID
    this._destroySession(sessionId);

    // 3. Enforce memory pool cap: prune oldest pending session if pool is full
    if (this._sessions.size >= MAX_PENDING_SESSIONS) {
      const oldestSessionId = this._sessions.keys().next().value;
      if (oldestSessionId) {
        this.log(`[${TAG}:startAuthSession] Session pool cap reached (${MAX_PENDING_SESSIONS}). Pruning oldest session ${oldestSessionId.substring(0, 8)}...`);
        this._destroySession(oldestSessionId);
      }
    }

    this.log(`[${TAG}:startAuthSession] Creating OAuth2 callback for session ${sessionId.substring(0, 8)}...`);

    const clientId = Homey.env.CLIENT_ID;
    const homeyId = await this.homey.cloud.getHomeyId();
    const scopes = [
      'homey.zone.readonly',
      'homey.device.readonly',
      'homey.device.control',
      'homey.flow.readonly',
      'homey.flow.start',
      'homey.app.readonly',
      'homey.user.self',
    ].join(' ');

    // The base authorization URL
    // createOAuth2Callback requires you to explicitly append the redirect_uri that was configured in the Dev Portal.
    const baseAuthUrl = `https://api.athom.com/oauth2/authorise`
      + `?response_type=code`
      + `&client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=https://callback.athom.com/oauth2/callback/`
      + `&scope=${encodeURIComponent(scopes)}`;

    return new Promise((resolve, reject) => {
      this.homey.cloud.createOAuth2Callback(baseAuthUrl)
        .then((oauthCallback) => {
          oauthCallback.on('url', (authUrl) => {
            this.log(`[${TAG}:startAuthSession] Auth URL generated for session ${sessionId.substring(0, 8)}...: ${authUrl}`);

            // Store session in memory with reference to oauthCallback for listener cleanup
            const timer = setTimeout(() => {
              this.log(`[${TAG}:startAuthSession] Session ${sessionId.substring(0, 8)}... expired.`);
              this._destroySession(sessionId);
            }, SESSION_TTL_MS);

            this._sessions.set(sessionId, {
              authUrl,
              status: 'pending',
              token: null,
              timer,
              oauthCallback,
            });

            // Respond to the AAOS app immediately with the QR URL
            resolve({ authUrl });
          });

          oauthCallback.on('code', async (code) => {
            this.log(`[${TAG}:startAuthSession] Authorization code received for session ${sessionId.substring(0, 8)}...`);
            await this._exchangeCode(sessionId, code);
          });
        })
        .catch((err) => {
          this.error(`[${TAG}:startAuthSession] Failed to create OAuth2 callback:`, err.message || err);
          reject(err);
        });
    });
  }

  /**
   * Returns the current status of an auth session.
   *
   * When status is `'complete'`, the token object is included and the session is
   * immediately deleted from memory (one-time retrieval).
   *
   * @public
   * @param {string} sessionId - The session identifier provided by the AAOS app.
   * @returns {{ status: 'pending'|'complete'|'expired', token?: object }}
   * @example
   * // Called from api.js:
   * const result = homey.app.pollAuthSession('a1b2c3...');
   * // → { status: 'pending' }
   * // → { status: 'complete', token: { access_token, refresh_token, expires_in } }
   * // → { status: 'expired' }
   */
  pollAuthSession(sessionId) {
    const session = this._sessions.get(sessionId);

    if (!session) {
      return { status: 'expired' };
    }

    if (session.status === 'complete') {
      // One-time delivery: delete session immediately after token is retrieved
      this._destroySession(sessionId);
      this.log(`[${TAG}:pollAuthSession] Token delivered and session ${sessionId.substring(0, 8)}... deleted.`);
      return { status: 'complete', token: session.token };
    }

    return { status: session.status };
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Exchanges the OAuth2 authorization code for an access + refresh token pair by
   * calling the Athom Cloud token endpoint.
   *
   * On success, updates the session status to `'complete'` and stores the token.
   * On failure, updates the session status to `'error'`.
   *
   * @private
   * @param {string} sessionId - The session identifier.
   * @param {string} code - The authorization code received from `createOAuth2Callback`.
   * @returns {Promise<void>}
   */
  async _exchangeCode(sessionId, code) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      this.error(`${TAG}: Session ${sessionId.substring(0, 8)}... not found during code exchange.`);
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: Homey.env.CLIENT_ID,
        client_secret: Homey.env.CLIENT_SECRET,
        // redirect_uri must match what createOAuth2Callback registered with Athom
        redirect_uri: 'https://callback.athom.com/oauth2/callback/',
      });

      const response = await fetch(ATHOM_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token endpoint responded with HTTP ${response.status}: ${text}`);
      }

      const token = await response.json();
      this.log(`[${TAG}:_exchangeCode] Token exchange successful for session ${sessionId.substring(0, 8)}...`);

      // 1. Verify user profile and hub membership against Athom Cloud
      this.log(`[${TAG}:_exchangeCode] Verifying hub membership with Athom Cloud for session ${sessionId.substring(0, 8)}...`);
      const userResponse = await this._verifyHubMembership(token.access_token);
      this.log(`[${TAG}:_exchangeCode] Hub membership check passed for session ${sessionId.substring(0, 8)}...`);

      const homeyId = await this.homey.cloud.getHomeyId();
      const homeyApiUrl = `https://${homeyId}.connect.athom.com/api/`;
      let localHomeyName = 'Homey';

      const ownerSessionToken = await this.homey.api.getOwnerApiToken();

      // Retrieve the hub's user-defined system name via the REST API using the Owner token.
      try {
        const nameRes = await fetch(`${homeyApiUrl}manager/system/name`, {
          headers: { Authorization: `Bearer ${ownerSessionToken}` },
        });
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          if (typeof nameData === 'string' && nameData.trim()) {
            localHomeyName = nameData.trim();
          } else if (nameData && typeof nameData.name === 'string') {
            localHomeyName = nameData.name.trim();
          } else if (nameData && typeof nameData.value === 'string') {
            localHomeyName = nameData.value.trim();
          }
        }
      } catch (nameErr) {
        this.log(`[${TAG}:_exchangeCode] Could not fetch system name from /manager/system/name, trying fallback: ${nameErr.message}`);
        try {
          const sysRes = await fetch(`${homeyApiUrl}manager/system`, {
            headers: { Authorization: `Bearer ${ownerSessionToken}` },
          });
          if (sysRes.ok) {
            const sysData = await sysRes.json();
            if (sysData && typeof sysData.name === 'string') {
              localHomeyName = sysData.name.trim();
            }
          }
        } catch (fallbackErr) {
          this.log(`[${TAG}:_exchangeCode] Could not fetch local system name, using default: ${fallbackErr.message}`);
        }
      }

      this.log(`[${TAG}:_exchangeCode] Hub info obtained for session ${sessionId.substring(0, 8)}... (Hub Name: ${localHomeyName})`);

      let homeLocation = null;
      try {
        const lat = this.homey.geolocation.getLatitude();
        const lng = this.homey.geolocation.getLongitude();
        if (typeof lat === 'number' && typeof lng === 'number') {
          homeLocation = { latitude: lat, longitude: lng };
        }
      } catch (geoErr) {
        this.error(`[${TAG}:_exchangeCode] Failed to get geolocation for token:`, geoErr.message);
      }

      session.status = 'complete';
      session.token = {
        session_token: ownerSessionToken,
        homey_id: homeyId,
        homey_name: localHomeyName,
        homey_api_url: homeyApiUrl,
        athom_refresh_token: token.refresh_token,
        location: homeLocation,
        user: {
          id: userResponse.id || userResponse._id || userResponse.athomId || (userResponse.user && (userResponse.user.id || userResponse.user._id || userResponse.user.athomId)) || 'unknown',
          name: userResponse.name || userResponse.fullname || (userResponse.user && (userResponse.user.name || userResponse.user.fullname)) || `${userResponse.firstname || (userResponse.user && userResponse.user.firstname) || ''} ${userResponse.lastname || (userResponse.user && userResponse.user.lastname) || ''}`.trim() || 'Homey User',
          email: userResponse.email || (userResponse.user && userResponse.user.email),
          role: userResponse.localRole || 'user',
        },
      };

      this.log(`[${TAG}:_exchangeCode] Profile keys retrieved: ${Object.keys(userResponse).join(', ')}`);
    } catch (err) {
      this.error(`[${TAG}:_exchangeCode] Token exchange failed for session ${sessionId.substring(0, 8)}...:`, err.message || err);
      session.status = 'error';
    }
  }

  /**
   * Cancels the cleanup timer, removes registered event listeners, and deletes the session from memory.
   *
   * @private
   * @param {string} sessionId - The session identifier to destroy (mandatory).
   * @returns {void}
   * @example
   * this._destroySession('a1b2c3d4...');
   */
  _destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      if (session.timer) {
        clearTimeout(session.timer);
      }
      if (session.oauthCallback && typeof session.oauthCallback.removeAllListeners === 'function') {
        try {
          session.oauthCallback.removeAllListeners();
        } catch (err) {
          this.error(`[${TAG}:_destroySession] Failed to remove listeners from oauthCallback:`, err.message || err);
        }
      }
      this._sessions.delete(sessionId);
      this.log(`[${TAG}:_destroySession] Session ${sessionId.substring(0, 8)}... destroyed and cleaned up from pool.`);
    }
  }

  /**
   * Enforces a sliding window in-memory rate limit for sensitive public operations.
   *
   * Prunes expired timestamps older than `windowMs` and verifies that the total
   * request count within the active window does not exceed `maxRequests`.
   * If the limit is exceeded, logs a security error and throws an HTTP 429 exception.
   *
   * @private
   * @param {string} actionKey - Unique key identifying the operation being rate-limited (mandatory).
   * @param {number} maxRequests - Maximum number of requests permitted within the time window (mandatory).
   * @param {number} windowMs - Duration of the sliding time window in milliseconds (mandatory).
   * @returns {void}
   * @throws {Error} If request frequency exceeds maxRequests within windowMs (HTTP 429).
   * @example
   * this._checkRateLimit('auth_start', 5, 300000);
   */
  _checkRateLimit(actionKey, maxRequests, windowMs) {
    const now = Date.now();
    const timestamps = this._rateLimits.get(actionKey) || [];
    const validTimestamps = timestamps.filter(ts => (now - ts) < windowMs);

    if (validTimestamps.length >= maxRequests) {
      this.error(`[${TAG}:_checkRateLimit] Security rejection: Rate limit exceeded for action '${actionKey}' (${validTimestamps.length}/${maxRequests} in ${windowMs}ms).`);
      throw Object.assign(new Error(`Rate limit exceeded for ${actionKey}. Please try again later.`), { statusCode: 429 });
    }

    validTimestamps.push(now);
    this._rateLimits.set(actionKey, validTimestamps);
  }

  /**
   * Verifies that the authenticated Athom user is registered on this local Homey Pro hub
   * and holds an authorized role (`owner`, `manager`, or `user` / resident).
   *
   * Flow:
   * 1. Queries Athom Cloud (`GET https://api.athom.com/user/me`) to authenticate the Bearer token
   *    and extract the verified Athom account identifier (`userId`).
   * 2. Queries the local Homey Pro User Manager (`GET /api/manager/users/user`) using the owner token
   *    to verify that `userId` matches a registered local user's `athomId` or `id`.
   * 3. Inspects the local user's `enabled` status and `role`, explicitly rejecting disabled accounts
   *    and `guest` users with HTTP 403 Forbidden.
   *
   * @private
   * @async
   * @param {string} accessToken - The Athom Cloud OAuth2 access token (mandatory).
   * @returns {Promise<object>} The Athom user profile object enriched with `localRole`.
   * @throws {Error} If accessToken is missing (HTTP 400), user profile fetch fails (HTTP 401),
   *                 or if the user is not registered, disabled, or has a `guest` role (HTTP 403).
   * @example
   * const userProfile = await this._verifyHubMembership(token.access_token);
   */
  async _verifyHubMembership(accessToken) {
    if (!accessToken || typeof accessToken !== 'string') {
      throw Object.assign(new Error('Missing or invalid accessToken.'), { statusCode: 400 });
    }

    this.log(`[${TAG}:_verifyHubMembership] Authenticating user token with Athom Cloud...`);

    const response = await fetch('https://api.athom.com/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.error(`[${TAG}:_verifyHubMembership] Failed to fetch Athom user profile. Status: ${response.status}`, errorText);
      throw Object.assign(new Error('Failed to retrieve Athom user profile.'), { statusCode: 401 });
    }

    const userProfile = await response.json();
    const currentHomeyId = await this.homey.cloud.getHomeyId();

    const maskId = id => (typeof id === 'string' && id.length > 8 ? `${id.substring(0, 4)}***${id.slice(-4)}` : '***');
    const maskedHomeyId = maskId(currentHomeyId);

    const userId = userProfile.id
      || userProfile._id
      || userProfile.athomId
      || (userProfile.user && (userProfile.user.id || userProfile.user._id || userProfile.user.athomId))
      || null;

    if (!userId) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: Could not extract user ID from Athom profile.`);
      throw Object.assign(new Error('Invalid Athom user profile.'), { statusCode: 401 });
    }

    const maskedUserId = maskId(userId);

    // Query Local Homey Pro User Registry
    let usersList = [];
    try {
      const localUrl = await this.homey.api.getLocalUrl();
      const ownerToken = await this.homey.api.getOwnerApiToken();
      const usersResponse = await fetch(`${localUrl}/api/manager/users/user`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      if (!usersResponse.ok) {
        this.error(`[${TAG}:_verifyHubMembership] Local users API responded with HTTP ${usersResponse.status}.`);
        throw new Error(`Local users API failed with status ${usersResponse.status}`);
      }

      const usersData = await usersResponse.json();
      usersList = Array.isArray(usersData) ? usersData : Object.values(usersData || {});
    } catch (localErr) {
      this.error(`[${TAG}:_verifyHubMembership] Failed to query local users registry:`, localErr.message || localErr);
      throw Object.assign(new Error('Failed to verify local hub users registry.'), { statusCode: 500 });
    }

    const matchedLocalUser = usersList.find(u => u && (
      (u.athomId && u.athomId === userId) ||
      (u.id && u.id === userId) ||
      (u._id && u._id === userId)
    ));

    if (!matchedLocalUser) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: Authenticated user '${maskedUserId}' is not registered on hub '${maskedHomeyId}' (localUsersCount=${usersList.length}). Access denied.`);
      throw Object.assign(new Error('User is not authorized on this Homey hub.'), { statusCode: 403 });
    }

    const userRole = typeof matchedLocalUser.role === 'string' ? matchedLocalUser.role.toLowerCase() : 'unknown';
    const isEnabled = matchedLocalUser.enabled !== false;
    const isPresent = Boolean(matchedLocalUser.present);
    const isAsleep = Boolean(matchedLocalUser.asleep);
    const localUserKeys = Object.keys(matchedLocalUser).join(', ');

    this.log(`[${TAG}:_verifyHubMembership] Local user found on hub '${maskedHomeyId}': user='${maskedUserId}', role='${userRole}', enabled=${isEnabled}, present=${isPresent}, asleep=${isAsleep}, keys=[${localUserKeys}]`);

    if (!isEnabled) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: User '${maskedUserId}' is disabled on hub '${maskedHomeyId}'. Access denied.`);
      throw Object.assign(new Error('User account is disabled on this Homey hub.'), { statusCode: 403 });
    }

    if (userRole === 'guest') {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: User '${maskedUserId}' has role 'guest' on hub '${maskedHomeyId}'. Guest accounts are not permitted. Access denied.`);
      throw Object.assign(new Error('Guest users are not authorized to access this Homey hub.'), { statusCode: 403 });
    }

    this.log(`[${TAG}:_verifyHubMembership] Security check passed: User '${maskedUserId}' (role='${userRole}') is authorized for hub '${maskedHomeyId}'.`);

    userProfile.localRole = userRole;
    return userProfile;
  }

  /**
   * Refreshes the OAuth access token using the Athom Cloud OAuth2 refresh_token.
   *
   * Enforces sliding window rate limiting (max 10 requests per 5 minutes).
   * Verifies the token by exchanging it with Athom Cloud. When Athom returns a new token pair,
   * re-verifies that the user still has membership access to this hub before delivering the refreshed tokens.
   *
   * @public
   * @param {string} athomRefreshToken - The refresh_token from the Athom Cloud (mandatory).
   * @returns {Promise<{session_token: string, athom_refresh_token: string}>} The new tokens.
   * @throws {Error} If rate limit is exceeded (HTTP 429), token is invalid/expired (HTTP 401),
   *                 user is not authorized on hub (HTTP 403), or token exchange fails.
   * @example
   * const tokens = await homey.app.refreshAuthSession('eyJhbGciOi...');
   */
  async refreshAuthSession(athomRefreshToken) {
    // 1. Enforce sliding window rate limit (max 10 requests per 5 minutes)
    this._checkRateLimit('auth_refresh', RATE_LIMIT_AUTH_REFRESH_MAX, RATE_LIMIT_AUTH_REFRESH_WINDOW_MS);

    if (!athomRefreshToken || typeof athomRefreshToken !== 'string') {
      throw Object.assign(new Error('Missing or invalid athom_refresh_token.'), { statusCode: 400 });
    }

    try {
      // 2. Verify and rotate the refresh_token via Athom Cloud
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: athomRefreshToken,
        client_id: Homey.env.CLIENT_ID,
        client_secret: Homey.env.CLIENT_SECRET,
      });

      const response = await fetch(ATHOM_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        this.error(`[${TAG}:refreshAuthSession] Athom refresh_token exchange failed. Status: ${response.status}`, text);
        throw Object.assign(new Error('Invalid or expired athom_refresh_token.'), { statusCode: 401 });
      }

      // We successfully got a new OAuth token pair from Athom
      const newAthomTokens = await response.json();
      this.log(`[${TAG}:refreshAuthSession] OAuth token successfully refreshed via Athom Cloud.`);

      // 3. Re-verify that user still has active membership permissions for this hub
      this.log(`[${TAG}:refreshAuthSession] Re-verifying hub membership permissions for refreshed token...`);
      await this._verifyHubMembership(newAthomTokens.access_token);
      this.log(`[${TAG}:refreshAuthSession] Hub membership check passed for token refresh.`);

      const ownerSessionToken = await this.homey.api.getOwnerApiToken();

      return {
        session_token: ownerSessionToken,
        athom_refresh_token: newAthomTokens.refresh_token,
      };
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) throw err;
      this.error(`[${TAG}:refreshAuthSession] Failed to refresh auth session:`, err.message || err);
      throw Object.assign(new Error('Internal error during token refresh.'), { statusCode: 500 });
    }
  }

  /**
   * Ensures a HomeyScript proxy script exists on the local Homey Pro hub and returns its ID.
   *
   * Queries the official Athom HomeyScript app (`com.athom.homeyscript`).
   * If the app is missing (HTTP 404), throws an error with `code: 'HOMEYSCRIPT_NOT_INSTALLED'`.
   * If the dedicated `AAOS-FlowTrigger` script is missing, creates it automatically.
   *
   * @private
   * @returns {Promise<{scriptId: string}>} The script identifier to execute.
   * @throws {Error} If HomeyScript is not installed or script proxy creation fails.
   */
  async _ensureHomeyScriptProxy() {
    if (this._homeyScriptProxyId) {
      return { scriptId: this._homeyScriptProxyId };
    }

    const localUrl = await this.homey.api.getLocalUrl();
    const ownerToken = await this.homey.api.getOwnerApiToken();

    try {
      const response = await fetch(`${localUrl}/api/app/com.athom.homeyscript/script`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          const err = new Error('HomeyScript app is not installed on Homey Pro.');
          err.code = 'HOMEYSCRIPT_NOT_INSTALLED';
          err.statusCode = 404;
          throw err;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const scripts = await response.json();
      const existing = Object.values(scripts).find(s => s && s.name === 'AAOS-FlowTrigger');
      if (existing) {
        this._homeyScriptProxyId = existing.id;
        this.log(`[${TAG}:_ensureHomeyScriptProxy] Found existing HomeyScript proxy script: ${this._homeyScriptProxyId}`);
        return { scriptId: this._homeyScriptProxyId };
      }
    } catch (err) {
      if (err.code === 'HOMEYSCRIPT_NOT_INSTALLED') throw err;
      this.log(`[${TAG}:_ensureHomeyScriptProxy] Could not list existing scripts, will attempt creation: ${err.message}`);
    }

    try {
      const createResponse = await fetch(`${localUrl}/api/app/com.athom.homeyscript/script`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'AAOS-FlowTrigger',
          code: '// Flow trigger proxy for AAOS Companion App\n// Managed by com.dimapp.aaos\n',
        }),
      });

      if (!createResponse.ok) {
        if (createResponse.status === 404) {
          const err = new Error('HomeyScript app is not installed on Homey Pro.');
          err.code = 'HOMEYSCRIPT_NOT_INSTALLED';
          err.statusCode = 404;
          throw err;
        }
        throw new Error(`HTTP ${createResponse.status}: ${createResponse.statusText}`);
      }

      const newScript = await createResponse.json();
      this._homeyScriptProxyId = newScript.id;
      this.log(`[${TAG}:_ensureHomeyScriptProxy] Created HomeyScript proxy script: ${this._homeyScriptProxyId}`);
      return { scriptId: this._homeyScriptProxyId };
    } catch (err) {
      if (err.code === 'HOMEYSCRIPT_NOT_INSTALLED') throw err;
      throw new Error(`Failed to create HomeyScript proxy script: ${err.message}`);
    }
  }

  /**
   * Executes arbitrary JavaScript snippet inside the privileged HomeyScript runtime.
   *
   * @private
   * @param {string} code - The JavaScript snippet to run inside HomeyScript.
   * @returns {Promise<any>} The return value from HomeyScript execution.
   * @throws {Error} If HomeyScript is not installed or script execution fails.
   */
  async _executeHomeyScript(code) {
    const { scriptId } = await this._ensureHomeyScriptProxy();
    const localUrl = await this.homey.api.getLocalUrl();
    const ownerToken = await this.homey.api.getOwnerApiToken();

    const response = await fetch(`${localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        const err = new Error('HomeyScript app is not installed on Homey Pro.');
        err.code = 'HOMEYSCRIPT_NOT_INSTALLED';
        err.statusCode = 404;
        throw err;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success) {
      const errorMsg = result.returns?.message || result.error || 'HomeyScript execution failed';
      throw new Error(errorMsg);
    }
    return result.returns;
  }

  /**
   * Triggers a standard or advanced Homey flow via the privileged HomeyScript proxy.
   *
   * Validates that flowId is a valid UUID format, enforces boolean isAdvanced parameter,
   * serializes arguments safely via JSON.stringify, and avoids any string interpolation
   * vulnerabilities inside HomeyScript code generation.
   *
   * @public
   * @param {string} flowId - The UUID of the target Flow.
   * @param {boolean} [isAdvanced=false] - Whether the target flow is an Advanced Flow.
   * @param {object} [args={}] - Optional arguments to pass to the flow.
   * @returns {Promise<{success: boolean, message: string}>} Result of the operation.
   * @throws {Error} If the flow UUID is invalid or execution fails.
   * @example
   * await homey.app.triggerFlow('123e4567-e89b-12d3-a456-426614174000', true);
   */
  async triggerFlow(flowId, isAdvanced = false, args = {}) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const trimmedId = typeof flowId === 'string' ? flowId.trim() : '';

    if (!trimmedId || !UUID_REGEX.test(trimmedId)) {
      this.error(`[${TAG}:triggerFlow] Security rejection: Invalid flowId '${trimmedId}'. Standard UUID format required.`);
      throw Object.assign(new Error('Missing or invalid flowId parameter. Must be a valid UUID.'), { statusCode: 400 });
    }

    const safeIsAdvanced = isAdvanced === true;
    const method = safeIsAdvanced ? 'triggerAdvancedFlow' : 'triggerFlow';

    // Safely encode parameters using JSON.stringify to completely prevent script injection
    const safeId = JSON.stringify(trimmedId);
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? JSON.stringify(args) : 'null';
    const code = `await Homey.flow.${method}({ id: ${safeId} }, ${safeArgs});`;

    this.log(`[${TAG}:triggerFlow] Security validation passed for flow '${trimmedId}'. Executing method '${method}' via HomeyScript proxy...`);
    await this._executeHomeyScript(code);
    this.log(`[${TAG}:triggerFlow] Flow '${trimmedId}' triggered successfully.`);

    return { success: true, message: 'Flow triggered successfully.' };
  }




  /**
   * Checks whether debug logging is currently enabled in settings.
   *
   * @public
   * @returns {boolean} True if debug logging is enabled.
   * @example
   * if (this.isDebugLoggingEnabled()) {
   *   // perform verbose operations
   * }
   */
  isDebugLoggingEnabled() {
    return Boolean(this.homey.settings.get('debug_logging_enabled'));
  }

  /**
   * Retrieves the LogManager instance.
   *
   * @public
   * @returns {LogManager} The LogManager instance.
   * @example
   * const logManager = homey.app.getLogManager();
   */
  getLogManager() {
    return this._logManager;
  }

  /**
   * Overrides {@link Homey.App#log} to print to standard console (stdout) and mirror sanitized
   * messages to the persistent LogManager diagnostic file when debug logging is active.
   *
   * @public
   * @param {...any} args - Log messages or objects to output.
   * @returns {void}
   * @example
   * this.log('[Auth:start] Initializing pairing session');
   */
  log(...args) {
    super.log(...args);
    if (this._isLoggingInternal) return;
    if (this._logManager && this._logManager.isDebugEnabled()) {
      try {
        this._isLoggingInternal = true;
        const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
        const formatted = sanitizedArgs.map(arg => {
          if (arg === null || arg === undefined) return String(arg);
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          }
          return String(arg);
        }).join(' ');

        const match = formatted.match(/^\[([a-zA-Z0-9_\-:]+)\]\s*(.*)$/s);
        const tag = match ? match[1] : TAG;
        const message = match ? match[2] : formatted;

        this._logManager.writeLog('INFO', tag, message);
      } catch (err) {
        // Ignored to prevent runtime interruption during logging
      } finally {
        this._isLoggingInternal = false;
      }
    }
  }

  /**
   * Overrides {@link Homey.App#error} to print to standard error console (stderr) and mirror sanitized
   * error messages to the persistent LogManager diagnostic file.
   *
   * @public
   * @param {...any} args - Error messages, Error instances, or objects to output.
   * @returns {void}
   * @example
   * this.error('[Auth:exchange] Code exchange failed:', error.message);
   */
  error(...args) {
    super.error(...args);
    if (this._isLoggingInternal) return;
    if (this._logManager) {
      try {
        this._isLoggingInternal = true;
        const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
        const formatted = sanitizedArgs.map(arg => {
          if (arg === null || arg === undefined) return String(arg);
          if (arg instanceof Error) {
            return `${arg.message || ''}${arg.stack ? `\n${arg.stack}` : ''}`;
          }
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          }
          return String(arg);
        }).join(' ');

        const match = formatted.match(/^\[([a-zA-Z0-9_\-:]+)\]\s*(.*)$/s);
        const tag = match ? match[1] : TAG;
        const message = match ? match[2] : formatted;

        this._logManager.writeLog('ERROR', tag, message);
      } catch (err) {
        // Ignored to prevent runtime interruption during logging
      } finally {
        this._isLoggingInternal = false;
      }
    }
  }

  /**
   * Emits a structured debug log message if debug logging is enabled in settings.
   * Adheres strictly to the logging system guidelines:
   * - Format: [ClassName:methodName] message
   * - English language only
   * - Automatic sanitization of sensitive PII, credentials, and coordinates
   * - Prohibition of emoticons and non-textual symbols
   *
   * @public
   * @param {string} tag - Context identifier, e.g. 'ClassName:methodName'.
   * @param {...any} args - Log message or objects to output.
   * @returns {void}
   * @example
   * this.debugLog('api:getDevices', 'Filtering device:', device.name);
   */
  debugLog(tag, ...args) {
    if (!this.isDebugLoggingEnabled()) return;
    const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
    super.log(`[DEBUG] [${tag}]`, ...sanitizedArgs);
    if (this._logManager) {
      const formattedMessage = sanitizedArgs.map(arg => {
        if (arg === null || arg === undefined) return String(arg);
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      this._logManager.writeLog('DEBUG', tag, formattedMessage);
    }
  }

  /**
   * Sanitizes a log payload by masking sensitive tokens, passwords, emails, and GPS coordinates.
   * Delegates string masking to {@link LogManager.sanitize}.
   *
   * @private
   * @param {any} payload - Data payload to sanitize.
   * @returns {any} Sanitized payload safe for logging.
   * @example
   * const safeObj = this._sanitizeLogPayload({ token: 'abc', lat: 45.1 });
   */
  _sanitizeLogPayload(payload) {
    if (payload === null || payload === undefined) return payload;
    if (payload instanceof Error) {
      const sanitizedMessage = LogManager.sanitize(payload.message || '');
      const sanitizedStack = payload.stack ? LogManager.sanitize(payload.stack) : undefined;
      const cleanError = new Error(sanitizedMessage);
      if (sanitizedStack) cleanError.stack = sanitizedStack;
      if (payload.code) cleanError.code = payload.code;
      if (payload.statusCode) cleanError.statusCode = payload.statusCode;
      return cleanError;
    }
    if (typeof payload === 'string') {
      return LogManager.sanitize(payload);
    }
    if (typeof payload === 'object') {
      try {
        const str = JSON.stringify(payload);
        const sanitizedStr = LogManager.sanitize(str);
        return JSON.parse(sanitizedStr);
      } catch (err) {
        return '[Complex Object]';
      }
    }
    return payload;
  }
}

module.exports = HomeyAaosCompanionApp;
