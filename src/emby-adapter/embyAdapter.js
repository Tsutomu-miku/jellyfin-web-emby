/**
 * Jellyfin-Web Emby Adapter
 * 
 * Intercepts all network requests from Jellyfin Web and translates them
 * for Emby server compatibility. Handles:
 * - URL rewriting: redirect API calls from GitHub Pages origin to Emby server
 * - URL prefix (/emby/) injection
 * - Auth header translation (MediaBrowser -> Emby)
 * - CORS-safe headers (only standard Authorization, no X-Emby-*)
 * - Version spoofing (Emby 4.x -> Jellyfin 10.x compatible)
 * - Response transformation for API compatibility
 * - WebSocket patching
 */

(function () {
    'use strict';

    // ========================================
    // Configuration
    // ========================================

    const ADAPTER_VERSION = '1.5.0';
    let DEBUG = localStorage.getItem('embyAdapterDebug') === 'true';

    const SPOOFED_JELLYFIN_VERSION = '10.10.7';

    // Paths whose responses need version spoofing (matched case-insensitively)
    const VERSION_SPOOF_PATHS = [
        '/system/info/public',
        '/system/info',
    ];

    // Known Jellyfin/Emby API path prefixes (lowercase).
    // If a same-origin request matches one of these, it's an API call that
    // ConnectionManager/SDK built with a relative URL — it should be routed
    // to the configured Emby server instead of hitting GitHub Pages.
    const API_PATH_PATTERNS = [
        '/system/', '/users/', '/items', '/sessions',
        '/library/', '/branding/', '/displaypreferences',
        '/playbackinfo', '/livestreams', '/quickconnect',
        '/mediasources', '/audio/', '/videos/',
        '/artists', '/genres', '/musicgenres', '/studios',
        '/persons', '/years', '/channels', '/notifications',
        '/scheduledtasks', '/packages', '/plugins',
        '/environment/', '/localization/', '/search/',
        '/images/', '/shows/', '/movies/',
        '/trailers', '/similar', '/suggestions',
        '/playback/', '/sync/', '/devices/',
    ];

    function log(...args) {
        if (DEBUG) console.log('[EmbyAdapter]', ...args);
    }

    function warn(...args) {
        console.warn('[EmbyAdapter]', ...args);
    }

    log(`Emby Adapter v${ADAPTER_VERSION} initializing...`);

    // ========================================
    // Server URL helper — checks MULTIPLE sources
    // ========================================

    /**
     * Get the Emby server URL from the best available source:
     * 1. embyAdapterConfig (set by adapter's own login flow)
     * 2. jellyfin_credentials (set by ConnectionManager after login)
     * 
     * This ensures we can route API requests even if one source is missing.
     */
    function getEmbyServerUrl() {
        // Source 1: adapter config
        try {
            const cfg = JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}');
            if (cfg.serverUrl) return cfg.serverUrl;
        } catch { /* ignore */ }

        // Source 2: jellyfin_credentials
        try {
            const creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
            if (creds.Servers && creds.Servers.length > 0) {
                const server = creds.Servers[0];
                // Try multiple address fields that ConnectionManager might use
                const addr = server.ManualAddress || server.LocalAddress || server.RemoteAddress;
                if (addr) return addr;
            }
        } catch { /* ignore */ }

        return '';
    }

    function getEmbyToken() {
        // Source 1: adapter config
        try {
            const cfg = JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}');
            if (cfg.token) return cfg.token;
        } catch { /* ignore */ }

        // Source 2: jellyfin_credentials
        try {
            const creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
            if (creds.Servers && creds.Servers.length > 0) {
                const token = creds.Servers[0].AccessToken;
                if (token) return token;
            }
        } catch { /* ignore */ }

        return '';
    }

    // ========================================
    // Cross-origin detection
    // ========================================

    function isCrossOrigin(url) {
        if (!url) return false;
        try {
            const u = new URL(url, window.location.origin);
            return u.origin !== window.location.origin;
        } catch { return false; }
    }

    // ========================================
    // API Path Detection
    // ========================================

    /**
     * Check if a pathname looks like a Jellyfin/Emby API call.
     */
    function looksLikeApiPath(pathname) {
        const lp = pathname.toLowerCase();
        // Already has /emby/ prefix
        if (lp.startsWith('/emby/') || lp === '/emby') return true;
        // Match against known API patterns
        for (const pattern of API_PATH_PATTERNS) {
            if (lp.startsWith(pattern) || lp.includes(pattern)) return true;
        }
        return false;
    }

    /**
     * Check whether a URL should be handled by the Emby adapter.
     * 
     * Detection methods:
     * 1. URL already points to the configured Emby server origin
     * 2. URL is cross-origin and path looks like an API call
     * 3. URL is same-origin and path looks like an API call
     *    (ConnectionManager used a relative path → resolved to GitHub Pages)
     * 
     * For method 3: even if no server is configured yet, we STILL detect it
     * as an API call so we can block it (instead of letting it 404 on GitHub Pages).
     */
    function isEmbyApiUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url, window.location.origin);

            // Method 1: match configured server origin
            const serverUrl = getEmbyServerUrl();
            if (serverUrl) {
                try {
                    const s = new URL(serverUrl);
                    if (u.hostname === s.hostname && u.port === s.port) return true;
                } catch { /* ignore */ }
            }

            // Method 2: cross-origin request with API-like path
            if (isCrossOrigin(url) && looksLikeApiPath(u.pathname)) {
                return true;
            }

            // Method 3: same-origin request with API-like path
            // This catches relative URLs that resolved to the GitHub Pages origin.
            // We detect this even WITHOUT a configured server — we'll either redirect
            // (if server is known) or return a synthetic error (if not).
            if (!isCrossOrigin(url) && looksLikeApiPath(u.pathname)) {
                return true;
            }
        } catch { /* ignore */ }
        return false;
    }

    // ========================================
    // URL Transformation
    // ========================================

    /**
     * Rewrite a URL to point at the configured Emby server with /emby/ prefix.
     * 
     * Returns null if the URL needs rewriting but no server is configured
     * (caller should handle this by returning a synthetic error).
     */
    function rewriteUrlForEmby(url) {
        try {
            const u = new URL(url, window.location.origin);
            const serverUrl = getEmbyServerUrl();

            // If URL is same-origin, we MUST redirect it to the Emby server
            if (u.origin === window.location.origin) {
                if (!serverUrl) {
                    // No server configured — can't redirect
                    return null;
                }
                const server = new URL(serverUrl);
                u.protocol = server.protocol;
                u.hostname = server.hostname;
                u.port = server.port;
                log('Redirecting same-origin API call to Emby server:', url, '->', u.toString());
            }

            // Ensure /emby/ prefix
            if (!u.pathname.toLowerCase().startsWith('/emby/') && !u.pathname.toLowerCase().startsWith('/emby')) {
                u.pathname = '/emby' + u.pathname;
            }

            return u.toString();
        } catch { return url; }
    }

    function ensureEmbyPrefix(url) {
        return rewriteUrlForEmby(url);
    }

    // ========================================
    // Version Spoofing
    // ========================================

    function needsVersionSpoof(url) {
        if (!url) return false;
        try {
            const parsed = new URL(url, window.location.origin);
            const pathname = parsed.pathname.toLowerCase();

            for (const path of VERSION_SPOOF_PATHS) {
                const lowerPath = path.toLowerCase();
                if (pathname.endsWith(lowerPath) || pathname.endsWith('/emby' + lowerPath)) {
                    return true;
                }
            }

            if (pathname.endsWith('/system/info') || pathname.endsWith('/emby/system/info')) {
                return true;
            }
        } catch (e) {
            warn('needsVersionSpoof parse error:', e);
        }
        return false;
    }

    function spoofVersionInBody(bodyText) {
        try {
            const data = JSON.parse(bodyText);
            if (data && typeof data === 'object') {
                const origVersion = data.Version;
                data.Version = SPOOFED_JELLYFIN_VERSION;
                if (!data.ProductName) {
                    data.ProductName = 'Jellyfin Server';
                }
                log('Spoofed Version to', SPOOFED_JELLYFIN_VERSION, '(was', origVersion, ')');
                return JSON.stringify(data);
            }
        } catch (e) {
            warn('Version spoof JSON parse error:', e);
        }
        return bodyText;
    }

    // ========================================
    // Auth Header Helpers
    // ========================================

    function buildEmbyAuthHeaderValue(originalValue) {
        if (!originalValue) return originalValue;

        let value = originalValue;
        if (value.startsWith('MediaBrowser ')) {
            value = 'Emby ' + value.substring('MediaBrowser '.length);
        } else if (value.startsWith('Jellyfin ')) {
            value = 'Emby ' + value.substring('Jellyfin '.length);
        }

        const token = getEmbyToken();
        if (token && !value.includes('Token=')) {
            value = value.replace(/\s*$/, '') + ', Token="' + token + '"';
        }

        return value;
    }

    function isProblematicHeader(name) {
        const lk = name.toLowerCase();
        return lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-');
    }

    function transformHeaders(headers) {
        if (!headers) return headers;

        if (headers instanceof Headers) {
            const h = new Headers();
            for (const [key, value] of headers.entries()) {
                const lk = key.toLowerCase();
                if (isProblematicHeader(key)) {
                    if (lk === 'x-emby-authorization' || lk === 'x-mediabrowser-token') {
                        h.set('Authorization', buildEmbyAuthHeaderValue(value));
                    }
                    continue;
                }
                if (lk === 'authorization') {
                    h.set('Authorization', buildEmbyAuthHeaderValue(value));
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
                        result['Authorization'] = buildEmbyAuthHeaderValue(value);
                    }
                    continue;
                }
                if (lk === 'authorization') {
                    result['Authorization'] = buildEmbyAuthHeaderValue(value);
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

    function transformSystemInfo(data) {
        if (!data) return data;
        return {
            ...data,
            Version: SPOOFED_JELLYFIN_VERSION,
            StartupWizardCompleted: data.StartupWizardCompleted ?? true,
            ProductName: data.ProductName || 'Jellyfin Server',
            SupportsLibraryMonitor: data.SupportsLibraryMonitor ?? true,
        };
    }

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

    function transformItemsResponse(data) {
        if (!data) return data;
        if (data.Items && Array.isArray(data.Items)) {
            data.Items = data.Items.map(transformItem);
        }
        return data;
    }

    function transformItem(item) {
        if (!item) return item;
        if (item.ImageTags && typeof item.ImageTags === 'object') {
            item.ImageTags = { ...item.ImageTags };
        }
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
            item.MediaSources = item.MediaSources.map(transformMediaSource);
        }
        return item;
    }

    function transformMediaSource(source) {
        if (!source) return source;
        return {
            ...source,
            SupportsTranscoding: source.SupportsTranscoding ?? true,
            SupportsDirectStream: source.SupportsDirectStream ?? true,
            SupportsDirectPlay: source.SupportsDirectPlay ?? true,
            SupportsProbing: source.SupportsProbing ?? true,
            Protocol: source.Protocol || 'File',
        };
    }

    // ========================================
    // API Path Extraction
    // ========================================

    function extractApiPath(url) {
        try {
            const urlObj = new URL(url, window.location.origin);
            const path = urlObj.pathname;
            const lowerPath = path.toLowerCase();

            if (lowerPath.startsWith('/emby/')) {
                return path.substring(5);
            }
            if (lowerPath.startsWith('/emby')) {
                return path.substring(4) || '/';
            }

            return path;
        } catch (e) {
            return null;
        }
    }

    // ========================================
    // Synthetic Responses
    // ========================================

    /**
     * Create a synthetic System/Info/Public response when no server is configured.
     * This prevents 404 errors and lets ConnectionManager proceed.
     */
    function createSyntheticSystemInfoResponse() {
        const data = {
            LocalAddress: '',
            ServerName: 'Emby Server (Not Configured)',
            Version: SPOOFED_JELLYFIN_VERSION,
            ProductName: 'Jellyfin Server',
            Id: '00000000000000000000000000000000',
            StartupWizardCompleted: true,
        };
        return new Response(JSON.stringify(data), {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' },
        });
    }

    /**
     * Create a synthetic error response for API calls that can't be routed.
     */
    function createSyntheticErrorResponse(url) {
        warn('No Emby server configured, blocking API call:', url);
        return new Response(JSON.stringify({ error: 'No Emby server configured' }), {
            status: 503,
            statusText: 'Service Unavailable',
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
            const crossOrigin = isCrossOrigin(url);
            const embyApi = isEmbyApiUrl(url);

            // For ANY cross-origin or Emby API request, clean up problematic headers
            if (crossOrigin || embyApi) {
                if (modifiedInit.headers) {
                    modifiedInit.headers = transformHeaders(modifiedInit.headers);
                }
                if (input instanceof Request) {
                    const cleanHeaders = transformHeaders(new Headers(input.headers));
                    if (!modifiedInit.headers) {
                        modifiedInit.headers = cleanHeaders;
                    }
                }
            }

            // For Emby API requests, rewrite URL to point at Emby server
            if (embyApi) {
                const newUrl = rewriteUrlForEmby(url);

                // If rewrite returned null, no server is configured
                if (newUrl === null) {
                    // For System/Info requests, return synthetic response
                    // so ConnectionManager doesn't error out completely
                    const lowerPath = new URL(url, window.location.origin).pathname.toLowerCase();
                    if (lowerPath.includes('/system/info')) {
                        log('No server configured, returning synthetic SystemInfo for:', url);
                        return createSyntheticSystemInfoResponse();
                    }
                    // For other API calls, return 503
                    return createSyntheticErrorResponse(url);
                }

                log('Fetch intercepted:', url, '->', newUrl);
                url = newUrl;

                // Reconstruct input with new URL
                if (typeof input === 'string') {
                    input = url;
                } else if (input instanceof Request) {
                    input = new Request(url, input);
                }

                // Ensure headers are cleaned (the URL is now cross-origin)
                if (modifiedInit.headers) {
                    modifiedInit.headers = transformHeaders(modifiedInit.headers);
                }

                // Make the request
                const response = await originalFetch.call(this, input, modifiedInit);

                // Version spoofing
                if (needsVersionSpoof(url) && response.ok) {
                    const cloned = response.clone();
                    try {
                        const text = await cloned.text();
                        const spoofed = spoofVersionInBody(text);
                        return new Response(spoofed, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    } catch (e) {
                        warn('Version spoof failed:', e);
                        return response;
                    }
                }

                // Other response transformations
                if (response.ok) {
                    const apiPath = extractApiPath(url);
                    if (apiPath) {
                        return await transformResponseByPath(response, apiPath);
                    }
                }

                return response;
            }
        } catch (error) {
            warn('Fetch intercept error:', error);
        }

        return originalFetch.call(this, input, modifiedInit);
    };

    async function transformResponseByPath(response, apiPath) {
        const lowerPath = apiPath.toLowerCase();
        if (lowerPath.includes('/system/info')) return response;

        const cloned = response.clone();
        try {
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) return response;

            let data = await cloned.json();

            if (lowerPath.includes('/users/')) {
                data = transformUserData(data);
            } else if (lowerPath.includes('/items')) {
                data = transformItemsResponse(data);
            }

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (e) {
            return response;
        }
    }

    // ========================================
    // XMLHttpRequest Interceptor
    // ========================================

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._embyOrigUrl = url;
        this._isCrossOrigin = isCrossOrigin(url);
        this._isEmbyApi = isEmbyApiUrl(url);

        if (this._isEmbyApi) {
            const newUrl = rewriteUrlForEmby(url);
            if (newUrl !== null) {
                url = newUrl;
                this._isCrossOrigin = true; // After rewrite, definitely cross-origin
                log('XHR intercepted:', method, url);
            } else {
                // No server configured — mark for synthetic response in send()
                this._noServerConfigured = true;
                log('XHR: no server configured for:', method, url);
            }
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this._isCrossOrigin || this._isEmbyApi) {
            const lk = name.toLowerCase();
            if (isProblematicHeader(name)) {
                if (lk === 'x-emby-authorization') {
                    return originalXHRSetHeader.call(this, 'Authorization', buildEmbyAuthHeaderValue(value));
                }
                log('Stripped header:', name);
                return;
            }
            if (lk === 'authorization') {
                return originalXHRSetHeader.call(this, 'Authorization', buildEmbyAuthHeaderValue(value));
            }
        }
        return originalXHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (this._isEmbyApi && needsVersionSpoof(this._embyOrigUrl)) {
            this.addEventListener('readystatechange', function () {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        const spoofed = spoofVersionInBody(this.responseText);
                        Object.defineProperty(this, 'responseText', { value: spoofed, writable: false });
                        Object.defineProperty(this, 'response', { value: spoofed, writable: false });
                    } catch (e) {
                        warn('XHR version spoof error:', e);
                    }
                }
            });
        }
        return originalXHRSend.apply(this, args);
    };

    // ========================================
    // WebSocket Patches
    // ========================================

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function (url, protocols) {
        if (url) {
            log('WebSocket:', url);
            try {
                const serverUrl = getEmbyServerUrl();
                if (serverUrl && !isCrossOrigin(url)) {
                    const u = new URL(url, window.location.origin);
                    const s = new URL(serverUrl);
                    u.protocol = s.protocol === 'https:' ? 'wss:' : 'ws:';
                    u.hostname = s.hostname;
                    u.port = s.port;
                    url = u.toString();
                    log('WebSocket redirected to:', url);
                }
            } catch (e) {
                warn('WebSocket rewrite error:', e);
            }
        }
        const ws = new OriginalWebSocket(url, protocols);
        return ws;
    };

    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket.prototype = OriginalWebSocket.prototype;

    // ========================================
    // UI Patches
    // ========================================

    function applyUIPatches() {
        const apply = () => {
            const style = document.createElement('style');
            style.textContent = `
                /* Emby Adapter UI Patches */
                .adminDrawerLogo { content: url('') !important; }
                .cardContent { min-height: 0; }
            `;
            document.head.appendChild(style);
            log('UI patches applied.');
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

    window.EmbyAdapter = {
        version: ADAPTER_VERSION,
        configure(serverUrl, token) {
            localStorage.setItem('embyAdapterConfig', JSON.stringify({ serverUrl, token }));
            log('Configured:', serverUrl);
        },
        getConfig() {
            try { return JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}'); }
            catch { return {}; }
        },
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
                    'Authorization': `Emby Client="Jellyfin Web (Emby Adapter)", Device="Browser", DeviceId="${getDeviceId()}", Version="${ADAPTER_VERSION}"`,
                },
                body: JSON.stringify({ Username: username, Pw: password }),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                throw new Error(`Auth failed: ${resp.status} ${text}`);
            }
            const data = await resp.json();
            const token = data.AccessToken;

            this.configure(serverUrl, token);
            syncToJellyfinCredentials(serverUrl, data);

            return data;
        },
    };

    function getDeviceId() {
        let id = localStorage.getItem('embyAdapterDeviceId');
        if (!id) {
            id = 'ea_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
            localStorage.setItem('embyAdapterDeviceId', id);
        }
        return id;
    }

    function syncToJellyfinCredentials(serverUrl, authData) {
        try {
            const serverId = authData.ServerId || authData.SessionInfo?.ServerId || '';
            const userId = authData.User?.Id || '';
            const token = authData.AccessToken || '';

            const creds = {
                Servers: [{
                    ManualAddress: serverUrl,
                    LocalAddress: serverUrl,
                    RemoteAddress: serverUrl,
                    Id: serverId,
                    UserId: userId,
                    AccessToken: token,
                    Name: authData.SessionInfo?.ServerName || 'Emby Server',
                    DateLastAccessed: new Date().toISOString(),
                    LastConnectionMode: 2, // Manual
                }],
            };

            localStorage.setItem('jellyfin_credentials', JSON.stringify(creds));
            log('Synced credentials to jellyfin_credentials');
        } catch (e) {
            warn('Failed to sync credentials:', e);
        }
    }

    // ========================================
    // Initialization
    // ========================================

    applyUIPatches();

    // Log current config state for debugging
    const serverUrl = getEmbyServerUrl();
    if (serverUrl) {
        log('Server URL found:', serverUrl);
    } else {
        log('No server URL configured yet — same-origin API calls will be intercepted with synthetic responses');
    }

    log('Emby Adapter initialized successfully.');

})();
