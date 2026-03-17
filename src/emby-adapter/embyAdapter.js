/**
 * Emby API Adapter for Jellyfin Web
 * 
 * Intercepts fetch/XHR requests from Jellyfin Web and adapts them
 * to work with Emby server's API format.
 * 
 * Key differences handled:
 * 1. URL prefix: Emby requires /emby/ prefix on API paths
 * 2. Auth header: Emby uses "Emby" scheme + X-Emby-Authorization
 * 3. Token passing: Emby supports X-Emby-Token header
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

            // Must be same origin as Emby server
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
            if (!parsed.pathname.startsWith('/emby/') && !parsed.pathname.startsWith('/emby/')) {
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
     * Transform Jellyfin auth header to Emby format
     * 
     * Jellyfin: Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."
     * Emby:     X-Emby-Authorization: Emby Client="...", Device="...", DeviceId="...", Version="...", Token="..."
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
     * Transform request headers for Emby compatibility
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
            if (lowerKey === 'authorization') {
                // Capture and transform the auth header
                authValue = transformAuthHeader(value);
            } else if (lowerKey === 'x-emby-authorization') {
                // Already in Emby format, keep it
                authValue = value;
            } else {
                newHeaders.set(key, value);
            }
        }

        // Set the Emby auth header
        if (authValue) {
            newHeaders.set('X-Emby-Authorization', authValue);
            // Also keep Authorization for compatibility
            newHeaders.set('Authorization', authValue);
        } else if (embyAccessToken) {
            // No auth header found but we have a token - add X-Emby-Token
            newHeaders.set('X-Emby-Token', embyAccessToken);
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

        // Transform headers
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
            if (lowerName === 'authorization') {
                const transformed = transformAuthHeader(value);
                XHRSetHeader.call(this, 'X-Emby-Authorization', transformed);
                XHRSetHeader.call(this, 'Authorization', transformed);
                return;
            }
        }
        this._embyHeaders[name] = value;
        return XHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function(body) {
        if (this._embyAdapted) {
            const transformedBody = transformBody(this._embyOriginalUrl, body);

            // Add token header if not already present
            if (embyAccessToken && !this._embyHeaders['X-Emby-Token'] && !this._embyHeaders['Authorization']) {
                XHRSetHeader.call(this, 'X-Emby-Token', embyAccessToken);
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

                if (wsUrl.hostname === serverUrl.hostname && wsUrl.port === serverUrl.port) {
                    // Add /emby prefix to WebSocket path if needed
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

        /**
         * Set the Emby server URL
         */
        setServerUrl: function(url) {
            embyServerUrl = url.replace(/\/+$/, '');
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
            const url = (serverUrl || embyServerUrl).replace(/\/+$/, '') + '/emby/System/Info/Public';
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
                    id: data.Id,
                    isEmby: !data.StartupWizardCompleted === undefined // Emby-specific check
                };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },

        /**
         * Authenticate with Emby server
         */
        authenticate: async function(serverUrl, username, password) {
            const baseUrl = (serverUrl || embyServerUrl).replace(/\/+$/, '');
            const url = baseUrl + '/emby/Users/AuthenticateByName';

            const deviceId = localStorage.getItem('emby_device_id') || 
                            ('emby-web-' + Math.random().toString(36).substr(2, 9));
            localStorage.setItem('emby_device_id', deviceId);

            const authHeader = 'Emby Client="Jellyfin Web (Emby)", Device="' + 
                             (navigator.userAgent.includes('Chrome') ? 'Chrome' : 'Browser') + 
                             '", DeviceId="' + deviceId + '", Version="' + ADAPTER_VERSION + '"';

            try {
                const resp = await originalFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Emby-Authorization': authHeader
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
