/**
 * Emby API Adapter for Jellyfin Web
 * 
 * Intercepts fetch/XHR requests from Jellyfin Web and adapts them
 * to work with Emby server's API format.
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

    const ADAPTER_VERSION = '1.0.0';
    const STORAGE_KEY = 'emby_adapter_config';
    const EMBY_TOKEN_KEY = 'emby_access_token';
    const EMBY_USER_KEY = 'emby_user_id';
    const EMBY_SERVER_KEY = 'emby_server_url';

    // API paths that do NOT require authentication
    const PUBLIC_PATHS = [
        '/System/Info/Public',
        '/Users/Public',
        '/Branding/Configuration',
        '/Branding/Css',
        '/web/',
        '/Users/AuthenticateByName',
        '/Users/ForgotPassword'
    ];

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
     * Check if a URL points to the Emby server (API request vs static resource)
     */
    function isEmbyApiRequest(url) {
        if (!embyServerUrl) return false;

        try {
            const parsed = new URL(url, window.location.origin);
            const serverParsed = new URL(embyServerUrl);

            // Must be same origin as Emby server (includes port check)
            if (parsed.origin !== serverParsed.origin) return false;

            // Static resources don't need adaptation
            const pathname = parsed.pathname.toLowerCase();
            for (const ext of STATIC_EXTENSIONS) {
                if (pathname.endsWith(ext)) return false;
            }

            // Already has /emby/ prefix - don't double-add
            if (pathname.startsWith('/emby/')) return false;

            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a path is a public (no-auth) endpoint
     */
    function isPublicPath(pathname) {
        for (const pub of PUBLIC_PATHS) {
            if (pathname.includes(pub)) return true;
        }
        return false;
    }

    /**
     * Add /emby/ prefix to API path
     */
    function addEmbyPrefix(url) {
        try {
            const parsed = new URL(url);
            if (!parsed.pathname.startsWith('/emby/')) {
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
     * 
     * IMPORTANT: We use the standard "Authorization" header ONLY (not X-Emby-Authorization)
     * because many Emby servers behind reverse proxies / Cloudflare only whitelist
     * "Content-Type" and "Authorization" in their CORS Access-Control-Allow-Headers.
     * Using custom headers like X-Emby-Authorization triggers a CORS preflight
     * that gets rejected.
     * 
     * Emby accepts both "Emby ..." and "MediaBrowser ..." as the Authorization scheme.
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
     * Transform Jellyfin auth header to Emby format
     * 
     * Jellyfin sends: Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."
     * We transform to: Authorization: Emby Client="...", Device="...", DeviceId="...", Version="...", Token="..."
     * 
     * Key: We ONLY use the standard Authorization header to avoid CORS issues.
     */
    function transformAuthHeader(value) {
        if (!value) return value;

        // Replace MediaBrowser prefix with Emby
        let transformed = value;
        if (transformed.startsWith('MediaBrowser ')) {
            transformed = 'Emby ' + transformed.substring('MediaBrowser '.length);
        }

        // If we have a token and it's not in the header, add it
        if (embyAccessToken && !transformed.includes('Token=')) {
            transformed += ', Token="' + embyAccessToken + '"';
        }

        return transformed;
    }

    /**
     * Transform request headers for Emby compatibility.
     * 
     * CORS strategy: ONLY use standard headers (Authorization, Content-Type)
     * to avoid triggering preflight rejections on servers that don't whitelist
     * custom Emby headers.
     */
    function transformHeaders(headers) {
        const newHeaders = new Headers();
        let authValue = null;
        let hasAuth = false;

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

            // Skip any X-Emby-* custom headers - we don't send them to avoid CORS issues
            if (lowerKey.startsWith('x-emby-') || lowerKey.startsWith('x-mediabrowser-')) {
                // Extract token from X-Emby-Token if present
                if (lowerKey === 'x-emby-token' || lowerKey === 'x-mediabrowser-token') {
                    if (!embyAccessToken) {
                        embyAccessToken = value;
                        localStorage.setItem(EMBY_TOKEN_KEY, value);
                    }
                }
                continue; // Don't copy this header
            }

            if (lowerKey === 'authorization') {
                // Transform the auth header value
                authValue = transformAuthHeader(value);
                hasAuth = true;
            } else {
                newHeaders.set(key, value);
            }
        }

        // Set the Authorization header (standard header, CORS-safe)
        if (authValue) {
            newHeaders.set('Authorization', authValue);
        } else if (embyAccessToken) {
            // No auth header found but we have a token - build one
            newHeaders.set('Authorization', buildEmbyAuthHeaderValue(embyAccessToken));
        }

        return newHeaders;
    }

    /**
     * Transform request body for Emby compatibility
     */
    function transformBody(url, body) {
        if (!body) return body;

        // For AuthenticateByName, ensure we use 'Pw' field
        if (typeof url === 'string' && url.includes('/Users/AuthenticateByName')) {
            try {
                let bodyObj;
                if (typeof body === 'string') {
                    bodyObj = JSON.parse(body);
                } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
                    bodyObj = JSON.parse(new TextDecoder().decode(body));
                } else {
                    return body;
                }

                // Ensure Pw field exists (Emby uses Pw for plaintext password)
                if (bodyObj.Password && !bodyObj.Pw) {
                    bodyObj.Pw = bodyObj.Password;
                }
                if (bodyObj.password && !bodyObj.Pw) {
                    bodyObj.Pw = bodyObj.password;
                }

                return JSON.stringify(bodyObj);
            } catch (e) {
                log('Failed to transform auth body:', e);
            }
        }

        return body;
    }

    /**
     * Handle authentication response - extract and store token
     */
    function handleAuthResponse(url, response) {
        if (typeof url === 'string' && url.includes('/Users/AuthenticateByName')) {
            // Clone response to read body without consuming it
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

        // Handle logout
        if (typeof url === 'string' && url.includes('/Sessions/Logout')) {
            embyAccessToken = '';
            embyUserId = '';
            localStorage.removeItem(EMBY_TOKEN_KEY);
            localStorage.removeItem(EMBY_USER_KEY);
            log('Logged out, token cleared');
        }
    }

    // ==================== Fetch Interceptor ====================

    const originalFetch = window.fetch;

    window.fetch = function(input, init) {
        if (!adapterEnabled) {
            return originalFetch.call(this, input, init);
        }

        let url;
        let options = init || {};

        // Handle Request object input
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

        // Check if this request targets the Emby server
        if (!isEmbyApiRequest(url)) {
            return originalFetch.call(this, input, init);
        }

        log('Intercepting:', url);

        // Transform URL: add /emby/ prefix
        const newUrl = addEmbyPrefix(url);

        // Transform headers (CORS-safe: only standard Authorization header)
        const newHeaders = transformHeaders(options.headers);

        // Transform body (e.g., auth requests)
        const newBody = transformBody(url, options.body);

        const newOptions = {
            ...options,
            headers: newHeaders,
            body: newBody
        };

        log('Adapted to:', newUrl);

        return originalFetch.call(this, newUrl, newOptions).then(response => {
            // Intercept auth responses to store token
            handleAuthResponse(url, response);
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

        let adaptedUrl = url;
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

            // Skip custom Emby headers to avoid CORS issues
            if (lowerName.startsWith('x-emby-') || lowerName.startsWith('x-mediabrowser-')) {
                // Extract token if present
                if ((lowerName === 'x-emby-token' || lowerName === 'x-mediabrowser-token') && value) {
                    if (!embyAccessToken) {
                        embyAccessToken = value;
                        localStorage.setItem(EMBY_TOKEN_KEY, value);
                    }
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
        if (this._embyAdapted) {
            const transformedBody = transformBody(this._embyOriginalUrl, body);

            // If no Authorization header was set but we have a token, add it
            if (embyAccessToken && !this._embyHeaders['Authorization']) {
                const authValue = buildEmbyAuthHeaderValue(embyAccessToken);
                XHRSetHeader.call(this, 'Authorization', authValue);
            }

            // Listen for auth responses
            this.addEventListener('load', () => {
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
                    } catch (e) {
                        // ignore
                    }
                }
            });

            return XHRSend.call(this, transformedBody);
        }
        return XHRSend.call(this, body);
    };

    // ==================== Image URL Adapter ====================

    /**
     * For image URLs that bypass fetch (e.g., <img src="...">),
     * we need to add the api_key query parameter.
     * 
     * This observer watches for new img elements and adapts their src.
     */
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

        // Also handle existing images
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
                // Add /emby/ prefix if needed
                if (!srcUrl.pathname.startsWith('/emby/')) {
                    srcUrl.pathname = '/emby' + srcUrl.pathname;
                }
                srcUrl.searchParams.set('api_key', embyAccessToken);
                img.setAttribute('src', srcUrl.toString());
            }
        } catch (e) {
            // ignore invalid URLs
        }
    }

    // ==================== WebSocket Adapter ====================

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        if (adapterEnabled && embyServerUrl) {
            try {
                const wsUrl = new URL(url);
                const serverUrl = new URL(embyServerUrl);

                if (wsUrl.hostname === serverUrl.hostname &&
                    (wsUrl.port || '80') === (serverUrl.port || '80')) {
                    // Add /emby prefix to WebSocket path if needed
                    if (!wsUrl.pathname.startsWith('/emby')) {
                        wsUrl.pathname = '/emby' + wsUrl.pathname;
                    }
                    // Add api_key parameter (query param is CORS-safe for WebSocket)
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

        /**
         * Set the Emby server URL (supports host:port format)
         */
        setServerUrl: function(url) {
            // Normalize: ensure protocol prefix
            let normalized = url.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(normalized)) {
                normalized = 'http://' + normalized;
            }
            embyServerUrl = normalized;
            localStorage.setItem(EMBY_SERVER_KEY, embyServerUrl);
            log('Server URL set:', embyServerUrl);
        },

        /**
         * Get the current Emby server URL
         */
        getServerUrl: function() {
            return embyServerUrl;
        },

        /**
         * Set the access token manually
         */
        setAccessToken: function(token) {
            embyAccessToken = token;
            localStorage.setItem(EMBY_TOKEN_KEY, token);
        },

        /**
         * Get current access token
         */
        getAccessToken: function() {
            return embyAccessToken;
        },

        /**
         * Get current user ID
         */
        getUserId: function() {
            return embyUserId;
        },

        /**
         * Enable/disable the adapter
         */
        setEnabled: function(enabled) {
            adapterEnabled = enabled;
            log('Adapter', enabled ? 'enabled' : 'disabled');
        },

        /**
         * Check if adapter is enabled
         */
        isEnabled: function() {
            return adapterEnabled;
        },

        /**
         * Clear all stored credentials
         */
        clearCredentials: function() {
            embyAccessToken = '';
            embyUserId = '';
            localStorage.removeItem(EMBY_TOKEN_KEY);
            localStorage.removeItem(EMBY_USER_KEY);
            localStorage.removeItem(EMBY_SERVER_KEY);
        },

        /**
         * Test connection to Emby server
         */
        testConnection: async function(serverUrl) {
            // Normalize URL
            let baseUrl = serverUrl || embyServerUrl;
            baseUrl = baseUrl.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            const url = baseUrl + '/emby/System/Info/Public';
            try {
                // Use original fetch to avoid double-adaptation
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

        /**
         * Authenticate with Emby server.
         * Uses standard Authorization header only (CORS-safe).
         */
        authenticate: async function(serverUrl, username, password) {
            // Normalize URL
            let baseUrl = (serverUrl || embyServerUrl).trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            const url = baseUrl + '/emby/Users/AuthenticateByName';

            // Build auth header WITHOUT token (login request)
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

    // Setup image observer when DOM is ready
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
