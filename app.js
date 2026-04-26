'use strict';

const Homey = require('homey');

/** @constant {string} TAG - Log tag used in all messages emitted by this class. */
const TAG = 'HomeyAaosCompanionApp';

/**
 * @constant {number} SESSION_TTL_MS
 * How long an auth session is kept alive before being considered expired, in milliseconds.
 */
const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes

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
   *   authUrl: string,       // The Athom authorization URL to show as QR
   *   status:  'pending'|'complete'|'error',
   *   token:   object|null,  // access_token, refresh_token, expires_in (when complete)
   *   timer:   TimeoutId     // auto-cleanup handle
   * }
   * ```
   * @private
   * @type {Map<string, object>}
   */
  _sessions = new Map();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Called by Homey when the app starts.
   *
   * @public
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log(`${TAG}: Homey AAOS Companion App initialized.`);
  }

  // ── Public Methods (called from api.js) ────────────────────────────────────

  /**
   * Creates a new OAuth2 auth session for a given sessionId.
   *
   * Internally calls `this.homey.cloud.createOAuth2Callback(authorizationUrl)`.
   * Athom replaces the `redirect_uri` with `https://callback.athom.com/oauth2/callback/{TOKEN}`
   * and emits:
   *  - `url`  → the modified authorization URL (to be shown as QR code on the car screen)
   *  - `code` → the authorization code once the user has granted access
   *
   * @public
   * @param {string} sessionId - A 64-character hex string generated with SecureRandom by the
   *                             AAOS app. Used as a unique session identifier.
   * @returns {Promise<{authUrl: string}>} The authorization URL to display as QR code.
   * @throws {Error} If sessionId is missing, or if `createOAuth2Callback` fails.
   * @example
   * // Called from api.js:
   * const { authUrl } = await homey.app.startAuthSession('a1b2c3...');
   */
  async startAuthSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Missing or invalid sessionId.');
    }

    // Invalidate any pre-existing session for this ID
    this._destroySession(sessionId);

    this.log(`${TAG}: Creating OAuth2 callback for session ${sessionId.substring(0, 8)}...`);

    const clientId = Homey.env.CLIENT_ID;
    const scopes = [
      'homey.zone.readonly',
      'homey.device.readonly',
      'homey.device.control',
      'homey.flow.readonly',
      'homey.flow.start',
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
            this.log(`${TAG}: Auth URL generated for session ${sessionId.substring(0, 8)}...`);

            // Store session in memory
            const timer = setTimeout(() => {
              this.log(`${TAG}: Session ${sessionId.substring(0, 8)}... expired.`);
              this._sessions.delete(sessionId);
            }, SESSION_TTL_MS);

            this._sessions.set(sessionId, {
              authUrl,
              status: 'pending',
              token: null,
              timer,
            });

            // Respond to the AAOS app immediately with the QR URL
            resolve({ authUrl });
          });

          oauthCallback.on('code', async (code) => {
            this.log(`${TAG}: Authorization code received for session ${sessionId.substring(0, 8)}...`);
            await this._exchangeCode(sessionId, code);
          });
        })
        .catch((err) => {
          this.error(`${TAG}: Failed to create OAuth2 callback.`, err);
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
      this.log(`${TAG}: Token delivered and session ${sessionId.substring(0, 8)}... deleted.`);
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
      this.log(`${TAG}: Token exchange successful for session ${sessionId.substring(0, 8)}...`);

      // Fetch user profile using the new access token.
      let userResponse = null;
      try {
        const uRes = await fetch('https://api.athom.com/user/me', { headers: { Authorization: `Bearer ${token.access_token}` } });
        
        if (uRes.ok) userResponse = await uRes.json();

        this.log(`${TAG}: User profile fetched successfully.`);
        
        let sessionToken = null;
        let homeyId = null;
        let homeyApiUrl = null;
        let localHomeyName = 'Homey';
        try {
          sessionToken = await this.homey.api.getOwnerApiToken();
          homeyId = await this.homey.cloud.getHomeyId();
          homeyApiUrl = `https://${homeyId}.connect.athom.com/api/`;

          // Retrieve the hub's user-defined system name via the local REST API.
          // GET /api/manager/system/name returns the name set by the user (e.g. "Veggia").
          // We use the cloud URL since the Companion App runs on-device (no LAN required).
          try {
            const nameRes = await fetch(`${homeyApiUrl}manager/system/name`, {
              headers: { Authorization: `Bearer ${sessionToken}` }
            });
            if (nameRes.ok) {
              const nameData = await nameRes.json();
              // The response can be a plain string or an object with a `name` property
              if (typeof nameData === 'string' && nameData) {
                localHomeyName = nameData;
              } else if (nameData && nameData.name) {
                localHomeyName = nameData.name;
              }
            } else {
              this.error(`${TAG}: Could not fetch system name. Status: ${nameRes.status}`);
            }
          } catch (nameErr) {
            this.error(`${TAG}: Failed to fetch system name:`, nameErr);
          }

          this.log(`${TAG}: Owner API token obtained for session ${sessionId.substring(0, 8)}... (Hub Name: ${localHomeyName})`);
        } catch (tokenErr) {
          this.error(`${TAG}: Failed to obtain owner API token:`, tokenErr);
        }

        session.status = 'complete';
        session.token = {
          session_token: sessionToken,
          homey_id: homeyId,
          homey_name: localHomeyName,
          homey_api_url: homeyApiUrl,
          athom_refresh_token: token.refresh_token,
          user: userResponse ? {
            id: userResponse.id || userResponse._id || userResponse.athomId || 'unknown',
            name: userResponse.name || userResponse.fullname || `${userResponse.firstname || ''} ${userResponse.lastname || ''}`.trim() || 'Homey User',
            email: userResponse.email,
          } : null,
        };

        if (userResponse) {
          const debugProfile = { ...userResponse };
          if (debugProfile.email) debugProfile.email = '***@***.***';
          this.log(`${TAG}: Profile keys: ${Object.keys(userResponse).join(', ')}`);
        }
      } catch (fetchErr) {
        this.error(`${TAG}: Error fetching profile/homeys from Athom:`, fetchErr);
        session.status = 'error';
      }
    } catch (err) {
      this.error(`${TAG}: Token exchange failed for session ${sessionId.substring(0, 8)}...`, err);
      session.status = 'error';
    }
  }

  /**
   * Cancels the cleanup timer for a session and removes it from the session map.
   *
   * @private
   * @param {string} sessionId - The session identifier to destroy.
   */
  _destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      clearTimeout(session.timer);
      this._sessions.delete(sessionId);
    }
  }

  /**
   * Refreshes the owner API token using the Athom Cloud OAuth2 refresh_token.
   *
   * Verifies the token by exchanging it with Athom Cloud. If Athom returns a new token pair,
   * we consider the request authenticated, generate a new local owner API (session) token,
   * and return it to the caller along with the new Athom refresh_token.
   *
   * @public
   * @param {string} athomRefreshToken - The refresh_token from the Athom Cloud.
   * @returns {Promise<{session_token: string, athom_refresh_token: string}>} The new tokens.
   */
  async refreshAuthSession(athomRefreshToken) {
    if (!athomRefreshToken) {
      throw Object.assign(new Error('Missing athom_refresh_token.'), { statusCode: 401 });
    }

    try {
      // 1. Verify and rotate the refresh_token via Athom Cloud
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
        this.error(`${TAG}: Athom refresh_token exchange failed. Status: ${response.status}`, text);
        throw Object.assign(new Error('Invalid or expired athom_refresh_token.'), { statusCode: 401 });
      }

      // We successfully got a new OAuth token pair from Athom
      const newAthomTokens = await response.json();

      // 2. Generate a new local session token
      const newSessionToken = await this.homey.api.getOwnerApiToken();
      
      this.log(`${TAG}: Owner API token successfully refreshed via Athom Cloud.`);
      
      // Return both the new session token and the newly rotated Athom refresh_token
      return {
        session_token: newSessionToken,
        athom_refresh_token: newAthomTokens.refresh_token
      };
    } catch (err) {
      if (err.statusCode === 401) throw err;
      this.error(`${TAG}: Failed to refresh owner API token:`, err);
      throw Object.assign(new Error('Internal error during token refresh.'), { statusCode: 500 });
    }
  }
}

module.exports = HomeyAaosCompanionApp;
