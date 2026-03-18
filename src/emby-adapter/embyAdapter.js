/**
 * Emby API Adapter for Jellyfin Web v1.2.0
 * 
 * Based on the stable ce25248 version, with two targeted fixes:
 * 1. config.json interception: tells ConnectionManager the real Emby server URL
 *    (prevents it from using GitHub Pages origin as the server)
 * 2. Version spoofing: replaces Emby 4.x version with 10.10.7
 *    (prevents "server needs to be updated" error)
 * 
 * Key differences handled:
 * 1. URL prefix: Emby requires /emby/ prefix on API paths
 * 2. Auth header: Uses "Emby" scheme in standard Authorization header
 *    (avoids X-Emby-Authorization to prevent CORS preflight issues)
 * 3. Token passing: Embedded in Authorization header value
 */

(function() {
    'use strict';

    // ==================== Configuration ====================

    const ADAPTER_VERSION = '1.2.0';
    const STORAGE_KEY = 'emby_adapter_config';
    const EMBY_TOKEN_KEY = 'emby_access_token';
    const EMBY_USER_KEY = 'emby_user_id';
    const EMBY_SERVER_KEY = 'emby_server_url';
    const SPOOFED_VERSION = '10.10.7';

    // Paths that should NOT get the /emby/ prefix (static resources)
    const STATIC_EXTENSIONS = [
        '.js', '.css', '.html', '.htm', '.woff', '.woff2', '.ttf',
        '.eot', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
        '.map', '.json', '.webp', '.avif'
    ];

    // ==================== State ====================

    let embyServerUrl = localStorage.getItem(EMBY_SERVER_KEY) || '';
    let embyAccessToken = localStorage.getItem(EMBY_TOKEN_KEY) || '';
    let embyUserId = localStorage.getItem(EMBY_USER_KEY) || '';
    let adapterEnabled = true;

    // ==================== Helpers ====================

    function log(...args) {
        if (localStorage.getItem('emby_adapter_debug') === 'true') {
            console.log('[EmbyAdapter]', ...args);
        }
    }

    function warn(...args) {
        console.warn('[EmbyAdapter]', ...args);
    }

    /**
     * Check if a URL is a same-origin config.json request.
     * We intercept this to inject the Emby server address so that
     * ConnectionManager connects to the real server, not GitHub Pages.
     */
    function isConfigJsonRequest(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.origin === window.location.origin &&
                   u.pathname.endsWith('/config.json');
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a URL points to the Emby server (API request vs static resource)
     */
    function isEmbyApiRequest(url) {
        if (!embyServerUrl) return false;

        try {
            const parsed = new URL(url, window.location.origin);
            const serverParsed = new URL(embyServerUrl);

            // Must be same origin as Emby server (includes port check)
            if (parsed.hostname !== serverParsed.hostname) return false;
            if ((parsed.port || '') !== (serverParsed.port || '')) return false;

            // Static resources don't need adaptation
            const pathname = parsed.pathname.toLowerCase();
            for (const ext of STATIC_EXTENSIONS) {
                if (pathname.endsWith(ext)) return false;
            }

            // Already has /emby/ prefix - still an Emby API request, just don't double-add
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if response needs version spoofing.
     * Applies to /System/Info/Public and /System/Info endpoints.
     */
    function needsVersionSpoof(url) {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            return pathname.endsWith('/system/info/public') ||
                   pathname.endsWith('/system/info') ||
                   pathname.endsWith('/emby/system/info/public') ||
                   pathname.endsWith('/emby/system/info');
        } catch (e) {
            return false;
        }
    }

    /**
     * Replace version in JSON response body.
     * Emby reports 4.x which fails Jellyfin's >= 10.9.0 check.
     */
    function spoofVersionInJson(bodyText) {
        try {
            const data = JSON.parse(bodyText);
            if (data && typeof data.Version === 'string') {
                log('Spoofing version:', data.Version, '->', SPOOFED_VERSION);
                data.Version = SPOOFED_VERSION;
                // Also ensure ProductName looks like Jellyfin
                if (!data.ProductName || data.ProductName.toLowerCase().includes('emby')) {
                    data.ProductName = 'Jellyfin Server';
                }
                return JSON.stringify(data);
            }
        } catch (e) {
            warn('Version spoof parse error:', e);
        }
        return bodyText;
    }

    /**
     * Add /emby/ prefix to API path
     */
    function addEmbyPrefix(url) {
        try {
            const parsed = new URL(url);
            if (!parsed.pathname.toLowerCase().startsWith('/emby/') &&
                !parsed.pathname.toLowerCase().startsWith('/emby')) {
                parsed.pathname = '/emby' + parsed.pathname;
            }
            return parsed.toString();
        } catch (e) {
            // Relative URL
            if (!url.startsWith('/emby/')) {
                return '/emby' + (url.startsWith('/') ? url : '/' + url);
            }
            return url;
        }
    }

    /**
     * Build the Emby auth header value.
     * Uses the standard "Authorization" header ONLY (not X-Emby-Authorization)
     * to avoid CORS preflight issues.
     */
    function buildEmbyAuthHeaderValue(token) {
        const deviceId = localStorage.getItem('emby_device_id') ||
                        ('emby-web-' + Math.random().toString(36).substr(2, 9));
        localStorage.setItem('emby_device_id', deviceId);

        const browser = navigator.userAgent.includes('Chrome') ? 'Chrome' :
                       navigator.userAgent.includes('Firefox') ? 'Firefox' :
                       navigator.userAgent.includes('Safari') ? 'Safari' : 'Browser';

        let value = 'Emby Client="Jellyfin Web (Emby)", Device="' + browser +
                   '", DeviceId="' + deviceId + '", Version="' + ADAPTER_VERSION + '"';

        if (token) {
            value += ', Token="' + token + '"';
        }

        return value;
    }

    /**
     * Transform Jellyfin auth header to Emby format.
     * Replaces MediaBrowser/Jellyfin prefix with Emby.
     */
    function transformAuthHeader(value) {
        if (!value) return value;

        let transformed = value;
        if (transformed.startsWith('MediaBrowser ')) {
            transformed = 'Emby ' + transformed.substring('MediaBrowser '.length);
        } else if (transformed.startsWith('Jellyfin ')) {
            transformed = 'Emby ' + transformed.substring('Jellyfin '.length);
        }

        // If we have a token and it's not in the header, add it
        if (embyAccessToken && !transformed.includes('Token=')) {
            transformed += ', Token="' + embyAccessToken + '"';
        }

        return transformed;
    }

    /**
     * Transform request headers for Emby compatibility.
     * CORS strategy: ONLY use standard headers (Authorization, Content-Type).
     */
    function transformHeaders(headers) {
        const newHeaders = new Headers();
        let authValue = null;

        // Handle various header input types
        const entries = [];
        if (headers instanceof Headers) {
            headers.forEach((value, key) => entries.push([key, value]));
        } else if (Array.isArray(headers)) {
            entries.push(...headers);
        } else if (headers && typeof headers === 'object') {
            Object.entries(headers).forEach(([key, value]) => entries.push([key, value]));
        }

        for (const [key, value] of entries) {
            const lowerKey = key.toLowerCase();

            // Skip any X-Emby-* / X-MediaBrowser-* custom headers for CORS safety
            if (lowerKey.startsWith('x-emby-') || lowerKey.startsWith('x-mediabrowser-')) {
                // Extract token if present in custom header
                if ((lowerKey === 'x-emby-token' || lowerKey === 'x-mediabrowser-token') && value) {
                    if (!embyAccessToken) {
                        embyAccessToken = value;
                        localStorage.setItem(EMBY_TOKEN_KEY, value);
                    }
                }
                // If X-Emby-Authorization, use it as the base for our Authorization header
                if (lowerKey === 'x-emby-authorization') {
                    authValue = transformAuthHeader(value);
                }
                continue; // Don't copy this header
            }

            if (lowerKey === 'authorization') {
                authValue = transformAuthHeader(value);
            } else {
                newHeaders.set(key, value);
            }
        }

        // Set the Authorization header
        if (authValue) {
            newHeaders.set('Authorization', authValue);
        } else if (embyAccessToken) {
            newHeaders.set('Authorization', buildEmbyAuthHeaderValue(embyAccessToken));
        }

        return newHeaders;
    }

    /**
     * Handle authentication response - extract and store token
     */
    function handleAuthResponse(url, response) {
        if (typeof url === 'string' && url.includes('/Users/AuthenticateByName')) {
            const cloned = response.clone();
            cloned.json().then(data => {
                if (data && data.AccessToken) {
                    embyAccessToken = data.AccessToken;
                    embyUserId = data.User ? data.User.Id : '';
                    localStorage.setItem(EMBY_TOKEN_KEY, embyAccessToken);
                    localStorage.setItem(EMBY_USER_KEY, embyUserId);
                    log('Authentication successful, token stored');
                }
            }).catch(e => {
                log('Failed to parse auth response:', e);
            });
        }

        if (typeof url === 'string' && url.includes('/Sessions/Logout')) {
            embyAccessToken = '';
            embyUserId = '';
            localStorage.removeItem(EMBY_TOKEN_KEY);
            localStorage.removeItem(EMBY_USER_KEY);
            log('Logged out, token cleared');
        }
    }

    /**
     * Generate a synthetic config.json response.
     * This tells ConnectionManager where the Emby server is,
     * preventing it from falling back to window.location.origin (GitHub Pages).
     */
    function createConfigJsonResponse() {
        const config = {};
        if (embyServerUrl) {
            config.servers = [embyServerUrl];
        }
        config.menuLinks = [];
        config.multiserver = false;

        log('config.json intercepted, servers:', config.servers || '(none)');

        return new Response(JSON.stringify(config), {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ==================== Fetch Interceptor ====================

    const originalFetch = window.fetch;

    window.fetch = function(input, init) {
        if (!adapterEnabled) {
            return originalFetch.call(this, input, init);
        }

        let url;
        let options = init || {};

        if (input instanceof Request) {
            url = input.url;
            if (!init) {
                options = {
                    method: input.method,
                    headers: input.headers,
                    body: input.body,
                    mode: input.mode,
                    credentials: input.credentials,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    integrity: input.integrity
                };
            }
        } else {
            url = String(input);
        }

        // ---- Intercept config.json ----
        if (isConfigJsonRequest(url)) {
            return Promise.resolve(createConfigJsonResponse());
        }

        // ---- Only modify requests going to the Emby server ----
        if (!isEmbyApiRequest(url)) {
            // For ANY cross-origin request, still strip X-Emby-* headers for CORS safety
            try {
                const reqUrl = new URL(url, window.location.origin);
                if (reqUrl.origin !== window.location.origin && options.headers) {
                    const newHeaders = transformHeaders(options.headers);
                    options = { ...options, headers: newHeaders };
                }
            } catch (e) {}
            return originalFetch.call(this, input instanceof Request ? input : url, options);
        }

        log('Intercepting fetch:', url);

        // Transform URL: add /emby/ prefix
        const newUrl = addEmbyPrefix(url);

        // Transform headers
        const newHeaders = transformHeaders(options.headers);

        const newOptions = {
            ...options,
            headers: newHeaders
        };

        log('Adapted to:', newUrl);

        return originalFetch.call(this, newUrl, newOptions).then(response => {
            // Handle auth responses
            handleAuthResponse(url, response);

            // Version spoofing for System/Info endpoints
            if (needsVersionSpoof(newUrl) && response.ok) {
                return response.clone().text().then(bodyText => {
                    const spoofed = spoofVersionInJson(bodyText);
                    return new Response(spoofed, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                });
            }

            return response;
        });
    };

    // ==================== XMLHttpRequest Interceptor ====================

    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const XHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        this._embyOriginalUrl = url;
        this._embyMethod = method;
        this._embyHeaders = {};
        this._embyAdapted = false;
        this._embyIsConfigJson = false;

        let adaptedUrl = url;

        // Check config.json first
        if (adapterEnabled && isConfigJsonRequest(String(url))) {
            this._embyIsConfigJson = true;
            // Don't actually open the request, we'll fake it in send()
            return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
        }

        if (adapterEnabled && isEmbyApiRequest(String(url))) {
            adaptedUrl = addEmbyPrefix(String(url));
            this._embyAdapted = true;
            log('XHR Intercepting:', url, '->', adaptedUrl);
        }

        return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this._embyAdapted) {
            const lowerName = name.toLowerCase();

            // Skip custom Emby headers for CORS safety
            if (lowerName.startsWith('x-emby-') || lowerName.startsWith('x-mediabrowser-')) {
                if ((lowerName === 'x-emby-token' || lowerName === 'x-mediabrowser-token') && value) {
                    if (!embyAccessToken) {
                        embyAccessToken = value;
                        localStorage.setItem(EMBY_TOKEN_KEY, value);
                    }
                }
                if (lowerName === 'x-emby-authorization') {
                    const transformed = transformAuthHeader(value);
                    this._embyHeaders['Authorization'] = transformed;
                    return XHRSetHeader.call(this, 'Authorization', transformed);
                }
                return; // Don't send this header
            }

            if (lowerName === 'authorization') {
                const transformed = transformAuthHeader(value);
                this._embyHeaders['Authorization'] = transformed;
                return XHRSetHeader.call(this, 'Authorization', transformed);
            }
        }
        this._embyHeaders[name] = value;
        return XHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function(body) {
        // Handle config.json interception
        if (this._embyIsConfigJson) {
            const self = this;
            const configData = JSON.stringify({
                servers: embyServerUrl ? [embyServerUrl] : [],
                menuLinks: [],
                multiserver: false
            });
            log('XHR config.json intercepted');
            setTimeout(function() {
                // Fake a successful response
                Object.defineProperty(self, 'readyState', { value: 4, writable: false, configurable: true });
                Object.defineProperty(self, 'status', { value: 200, writable: false, configurable: true });
                Object.defineProperty(self, 'statusText', { value: 'OK', writable: false, configurable: true });
                Object.defineProperty(self, 'responseText', { value: configData, writable: false, configurable: true });
                Object.defineProperty(self, 'response', { value: configData, writable: false, configurable: true });
                if (typeof self.onreadystatechange === 'function') {
                    self.onreadystatechange();
                }
                self.dispatchEvent(new Event('readystatechange'));
                self.dispatchEvent(new Event('load'));
                self.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
        }

        if (this._embyAdapted) {
            // Add auth header if missing
            if (embyAccessToken && !this._embyHeaders['Authorization']) {
                const authValue = buildEmbyAuthHeaderValue(embyAccessToken);
                XHRSetHeader.call(this, 'Authorization', authValue);
            }

            // Version spoofing for System/Info
            if (needsVersionSpoof(this._embyOriginalUrl)) {
                this.addEventListener('readystatechange', function() {
                    if (this.readyState === 4 && this.status === 200) {
                        try {
                            const spoofed = spoofVersionInJson(this.responseText);
                            Object.defineProperty(this, 'responseText', { value: spoofed, writable: false, configurable: true });
                            Object.defineProperty(this, 'response', { value: spoofed, writable: false, configurable: true });
                        } catch (e) {
                            warn('XHR version spoof error:', e);
                        }
                    }
                });
            }

            // Listen for auth responses
            this.addEventListener('load', function() {
                if (this._embyOriginalUrl && this._embyOriginalUrl.includes('/Users/AuthenticateByName')) {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (data && data.AccessToken) {
                            embyAccessToken = data.AccessToken;
                            embyUserId = data.User ? data.User.Id : '';
                            localStorage.setItem(EMBY_TOKEN_KEY, embyAccessToken);
                            localStorage.setItem(EMBY_USER_KEY, embyUserId);
                            log('XHR Auth successful, token stored');
                        }
                    } catch (e) {}
                }
            });

            return XHRSend.call(this, body);
        }

        return XHRSend.call(this, body);
    };

    // ==================== Image URL Adapter ====================

    function setupImageObserver() {
        if (!embyServerUrl) return;

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        adaptImageUrls(node);
                    }
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        document.querySelectorAll('img').forEach(adaptImageElement);
    }

    function adaptImageUrls(element) {
        if (element.tagName === 'IMG') {
            adaptImageElement(element);
        }
        element.querySelectorAll && element.querySelectorAll('img').forEach(adaptImageElement);
    }

    function adaptImageElement(img) {
        const src = img.getAttribute('src');
        if (!src || !embyServerUrl || !embyAccessToken) return;

        try {
            const srcUrl = new URL(src, window.location.origin);
            const serverUrl = new URL(embyServerUrl);

            if (srcUrl.origin === serverUrl.origin && !srcUrl.searchParams.has('api_key')) {
                if (!srcUrl.pathname.startsWith('/emby/')) {
                    srcUrl.pathname = '/emby' + srcUrl.pathname;
                }
                srcUrl.searchParams.set('api_key', embyAccessToken);
                img.setAttribute('src', srcUrl.toString());
            }
        } catch (e) {}
    }

    // ==================== WebSocket Adapter ====================

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        if (adapterEnabled && embyServerUrl) {
            try {
                const wsUrl = new URL(url);
                const serverUrl = new URL(embyServerUrl);

                // If WebSocket is going to same-origin (GitHub Pages), redirect to Emby server
                if (wsUrl.hostname === window.location.hostname) {
                    wsUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
                    wsUrl.hostname = serverUrl.hostname;
                    wsUrl.port = serverUrl.port;
                    log('WebSocket redirected to Emby server:', wsUrl.toString());
                }

                // If WebSocket is going to the Emby server
                if (wsUrl.hostname === serverUrl.hostname &&
                    (wsUrl.port || '') === (serverUrl.port || '')) {
                    // Add /emby prefix if needed
                    if (!wsUrl.pathname.startsWith('/emby')) {
                        wsUrl.pathname = '/emby' + wsUrl.pathname;
                    }
                    // Add api_key parameter
                    if (embyAccessToken && !wsUrl.searchParams.has('api_key')) {
                        wsUrl.searchParams.set('api_key', embyAccessToken);
                    }
                    log('WebSocket adapted:', url, '->', wsUrl.toString());
                    url = wsUrl.toString();
                }
            } catch (e) {
                log('WebSocket URL parse error:', e);
            }
        }
        return new OriginalWebSocket(url, protocols);
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // ==================== Public API ====================

    window.EmbyAdapter = {
        version: ADAPTER_VERSION,

        setServerUrl: function(url) {
            let normalized = url.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(normalized)) {
                normalized = 'http://' + normalized;
            }
            embyServerUrl = normalized;
            localStorage.setItem(EMBY_SERVER_KEY, embyServerUrl);
            log('Server URL set:', embyServerUrl);
        },

        getServerUrl: function() {
            return embyServerUrl;
        },

        setAccessToken: function(token) {
            embyAccessToken = token;
            localStorage.setItem(EMBY_TOKEN_KEY, token);
        },

        getAccessToken: function() {
            return embyAccessToken;
        },

        getUserId: function() {
            return embyUserId;
        },

        setEnabled: function(enabled) {
            adapterEnabled = enabled;
            log('Adapter', enabled ? 'enabled' : 'disabled');
        },

        isEnabled: function() {
            return adapterEnabled;
        },

        clearCredentials: function() {
            embyAccessToken = '';
            embyUserId = '';
            embyServerUrl = '';
            localStorage.removeItem(EMBY_TOKEN_KEY);
            localStorage.removeItem(EMBY_USER_KEY);
            localStorage.removeItem(EMBY_SERVER_KEY);
            localStorage.removeItem('jellyfin_credentials');
            localStorage.removeItem('emby_server_name');
            localStorage.removeItem('emby_server_id');
        },

        testConnection: async function(serverUrl) {
            let baseUrl = serverUrl || embyServerUrl;
            baseUrl = baseUrl.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            const url = baseUrl + '/emby/System/Info/Public';
            try {
                const resp = await originalFetch(url, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!resp.ok) return { success: false, error: 'HTTP ' + resp.status };
                const data = await resp.json();
                return {
                    success: true,
                    serverName: data.ServerName,
                    version: data.Version,
                    id: data.Id
                };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },

        authenticate: async function(serverUrl, username, password) {
            let baseUrl = (serverUrl || embyServerUrl).trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            const url = baseUrl + '/emby/Users/AuthenticateByName';
            const authValue = buildEmbyAuthHeaderValue(null);

            try {
                const resp = await originalFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': authValue
                    },
                    body: JSON.stringify({
                        Username: username,
                        Pw: password
                    })
                });

                if (!resp.ok) {
                    const errorText = await resp.text();
                    return { success: false, error: 'Authentication failed: HTTP ' + resp.status, details: errorText };
                }

                const data = await resp.json();

                // Store credentials
                embyAccessToken = data.AccessToken;
                embyUserId = data.User.Id;
                embyServerUrl = baseUrl;
                localStorage.setItem(EMBY_TOKEN_KEY, embyAccessToken);
                localStorage.setItem(EMBY_USER_KEY, embyUserId);
                localStorage.setItem(EMBY_SERVER_KEY, embyServerUrl);

                return {
                    success: true,
                    accessToken: data.AccessToken,
                    userId: data.User.Id,
                    userName: data.User.Name,
                    serverId: data.ServerId
                };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
    };

    // ==================== Initialization ====================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupImageObserver);
    } else {
        setupImageObserver();
    }

    log('Emby Adapter v' + ADAPTER_VERSION + ' initialized');
    if (embyServerUrl) {
        log('Server:', embyServerUrl);
        log('Token:', embyAccessToken ? 'present' : 'none');
    }

})();
