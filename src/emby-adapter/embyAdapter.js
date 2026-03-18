/**
 * Emby API Adapter for Jellyfin Web v1.4.0
 * 
 * Based on the stable ce25248 version, with targeted fixes:
 * 1. config.json interception: tells ConnectionManager the real Emby server URL
 * 2. Version spoofing: replaces Emby 4.x version with 10.10.7
 * 3. Auto-detect /emby/ prefix: some Emby servers need it, some don't
 * 4. API route translation: rewrites Jellyfin-only API paths to Emby-compatible format
 * 
 * Key differences handled:
 * 1. URL prefix: Some Emby servers require /emby/ prefix, auto-detected
 * 2. Auth header: Uses "Emby" scheme in standard Authorization header
 * 3. Token passing: Embedded in Authorization header value
 * 4. API routes: Jellyfin SDK uses new flat routes; Emby requires /Users/{userId}/... format
 */

(function() {
    'use strict';

    // ==================== Configuration ====================

    const ADAPTER_VERSION = '1.4.0';
    const STORAGE_KEY = 'emby_adapter_config';
    const EMBY_TOKEN_KEY = 'emby_access_token';
    const EMBY_USER_KEY = 'emby_user_id';
    const EMBY_SERVER_KEY = 'emby_server_url';
    const EMBY_PREFIX_KEY = 'emby_needs_prefix';
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
    // Whether the server needs /emby/ prefix. null = not yet detected.
    let needsEmbyPrefix = (() => {
        const stored = localStorage.getItem(EMBY_PREFIX_KEY);
        if (stored === 'true') return true;
        if (stored === 'false') return false;
        return null;
    })();

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

            // Must match Emby server hostname
            if (parsed.hostname !== serverParsed.hostname) return false;
            // Port check: for https default 443, for http default 80
            const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            const serverPort = serverParsed.port || (serverParsed.protocol === 'https:' ? '443' : '80');
            if (parsedPort !== serverPort) return false;

            // Static resources don't need adaptation
            const pathname = parsed.pathname.toLowerCase();
            for (const ext of STATIC_EXTENSIONS) {
                if (pathname.endsWith(ext)) return false;
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if response needs version spoofing.
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
     */
    function spoofVersionInJson(bodyText) {
        try {
            const data = JSON.parse(bodyText);
            if (data && typeof data.Version === 'string') {
                log('Spoofing version:', data.Version, '->', SPOOFED_VERSION);
                data.Version = SPOOFED_VERSION;
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
     * Conditionally add /emby/ prefix based on auto-detection result.
     */
    function maybeAddEmbyPrefix(url) {
        if (!needsEmbyPrefix) return url; // false or null => don't add

        try {
            const parsed = new URL(url);
            if (!parsed.pathname.toLowerCase().startsWith('/emby/') &&
                !parsed.pathname.toLowerCase().startsWith('/emby')) {
                parsed.pathname = '/emby' + parsed.pathname;
            }
            return parsed.toString();
        } catch (e) {
            if (!url.startsWith('/emby/')) {
                return '/emby' + (url.startsWith('/') ? url : '/' + url);
            }
            return url;
        }
    }

    // ==================== API Route Translation ====================
    // Jellyfin SDK generates new-style flat routes; Emby 4.x only supports
    // the old /Users/{userId}/... format. We must rewrite them.

    /**
     * Translate Jellyfin-only API paths to Emby-compatible paths.
     * Returns the modified full URL string if translation was needed, or null.
     */
    function translateJellyfinToEmbyUrl(url) {
        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname;
            const params = parsed.searchParams;

            // Get userId from query params or from stored state
            const userId = params.get('userId') || embyUserId;
            if (!userId) return null; // can't translate without userId

            let newPathname = null;
            let removeUserId = false; // whether to remove userId from query params

            // --- Category 1: UserViews ---
            // GET /UserViews?userId=xxx -> /Users/{userId}/Views
            if (/^\/UserViews$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Views';
                removeUserId = true;
            }
            // GET /UserViews/GroupingOptions?userId=xxx -> /Users/{userId}/GroupingOptions
            else if (/^\/UserViews\/GroupingOptions$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/GroupingOptions';
                removeUserId = true;
            }

            // --- Category 2: Items ---
            // GET /Items?userId=xxx -> /Users/{userId}/Items
            else if (/^\/Items$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items';
                removeUserId = true;
            }
            // GET /Items/Suggestions?userId=xxx -> /Users/{userId}/Suggestions
            else if (/^\/Items\/Suggestions$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Suggestions';
                removeUserId = true;
            }
            // GET /Items/Root?userId=xxx -> /Users/{userId}/Items/Root
            else if (/^\/Items\/Root$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Root';
                removeUserId = true;
            }
            // GET /Items/Latest?userId=xxx -> /Users/{userId}/Items/Latest
            else if (/^\/Items\/Latest$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Latest';
                removeUserId = true;
            }
            // GET /Items/{itemId}?userId=xxx -> /Users/{userId}/Items/{itemId}
            // Also handles /Items/{itemId}/Intros, /Items/{itemId}/LocalTrailers, /Items/{itemId}/SpecialFeatures
            else if (/^\/Items\/([a-f0-9]+)(\/(?:Intros|LocalTrailers|SpecialFeatures))?$/i.test(pathname)) {
                const match = pathname.match(/^\/Items\/([a-f0-9]+)(\/(?:Intros|LocalTrailers|SpecialFeatures))?$/i);
                if (match) {
                    const itemId = match[1];
                    const suffix = match[2] || '';
                    newPathname = '/Users/' + userId + '/Items/' + itemId + suffix;
                    removeUserId = true;
                }
            }

            // --- Category 3: UserItems ---
            // GET /UserItems/Resume?userId=xxx -> /Users/{userId}/Items/Resume
            else if (/^\/UserItems\/Resume$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Resume';
                removeUserId = true;
            }
            // GET/POST /UserItems/{itemId}/UserData?userId=xxx -> /Users/{userId}/Items/{itemId}/UserData
            else if (/^\/UserItems\/([a-f0-9]+)\/UserData$/i.test(pathname)) {
                const match = pathname.match(/^\/UserItems\/([a-f0-9]+)\/UserData$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/Items/' + match[1] + '/UserData';
                    removeUserId = true;
                }
            }
            // POST /UserItems/{itemId}/Rating?userId=xxx -> /Users/{userId}/Items/{itemId}/Rating
            // DELETE /UserItems/{itemId}/Rating?userId=xxx -> /Users/{userId}/Items/{itemId}/Rating
            else if (/^\/UserItems\/([a-f0-9]+)\/Rating$/i.test(pathname)) {
                const match = pathname.match(/^\/UserItems\/([a-f0-9]+)\/Rating$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/Items/' + match[1] + '/Rating';
                    removeUserId = true;
                }
            }

            // --- Category 4: UserFavoriteItems ---
            // POST/DELETE /UserFavoriteItems/{itemId}?userId=xxx -> /Users/{userId}/FavoriteItems/{itemId}
            else if (/^\/UserFavoriteItems\/([a-f0-9]+)$/i.test(pathname)) {
                const match = pathname.match(/^\/UserFavoriteItems\/([a-f0-9]+)$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/FavoriteItems/' + match[1];
                    removeUserId = true;
                }
            }

            // --- Category 5: UserPlayedItems ---
            // POST/DELETE /UserPlayedItems/{itemId}?userId=xxx -> /Users/{userId}/PlayedItems/{itemId}
            else if (/^\/UserPlayedItems\/([a-f0-9]+)$/i.test(pathname)) {
                const match = pathname.match(/^\/UserPlayedItems\/([a-f0-9]+)$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/PlayedItems/' + match[1];
                    removeUserId = true;
                }
            }

            // --- Category 6: PlayingItems (session-based, no userId in path) ---
            // POST /PlayingItems/{itemId} -> /Users/{userId}/PlayingItems/{itemId}
            // POST /PlayingItems/{itemId}/Progress -> /Users/{userId}/PlayingItems/{itemId}/Progress
            // DELETE /PlayingItems/{itemId} -> /Users/{userId}/PlayingItems/{itemId}
            else if (/^\/PlayingItems\/([a-f0-9]+)(\/Progress)?$/i.test(pathname)) {
                const match = pathname.match(/^\/PlayingItems\/([a-f0-9]+)(\/Progress)?$/i);
                if (match) {
                    const itemId = match[1];
                    const suffix = match[2] || '';
                    newPathname = '/Users/' + userId + '/PlayingItems/' + itemId + suffix;
                }
            }

            // --- Category 7: UserImage ---
            // GET/POST/DELETE /UserImage?userId=xxx -> /Users/{userId}/Images/{imageType}
            else if (/^\/UserImage$/i.test(pathname)) {
                const imageType = params.get('imageType') || 'Primary';
                const imageIndex = params.get('imageIndex');
                if (imageIndex != null) {
                    newPathname = '/Users/' + userId + '/Images/' + imageType + '/' + imageIndex;
                } else {
                    newPathname = '/Users/' + userId + '/Images/' + imageType;
                }
                removeUserId = true;
                params.delete('imageType');
                params.delete('imageIndex');
            }

            // --- Category 8: User Management ---
            // POST /Users/Password?userId=xxx -> /Users/{userId}/Password
            else if (/^\/Users\/Password$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Password';
                removeUserId = true;
            }
            // POST /Users/Configuration?userId=xxx -> /Users/{userId}/Configuration
            else if (/^\/Users\/Configuration$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Configuration';
                removeUserId = true;
            }

            if (newPathname) {
                parsed.pathname = newPathname;
                if (removeUserId) {
                    parsed.searchParams.delete('userId');
                }
                log('Route translated:', pathname, '->', newPathname);
                return parsed.toString();
            }

        } catch (e) {
            warn('Route translation error:', e);
        }
        return null;
    }

    // ==================== Auth Header Helpers ====================

    /**
     * Build the Emby auth header value.
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
     */
    function transformAuthHeader(value) {
        if (!value) return value;

        let transformed = value;
        if (transformed.startsWith('MediaBrowser ')) {
            transformed = 'Emby ' + transformed.substring('MediaBrowser '.length);
        } else if (transformed.startsWith('Jellyfin ')) {
            transformed = 'Emby ' + transformed.substring('Jellyfin '.length);
        }

        if (embyAccessToken && !transformed.includes('Token=')) {
            transformed += ', Token="' + embyAccessToken + '"';
        }

        return transformed;
    }

    /**
     * Transform request headers for Emby compatibility.
     */
    function transformHeaders(headers) {
        const newHeaders = new Headers();
        let authValue = null;

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

            if (lowerKey.startsWith('x-emby-') || lowerKey.startsWith('x-mediabrowser-')) {
                if ((lowerKey === 'x-emby-token' || lowerKey === 'x-mediabrowser-token') && value) {
                    if (!embyAccessToken) {
                        embyAccessToken = value;
                        localStorage.setItem(EMBY_TOKEN_KEY, value);
                    }
                }
                if (lowerKey === 'x-emby-authorization') {
                    authValue = transformAuthHeader(value);
                }
                continue;
            }

            if (lowerKey === 'authorization') {
                authValue = transformAuthHeader(value);
            } else {
                newHeaders.set(key, value);
            }
        }

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

    // ==================== Core URL Adaptation ====================

    /**
     * Full URL adaptation pipeline for Emby compatibility:
     * 1. Translate Jellyfin-only routes to Emby format
     * 2. Conditionally add /emby/ prefix
     */
    function adaptUrlForEmby(url) {
        // Step 1: Translate Jellyfin SDK routes to Emby-compatible routes
        const translated = translateJellyfinToEmbyUrl(url);
        let result = translated || url;

        // Step 2: Conditionally add /emby/ prefix
        result = maybeAddEmbyPrefix(result);

        return result;
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

        // Full adaptation: route translation + optional prefix
        const newUrl = adaptUrlForEmby(url);

        // Transform headers
        const newHeaders = transformHeaders(options.headers);

        const newOptions = {
            ...options,
            headers: newHeaders
        };

        log('Adapted to:', newUrl);

        return originalFetch.call(this, newUrl, newOptions).then(response => {
            handleAuthResponse(url, response);

            // Version spoofing
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

        if (adapterEnabled && isConfigJsonRequest(String(url))) {
            this._embyIsConfigJson = true;
            return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
        }

        if (adapterEnabled && isEmbyApiRequest(String(url))) {
            adaptedUrl = adaptUrlForEmby(String(url));
            this._embyAdapted = true;
            log('XHR Intercepting:', url, '->', adaptedUrl);
        }

        return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this._embyAdapted) {
            const lowerName = name.toLowerCase();

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
                return;
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
        if (this._embyIsConfigJson) {
            const self = this;
            const configData = JSON.stringify({
                servers: embyServerUrl ? [embyServerUrl] : [],
                menuLinks: [],
                multiserver: false
            });
            log('XHR config.json intercepted');
            setTimeout(function() {
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
            if (embyAccessToken && !this._embyHeaders['Authorization']) {
                const authValue = buildEmbyAuthHeaderValue(embyAccessToken);
                XHRSetHeader.call(this, 'Authorization', authValue);
            }

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

            if (srcUrl.hostname === serverUrl.hostname && !srcUrl.searchParams.has('api_key')) {
                // Only add /emby/ prefix if the server needs it
                if (needsEmbyPrefix && !srcUrl.pathname.startsWith('/emby/')) {
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
                if (wsUrl.hostname === serverUrl.hostname) {
                    // Only add /emby prefix if server needs it
                    if (needsEmbyPrefix && !wsUrl.pathname.startsWith('/emby')) {
                        wsUrl.pathname = '/emby' + wsUrl.pathname;
                    }
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
            needsEmbyPrefix = null;
            localStorage.removeItem(EMBY_TOKEN_KEY);
            localStorage.removeItem(EMBY_USER_KEY);
            localStorage.removeItem(EMBY_SERVER_KEY);
            localStorage.removeItem(EMBY_PREFIX_KEY);
            localStorage.removeItem('jellyfin_credentials');
            localStorage.removeItem('emby_server_name');
            localStorage.removeItem('emby_server_id');
        },

        /**
         * Test connection to Emby server.
         * Also auto-detects whether the server needs /emby/ prefix.
         */
        testConnection: async function(serverUrl) {
            let baseUrl = serverUrl || embyServerUrl;
            baseUrl = baseUrl.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            // Try WITHOUT /emby/ prefix first (more common for newer Emby setups)
            let url = baseUrl + '/System/Info/Public';
            try {
                let resp = await originalFetch(url, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (resp.ok) {
                    const data = await resp.json();
                    needsEmbyPrefix = false;
                    localStorage.setItem(EMBY_PREFIX_KEY, 'false');
                    log('Server does NOT need /emby/ prefix');
                    return {
                        success: true,
                        serverName: data.ServerName,
                        version: data.Version,
                        id: data.Id
                    };
                }
            } catch (e) {
                log('No-prefix test failed, trying with /emby/:', e.message);
            }

            // Try WITH /emby/ prefix (some setups require it)
            url = baseUrl + '/emby/System/Info/Public';
            try {
                let resp = await originalFetch(url, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (resp.ok) {
                    const data = await resp.json();
                    needsEmbyPrefix = true;
                    localStorage.setItem(EMBY_PREFIX_KEY, 'true');
                    log('Server NEEDS /emby/ prefix');
                    return {
                        success: true,
                        serverName: data.ServerName,
                        version: data.Version,
                        id: data.Id
                    };
                }
                return { success: false, error: 'HTTP ' + resp.status };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },

        /**
         * Authenticate with Emby server.
         * Uses the detected prefix setting.
         */
        authenticate: async function(serverUrl, username, password) {
            let baseUrl = (serverUrl || embyServerUrl).trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) {
                baseUrl = 'http://' + baseUrl;
            }

            const prefix = needsEmbyPrefix ? '/emby' : '';
            const url = baseUrl + prefix + '/Users/AuthenticateByName';
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
    log('Server:', embyServerUrl || '(not configured)');
    log('Prefix mode:', needsEmbyPrefix === null ? 'auto-detect pending' : (needsEmbyPrefix ? '/emby/ required' : 'no prefix'));
    if (embyAccessToken) log('Token: present');

})();
