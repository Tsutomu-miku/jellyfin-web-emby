/**
 * Jellyfin-Web Emby Adapter v2.0.0
 * 
 * ARCHITECTURE:
 * 
 * The adapter has TWO distinct phases:
 * 
 * Phase 1 - Pre-login (no server configured):
 *   - index.js shows a login UI overlay
 *   - Adapter intercepts config.json to return the configured server
 *   - Adapter blocks Jellyfin Web from loading until login completes
 * 
 * Phase 2 - Post-login (server configured):
 *   - ConnectionManager connects to the Emby server directly (cross-origin)
 *   - Adapter intercepts ONLY cross-origin requests going to the Emby server
 *   - Handles: CORS headers, /emby/ prefix, version spoofing, auth headers
 *   - Does NOT touch same-origin requests (static files, webpack chunks, etc.)
 */

(function () {
    'use strict';

    const ADAPTER_VERSION = '2.0.0';
    let DEBUG = localStorage.getItem('embyAdapterDebug') === 'true';
    const SPOOFED_VERSION = '10.10.7';

    function log(...args) {
        if (DEBUG) console.log('[EmbyAdapter]', ...args);
    }
    function warn(...args) {
        console.warn('[EmbyAdapter]', ...args);
    }

    log(`v${ADAPTER_VERSION} initializing...`);

    // ========================================
    // Configuration Store
    // ========================================

    const CONFIG_KEY = 'embyAdapterConfig';
    const CREDS_KEY = 'jellyfin_credentials';

    function getConfig() {
        try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } 
        catch { return {}; }
    }

    function getServerUrl() {
        const cfg = getConfig();
        return cfg.serverUrl || '';
    }

    function getToken() {
        const cfg = getConfig();
        return cfg.token || '';
    }

    // ========================================
    // Request Classification
    // ========================================

    /**
     * Check if a URL points to the configured Emby server.
     * This is the ONLY condition under which we modify requests.
     * Same-origin requests are NEVER modified.
     */
    function isEmbyServerRequest(url) {
        const serverUrl = getServerUrl();
        if (!serverUrl || !url) return false;
        try {
            const reqUrl = new URL(url, window.location.origin);
            const srvUrl = new URL(serverUrl);
            return reqUrl.hostname === srvUrl.hostname && 
                   (reqUrl.port || '') === (srvUrl.port || '');
        } catch { return false; }
    }

    /**
     * Check if a URL is a same-origin config.json request.
     * We intercept this to inject the Emby server address.
     */
    function isConfigJsonRequest(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.origin === window.location.origin && 
                   u.pathname.endsWith('/config.json');
        } catch { return false; }
    }

    // ========================================
    // URL Transformation
    // ========================================

    /**
     * Add /emby/ prefix to path if not already present.
     */
    function addEmbyPrefix(url) {
        try {
            const u = new URL(url);
            const lp = u.pathname.toLowerCase();
            if (!lp.startsWith('/emby/') && !lp.startsWith('/emby')) {
                u.pathname = '/emby' + u.pathname;
            }
            return u.toString();
        } catch { return url; }
    }

    // ========================================
    // Version Spoofing
    // ========================================

    function needsVersionSpoof(url) {
        try {
            const lp = new URL(url).pathname.toLowerCase();
            return lp.endsWith('/system/info/public') || 
                   lp.endsWith('/system/info') ||
                   lp.endsWith('/emby/system/info/public') || 
                   lp.endsWith('/emby/system/info');
        } catch { return false; }
    }

    function spoofVersion(bodyText) {
        try {
            const data = JSON.parse(bodyText);
            if (data && typeof data === 'object') {
                const orig = data.Version;
                data.Version = SPOOFED_VERSION;
                data.ProductName = data.ProductName || 'Jellyfin Server';
                log('Spoofed version:', orig, '->', SPOOFED_VERSION);
                return JSON.stringify(data);
            }
        } catch (e) { warn('Version spoof error:', e); }
        return bodyText;
    }

    // ========================================
    // Auth Header Helpers
    // ========================================

    function buildEmbyAuth(originalValue) {
        if (!originalValue) return originalValue;
        let v = originalValue;
        if (v.startsWith('MediaBrowser ')) v = 'Emby ' + v.substring(13);
        else if (v.startsWith('Jellyfin ')) v = 'Emby ' + v.substring(9);

        const token = getToken();
        if (token && !v.includes('Token=')) {
            v = v.replace(/\s*$/, '') + ', Token="' + token + '"';
        }
        return v;
    }

    function isProblematicHeader(name) {
        const lk = name.toLowerCase();
        return lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-');
    }

    /**
     * Clean headers for CORS safety: strip X-Emby-*, fold auth into Authorization.
     */
    function cleanHeaders(headers) {
        if (!headers) return headers;

        if (headers instanceof Headers) {
            const h = new Headers();
            for (const [key, value] of headers.entries()) {
                const lk = key.toLowerCase();
                if (isProblematicHeader(key)) {
                    if (lk === 'x-emby-authorization' || lk === 'x-mediabrowser-token') {
                        h.set('Authorization', buildEmbyAuth(value));
                    }
                    continue; // drop
                }
                if (lk === 'authorization') {
                    h.set('Authorization', buildEmbyAuth(value));
                    continue;
                }
                h.set(key, value);
            }
            return h;
        }

        if (typeof headers === 'object' && !Array.isArray(headers)) {
            const result = {};
            for (const [key, value] of Object.entries(headers)) {
                const lk = key.toLowerCase();
                if (isProblematicHeader(key)) {
                    if (lk === 'x-emby-authorization' || lk === 'x-mediabrowser-token') {
                        result['Authorization'] = buildEmbyAuth(value);
                    }
                    continue;
                }
                if (lk === 'authorization') {
                    result['Authorization'] = buildEmbyAuth(value);
                    continue;
                }
                result[key] = value;
            }
            return result;
        }

        return headers;
    }

    // ========================================
    // Response Transformers
    // ========================================

    function transformUserData(data) {
        if (!data) return data;
        if (data.Policy) {
            data.Policy = {
                ...data.Policy,
                IsAdministrator: data.Policy.IsAdministrator ?? data.Policy.IsAdmin ?? false,
                EnableAllFolders: data.Policy.EnableAllFolders ?? true,
                EnableAllChannels: data.Policy.EnableAllChannels ?? true,
            };
        }
        return data;
    }

    function transformItem(item) {
        if (!item) return item;
        if (item.UserData) {
            item.UserData = {
                ...item.UserData,
                PlaybackPositionTicks: item.UserData.PlaybackPositionTicks || 0,
                PlayCount: item.UserData.PlayCount || 0,
                IsFavorite: item.UserData.IsFavorite ?? false,
                Played: item.UserData.Played ?? false,
            };
        }
        if (item.MediaSources && Array.isArray(item.MediaSources)) {
            item.MediaSources = item.MediaSources.map(s => ({
                ...s,
                SupportsTranscoding: s.SupportsTranscoding ?? true,
                SupportsDirectStream: s.SupportsDirectStream ?? true,
                SupportsDirectPlay: s.SupportsDirectPlay ?? true,
            }));
        }
        return item;
    }

    // ========================================
    // Config.json Interceptor
    // ========================================

    /**
     * Generate a synthetic config.json response.
     * This tells Jellyfin Web where the server is.
     */
    function createConfigJsonResponse() {
        const serverUrl = getServerUrl();
        const config = {};

        if (serverUrl) {
            // Tell Jellyfin Web to connect to this server
            config.servers = [serverUrl];
        }

        // Standard Jellyfin Web config
        config.menuLinks = [];
        config.multiserver = false;

        return new Response(JSON.stringify(config), {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ========================================
    // Fetch Interceptor
    // ========================================

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        let modifiedInit = init ? { ...init } : {};

        try {
            // ---- Intercept config.json to inject server address ----
            if (isConfigJsonRequest(url)) {
                log('Intercepting config.json, injecting server:', getServerUrl());
                return createConfigJsonResponse();
            }

            // ---- Only modify requests going to the Emby server ----
            if (isEmbyServerRequest(url)) {
                // Clean CORS-problematic headers
                if (modifiedInit.headers) {
                    modifiedInit.headers = cleanHeaders(modifiedInit.headers);
                }
                if (input instanceof Request) {
                    const cleaned = cleanHeaders(new Headers(input.headers));
                    if (!modifiedInit.headers) modifiedInit.headers = cleaned;
                }

                // Add /emby/ prefix
                url = addEmbyPrefix(url);
                log('Fetch:', url);

                // Rebuild input
                if (typeof input === 'string') {
                    input = url;
                } else if (input instanceof Request) {
                    input = new Request(url, input);
                }

                // Execute request
                const response = await originalFetch.call(this, input, modifiedInit);

                // Version spoofing
                if (needsVersionSpoof(url) && response.ok) {
                    const text = await response.clone().text();
                    return new Response(spoofVersion(text), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                }

                // JSON response transformations
                if (response.ok) {
                    const ct = response.headers.get('content-type');
                    if (ct && ct.includes('application/json')) {
                        const lp = new URL(url).pathname.toLowerCase();
                        if (lp.includes('/users/') || lp.includes('/items')) {
                            try {
                                let data = await response.clone().json();
                                if (lp.includes('/users/')) data = transformUserData(data);
                                if (data.Items) data.Items = data.Items.map(transformItem);
                                else if (lp.includes('/items')) data = transformItem(data);
                                return new Response(JSON.stringify(data), {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers,
                                });
                            } catch { /* use original */ }
                        }
                    }
                }

                return response;
            }
        } catch (error) {
            warn('Fetch error:', error);
        }

        // Not an Emby request — pass through unmodified
        return originalFetch.call(this, input, modifiedInit);
    };

    // ========================================
    // XHR Interceptor
    // ========================================

    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._adapterUrl = url;
        this._isEmbyReq = isEmbyServerRequest(url);
        this._isConfigJson = isConfigJsonRequest(url);

        if (this._isEmbyReq) {
            url = addEmbyPrefix(url);
            log('XHR:', method, url);
        }

        return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this._isEmbyReq) {
            const lk = name.toLowerCase();
            if (isProblematicHeader(name)) {
                if (lk === 'x-emby-authorization') {
                    return origSetHeader.call(this, 'Authorization', buildEmbyAuth(value));
                }
                log('Stripped XHR header:', name);
                return; // drop
            }
            if (lk === 'authorization') {
                return origSetHeader.call(this, 'Authorization', buildEmbyAuth(value));
            }
        }
        return origSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        // Handle config.json interception for XHR
        if (this._isConfigJson) {
            const self = this;
            setTimeout(() => {
                const configData = JSON.stringify({
                    servers: getServerUrl() ? [getServerUrl()] : [],
                    menuLinks: [],
                    multiserver: false,
                });
                Object.defineProperty(self, 'readyState', { value: 4, writable: false });
                Object.defineProperty(self, 'status', { value: 200, writable: false });
                Object.defineProperty(self, 'statusText', { value: 'OK', writable: false });
                Object.defineProperty(self, 'responseText', { value: configData, writable: false });
                Object.defineProperty(self, 'response', { value: configData, writable: false });
                if (typeof self.onreadystatechange === 'function') {
                    self.onreadystatechange();
                }
                self.dispatchEvent(new Event('readystatechange'));
                self.dispatchEvent(new Event('load'));
                self.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
        }

        // Version spoofing for Emby server responses
        if (this._isEmbyReq && needsVersionSpoof(this._adapterUrl)) {
            this.addEventListener('readystatechange', function () {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        const spoofed = spoofVersion(this.responseText);
                        Object.defineProperty(this, 'responseText', { value: spoofed, writable: false });
                        Object.defineProperty(this, 'response', { value: spoofed, writable: false });
                    } catch (e) { warn('XHR spoof error:', e); }
                }
            });
        }

        return origSend.apply(this, args);
    };

    // ========================================
    // WebSocket Patch
    // ========================================

    const OrigWS = window.WebSocket;

    window.WebSocket = function (url, protocols) {
        const serverUrl = getServerUrl();
        if (serverUrl && url) {
            try {
                const u = new URL(url, window.location.origin);
                const s = new URL(serverUrl);
                // Redirect WebSocket to Emby server if it's pointing at same-origin
                if (u.hostname === window.location.hostname) {
                    u.protocol = s.protocol === 'https:' ? 'wss:' : 'ws:';
                    u.hostname = s.hostname;
                    u.port = s.port;
                    url = u.toString();
                    log('WebSocket redirected:', url);
                }
            } catch (e) { warn('WS error:', e); }
        }
        return new OrigWS(url, protocols);
    };
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
    window.WebSocket.prototype = OrigWS.prototype;

    // ========================================
    // UI Patches
    // ========================================

    function applyUIPatches() {
        const apply = () => {
            const style = document.createElement('style');
            style.textContent = `
                .adminDrawerLogo { content: url('') !important; }
                .cardContent { min-height: 0; }
            `;
            document.head.appendChild(style);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply);
        } else {
            apply();
        }
    }

    // ========================================
    // Public API
    // ========================================

    function getDeviceId() {
        let id = localStorage.getItem('embyAdapterDeviceId');
        if (!id) {
            id = 'ea_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
            localStorage.setItem('embyAdapterDeviceId', id);
        }
        return id;
    }

    window.EmbyAdapter = {
        version: ADAPTER_VERSION,

        configure(serverUrl, token) {
            localStorage.setItem(CONFIG_KEY, JSON.stringify({ serverUrl, token }));

            // Also write jellyfin_credentials so ConnectionManager finds the server
            // CRITICAL: the address MUST be the Emby server, NOT the GitHub Pages origin
            const creds = {
                Servers: [{
                    ManualAddress: serverUrl,
                    LocalAddress: serverUrl,
                    RemoteAddress: serverUrl,
                    Id: '',  // Will be filled after first successful connection
                    AccessToken: token,
                    DateLastAccessed: new Date().toISOString(),
                    LastConnectionMode: 2,
                }],
            };
            localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
            log('Configured:', serverUrl);
        },

        getConfig,

        setDebug(enabled) {
            DEBUG = !!enabled;
            localStorage.setItem('embyAdapterDebug', String(DEBUG));
        },

        async testConnection(serverUrl) {
            try {
                const url = serverUrl.replace(/\/+$/, '') + '/emby/System/Info/Public';
                const resp = await originalFetch(url);
                if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
                const data = await resp.json();
                return { success: true, serverName: data.ServerName, version: data.Version };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },

        async authenticate(serverUrl, username, password) {
            const url = serverUrl.replace(/\/+$/, '') + '/emby/Users/AuthenticateByName';
            const resp = await originalFetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Emby Client="Jellyfin Web", Device="Browser", DeviceId="${getDeviceId()}", Version="${ADAPTER_VERSION}"`,
                },
                body: JSON.stringify({ Username: username, Pw: password }),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                throw new Error(`Auth failed: ${resp.status} ${text}`);
            }
            const data = await resp.json();
            const token = data.AccessToken;

            // Configure adapter + write credentials
            this.configure(serverUrl, token);

            // Update credentials with server ID and user info
            try {
                const serverId = data.ServerId || data.SessionInfo?.ServerId || '';
                const userId = data.User?.Id || '';
                const creds = {
                    Servers: [{
                        ManualAddress: serverUrl,
                        LocalAddress: serverUrl,
                        RemoteAddress: serverUrl,
                        Id: serverId,
                        UserId: userId,
                        AccessToken: token,
                        Name: data.SessionInfo?.ServerName || data.ServerName || 'Emby Server',
                        DateLastAccessed: new Date().toISOString(),
                        LastConnectionMode: 2,
                    }],
                };
                localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
            } catch (e) { warn('Credential sync error:', e); }

            return data;
        },

        logout() {
            localStorage.removeItem(CONFIG_KEY);
            localStorage.removeItem(CREDS_KEY);
            window.location.reload();
        },
    };

    // ========================================
    // Init
    // ========================================

    applyUIPatches();
    log('Server:', getServerUrl() || '(not configured)');
    log('Initialized.');

})();
