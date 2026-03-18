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

    const ADAPTER_VERSION = '1.4.0';
    let DEBUG = localStorage.getItem('embyAdapterDebug') === 'true';

    const SPOOFED_JELLYFIN_VERSION = '10.10.7';

    // Paths whose responses need version spoofing (matched case-insensitively)
    const VERSION_SPOOF_PATHS = [
        '/system/info/public',
        '/system/info',
    ];

    // Known Jellyfin/Emby API path prefixes (lowercase).
    // If a request to the SAME origin matches one of these, it is actually
    // an API call that should be routed to the configured Emby server.
    const API_PATH_PATTERNS = [
        '/system/', '/users/', '/items', '/sessions',
        '/library/', '/branding/', '/displaypreferences',
        '/playbackinfo', '/livestreams', '/quickconnect',
        '/mediasources', '/audio/', '/videos/',
        '/artists', '/genres', '/musicgenres', '/studios',
        '/persons', '/years', '/channels', '/notifications',
        '/scheduledtasks', '/packages', '/plugins',
        '/environment/', '/localization/', '/search/',
        '/images/', '/web/', '/shows/', '/movies/',
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
    // Server URL helper
    // ========================================

    function getEmbyServerUrl() {
        try {
            const cfg = JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}');
            return cfg.serverUrl || '';
        } catch { return ''; }
    }

    function getEmbyToken() {
        try {
            const cfg = JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}');
            return cfg.token || '';
        } catch { return ''; }
    }

    // ========================================
    // Cross-origin detection
    // ========================================

    /**
     * Check if a URL is cross-origin (different host/port from current page).
     * ALL cross-origin API requests need header cleanup for CORS safety.
     */
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
     * This is used to detect same-origin API requests that should be
     * routed to the Emby server (e.g. "/System/Info/Public" on GitHub Pages).
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
     * Check whether a URL targets the configured Emby server (or should be routed there).
     * 
     * Three detection methods:
     * 1. URL already points to the configured Emby server origin
     * 2. URL is cross-origin and path looks like an API call
     * 3. URL is SAME-origin but path looks like an API call → this means
     *    ConnectionManager used a relative path that resolved to GitHub Pages
     */
    function isEmbyApiUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url, window.location.origin);
            const serverUrl = getEmbyServerUrl();

            // Method 1: match configured server origin
            if (serverUrl) {
                const s = new URL(serverUrl);
                if (u.hostname === s.hostname && u.port === s.port) return true;
            }

            // Method 2: cross-origin request with API-like path
            if (isCrossOrigin(url) && looksLikeApiPath(u.pathname)) {
                return true;
            }

            // Method 3: same-origin request with API-like path
            // This catches the critical case where ConnectionManager builds
            // relative URLs like "/System/Info/Public" which resolve to the
            // GitHub Pages origin instead of the Emby server.
            if (serverUrl && !isCrossOrigin(url) && looksLikeApiPath(u.pathname)) {
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
     * Handles two cases:
     * 1. Same-origin relative API path → redirect to Emby server
     * 2. Already cross-origin (Emby server) → just ensure /emby/ prefix
     */
    function rewriteUrlForEmby(url) {
        try {
            const u = new URL(url, window.location.origin);
            const serverUrl = getEmbyServerUrl();

            // If URL is same-origin (GitHub Pages) but looks like an API path,
            // we need to redirect it to the Emby server
            if (serverUrl && u.origin === window.location.origin) {
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

    // Keep backward compat (used in some places)
    function ensureEmbyPrefix(url) {
        return rewriteUrlForEmby(url);
    }

    // ========================================
    // Version Spoofing
    // ========================================

    /**
     * Determine if a response from this URL needs its Version field spoofed.
     * Uses CASE-INSENSITIVE matching because jellyfin-apiclient sends
     * lowercase paths like "system/info/public".
     */
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

    /**
     * Spoof the Version field in a system-info JSON response body.
     */
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

    /**
     * Build a proper Emby authorization header value.
     */
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

    /**
     * Check if a header name is a non-standard Emby/Jellyfin header that
     * would trigger CORS preflight failures.
     */
    function isProblematicHeader(name) {
        const lk = name.toLowerCase();
        return lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-');
    }

    /**
     * Transform headers for CORS safety.
     * Strips X-Emby-*, X-MediaBrowser-* and converts auth to standard Authorization.
     */
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
                    continue; // drop it
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
    // Fetch Interceptor
    // ========================================

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        let modifiedInit = init ? { ...init } : {};

        try {
            const crossOrigin = isCrossOrigin(url);
            const embyApi = isEmbyApiUrl(url);

            // For ANY cross-origin request OR Emby API request, clean up problematic headers
            if (crossOrigin || embyApi) {
                if (modifiedInit.headers) {
                    modifiedInit.headers = transformHeaders(modifiedInit.headers);
                }
                // If input is a Request object, we need to rebuild it with clean headers
                if (input instanceof Request) {
                    const cleanHeaders = transformHeaders(new Headers(input.headers));
                    if (!modifiedInit.headers) {
                        modifiedInit.headers = cleanHeaders;
                    }
                }
            }

            // For Emby API requests, rewrite URL to point at Emby server + /emby/ prefix
            if (embyApi) {
                const newUrl = rewriteUrlForEmby(url);
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
            url = rewriteUrlForEmby(url);
            this._isCrossOrigin = true; // After rewrite, it's definitely cross-origin
            log('XHR intercepted:', method, url);
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        // For ALL cross-origin or Emby API requests, strip problematic headers
        if (this._isCrossOrigin || this._isEmbyApi) {
            const lk = name.toLowerCase();
            if (isProblematicHeader(name)) {
                if (lk === 'x-emby-authorization') {
                    // Fold into standard Authorization header
                    return originalXHRSetHeader.call(this, 'Authorization', buildEmbyAuthHeaderValue(value));
                }
                log('Stripped header:', name);
                return; // drop the header entirely
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
            // Rewrite WebSocket URL to point at Emby server if needed
            try {
                const serverUrl = getEmbyServerUrl();
                if (serverUrl && !isCrossOrigin(url)) {
                    // Same-origin WebSocket → redirect to Emby server
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
                    Id: serverId,
                    UserId: userId,
                    AccessToken: token,
                    Name: authData.SessionInfo?.ServerName || 'Emby Server',
                    DateLastAccessed: new Date().toISOString(),
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
    log('Emby Adapter initialized successfully.');

})();
