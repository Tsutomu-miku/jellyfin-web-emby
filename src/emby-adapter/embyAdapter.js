/**
 * Emby API Adapter for Jellyfin Web v1.6.0
 * 
 * Based on the stable ce25248 version, with targeted fixes:
 * 1. config.json interception: tells ConnectionManager the real Emby server URL
 * 2. Version spoofing: replaces Emby 4.x version with 10.10.7
 * 3. Auto-detect /emby/ prefix: some Emby servers need it, some don't
 * 4. API route translation: rewrites Jellyfin-only API paths to Emby-compatible format
 * 5. PlaybackInfo body transform: strips Jellyfin-specific DeviceProfile fields for Emby
 * 6. BitrateTest CORS workaround: returns synthetic response to avoid CORS preflight failure
 * 7. Double-slash prevention: collapses duplicate slashes in URL pathnames (v1.6.0)
 * 8. PlaybackInfo route fix: no longer translates to /Users/{id}/Items/{id}/PlaybackInfo (v1.6.0)
 * 9. Broadened item ID matching: supports numeric and alphanumeric IDs (v1.6.0)
 * 10. PlaybackInfo UserId injection: ensures UserId in POST body and GET query params (v1.6.0)
 */

(function() {
    'use strict';

    // ==================== Configuration ====================

    const ADAPTER_VERSION = '1.6.0';
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
     * Get the current user ID from adapter state.
     */
    function getUserId() {
        return embyUserId || localStorage.getItem(EMBY_USER_KEY) || '';
    }

    /**
     * Sanitize a URL by collapsing double (or more) slashes in the pathname.
     * Preserves the protocol's double slash (e.g. https://).
     */
    function sanitizeUrl(url) {
        try {
            const parsed = new URL(url);
            parsed.pathname = parsed.pathname.replace(/\/\/+/g, '/');
            return parsed.toString();
        } catch (e) {
            // For relative URLs, collapse double slashes but not after the colon in protocol
            return url.replace(/([^:])\/\/+/g, '$1/');
        }
    }

    function isConfigJsonRequest(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.origin === window.location.origin &&
                   u.pathname.endsWith('/config.json');
        } catch (e) {
            return false;
        }
    }

    function isEmbyApiRequest(url) {
        if (!embyServerUrl) return false;
        try {
            const parsed = new URL(url, window.location.origin);
            const serverParsed = new URL(embyServerUrl);
            if (parsed.hostname !== serverParsed.hostname) return false;
            const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            const serverPort = serverParsed.port || (serverParsed.protocol === 'https:' ? '443' : '80');
            if (parsedPort !== serverPort) return false;
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
     * Check if this is a BitrateTest request (known to cause CORS issues).
     */
    function isBitrateTestRequest(url) {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            return pathname.includes('/playback/bitratetest') ||
                   pathname.includes('/emby/playback/bitratetest');
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if this is a PlaybackInfo POST request.
     */
    function isPlaybackInfoRequest(url) {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            return pathname.includes('/playbackinfo');
        } catch (e) {
            return false;
        }
    }

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

    function maybeAddEmbyPrefix(url) {
        if (!needsEmbyPrefix) return url;
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

    /**
     * Ensure UserId is present as a query parameter for PlaybackInfo GET requests.
     * The Emby API expects: GET /Items/{Id}/PlaybackInfo?UserId={userId}
     */
    function ensurePlaybackInfoUserId(url) {
        try {
            const parsed = new URL(url);
            if (!parsed.searchParams.has('UserId') && !parsed.searchParams.has('userId')) {
                const userId = getUserId();
                if (userId) {
                    parsed.searchParams.set('UserId', userId);
                    log('Added UserId query param to PlaybackInfo GET request');
                    return parsed.toString();
                }
            }
        } catch (e) {
            warn('ensurePlaybackInfoUserId error:', e);
        }
        return url;
    }

    // ==================== API Route Translation ====================

    function translateJellyfinToEmbyUrl(url) {
        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname;
            const params = parsed.searchParams;
            const userId = params.get('userId') || getUserId();
            if (!userId) return null;

            let newPathname = null;
            let removeUserId = false;

            // UserViews
            if (/^\/UserViews$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Views';
                removeUserId = true;
            }
            else if (/^\/UserViews\/GroupingOptions$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/GroupingOptions';
                removeUserId = true;
            }
            // Items
            else if (/^\/Items$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items';
                removeUserId = true;
            }
            else if (/^\/Items\/Suggestions$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Suggestions';
                removeUserId = true;
            }
            else if (/^\/Items\/Root$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Root';
                removeUserId = true;
            }
            else if (/^\/Items\/Latest$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Latest';
                removeUserId = true;
            }
            // Items/{id} with optional suffix - NOTE: PlaybackInfo is EXCLUDED here
            // Emby's PlaybackInfo endpoint is POST /Items/{Id}/PlaybackInfo (not under /Users/)
            else if (/^\/Items\/([^\/]+)(\/(?:Intros|LocalTrailers|SpecialFeatures))?$/i.test(pathname)) {
                const match = pathname.match(/^\/Items\/([^\/]+)(\/(?:Intros|LocalTrailers|SpecialFeatures))?$/i);
                if (match) {
                    const itemId = match[1];
                    const suffix = match[2] || '';
                    newPathname = '/Users/' + userId + '/Items/' + itemId + suffix;
                    removeUserId = true;
                }
            }
            // UserItems
            else if (/^\/UserItems\/Resume$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Items/Resume';
                removeUserId = true;
            }
            else if (/^\/UserItems\/([^\/]+)\/UserData$/i.test(pathname)) {
                const match = pathname.match(/^\/UserItems\/([^\/]+)\/UserData$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/Items/' + match[1] + '/UserData';
                    removeUserId = true;
                }
            }
            else if (/^\/UserItems\/([^\/]+)\/Rating$/i.test(pathname)) {
                const match = pathname.match(/^\/UserItems\/([^\/]+)\/Rating$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/Items/' + match[1] + '/Rating';
                    removeUserId = true;
                }
            }
            // UserFavoriteItems
            else if (/^\/UserFavoriteItems\/([^\/]+)$/i.test(pathname)) {
                const match = pathname.match(/^\/UserFavoriteItems\/([^\/]+)$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/FavoriteItems/' + match[1];
                    removeUserId = true;
                }
            }
            // UserPlayedItems
            else if (/^\/UserPlayedItems\/([^\/]+)$/i.test(pathname)) {
                const match = pathname.match(/^\/UserPlayedItems\/([^\/]+)$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/PlayedItems/' + match[1];
                    removeUserId = true;
                }
            }
            // PlayingItems
            else if (/^\/PlayingItems\/([^\/]+)(\/Progress)?$/i.test(pathname)) {
                const match = pathname.match(/^\/PlayingItems\/([^\/]+)(\/Progress)?$/i);
                if (match) {
                    newPathname = '/Users/' + userId + '/PlayingItems/' + match[1] + (match[2] || '');
                }
            }
            // UserImage
            else if (/^\/UserImage$/i.test(pathname)) {
                const imageType = params.get('imageType') || 'Primary';
                const imageIndex = params.get('imageIndex');
                newPathname = '/Users/' + userId + '/Images/' + imageType + (imageIndex != null ? '/' + imageIndex : '');
                removeUserId = true;
                params.delete('imageType');
                params.delete('imageIndex');
            }
            // User Management
            else if (/^\/Users\/Password$/i.test(pathname)) {
                newPathname = '/Users/' + userId + '/Password';
                removeUserId = true;
            }
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

    // ==================== PlaybackInfo Body Transform ====================

    /**
     * Jellyfin-only VideoRangeType values that Emby 4.x does not recognize.
     */
    const JELLYFIN_ONLY_VIDEO_RANGE_TYPES = ['DOVIWithSDR', 'DOVIWithHDR10', 'DOVIWithHLG'];

    /**
     * Jellyfin-only condition properties that Emby may not support.
     */
    const JELLYFIN_ONLY_CONDITION_PROPS = ['IsSecondaryAudio'];

    /**
     * Clean a DeviceProfile object for Emby compatibility.
     * Removes Jellyfin-specific fields that Emby 4.x doesn't understand,
     * which would cause Emby to return "NoCompatibleStream".
     */
    function cleanDeviceProfileForEmby(profile) {
        if (!profile) return profile;

        // Deep clone to avoid mutating the original
        const p = JSON.parse(JSON.stringify(profile));

        // --- TranscodingProfiles: strip Jellyfin-only fields ---
        if (Array.isArray(p.TranscodingProfiles)) {
            p.TranscodingProfiles = p.TranscodingProfiles.map(tp => {
                delete tp.EnableAudioVbrEncoding;
                delete tp.ApplyConditions;
                return tp;
            });
        }

        // --- CodecProfiles: strip Jellyfin-only fields & sanitize conditions ---
        if (Array.isArray(p.CodecProfiles)) {
            p.CodecProfiles = p.CodecProfiles.map(cp => {
                delete cp.Container;
                delete cp.SubContainer;
                delete cp.ApplyConditions;

                // Sanitize Conditions
                if (Array.isArray(cp.Conditions)) {
                    cp.Conditions = cp.Conditions
                        .filter(c => {
                            // Remove conditions using Jellyfin-only properties
                            if (JELLYFIN_ONLY_CONDITION_PROPS.includes(c.Property)) return false;
                            return true;
                        })
                        .map(c => {
                            // Clean VideoRangeType values
                            if (c.Property === 'VideoRangeType' && c.Value) {
                                const values = c.Value.split('|')
                                    .filter(v => !JELLYFIN_ONLY_VIDEO_RANGE_TYPES.includes(v));
                                if (values.length === 0) return null; // remove empty condition
                                c.Value = values.join('|');
                            }
                            return c;
                        })
                        .filter(Boolean);
                }

                return cp;
            });
        }

        // --- DirectPlayProfiles: remove HLS direct play (Jellyfin-only concept) ---
        if (Array.isArray(p.DirectPlayProfiles)) {
            p.DirectPlayProfiles = p.DirectPlayProfiles.filter(dp => {
                return dp.Container !== 'hls';
            });
        }

        // --- SubtitleProfiles: Emby is mostly compatible, but clean up edge cases ---
        if (Array.isArray(p.SubtitleProfiles)) {
            p.SubtitleProfiles = p.SubtitleProfiles.map(sp => {
                // Emby doesn't support all subtitle methods Jellyfin does
                // But the basic ones (Encode, Embed, External, Drop) are shared
                return sp;
            });
        }

        log('DeviceProfile cleaned for Emby compatibility');
        return p;
    }

    /**
     * Transform a PlaybackInfo POST body for Emby compatibility.
     * Strips Jellyfin-specific fields from the top-level DTO and the nested DeviceProfile.
     * Also ensures UserId is present in the body (required by Emby's /Items/{Id}/PlaybackInfo).
     */
    function transformPlaybackInfoBody(bodyText) {
        try {
            const body = JSON.parse(bodyText);

            // Ensure UserId is in the body (Bug 4 fix)
            // Emby's POST /Items/{Id}/PlaybackInfo expects UserId in the request body
            if (!body.UserId) {
                const userId = getUserId();
                if (userId) {
                    body.UserId = userId;
                    log('Injected UserId into PlaybackInfo body:', userId);
                }
            }

            // Strip Jellyfin-specific top-level fields
            delete body.AlwaysBurnInSubtitleWhenTranscoding;
            delete body.EnableTranscoding;
            delete body.SecondarySubtitleStreamIndex;
            delete body.EnableMediaProbe;
            delete body.DirectPlayProtocols;
            delete body.IsPlayback;

            // Clean the nested DeviceProfile
            if (body.DeviceProfile) {
                body.DeviceProfile = cleanDeviceProfileForEmby(body.DeviceProfile);
            }

            log('PlaybackInfo body transformed for Emby');
            return JSON.stringify(body);
        } catch (e) {
            warn('PlaybackInfo body transform error:', e);
            return bodyText;
        }
    }

    /**
     * Create a synthetic BitrateTest response to avoid CORS issues.
     * The client uses this to estimate bandwidth; returning a fast response
     * with the requested data size makes it assume high bandwidth,
     * allowing direct play to be preferred over transcoding.
     */
    function createBitrateTestResponse(url) {
        let size = 500000; // default
        try {
            const parsed = new URL(url);
            const sizeParam = parsed.searchParams.get('Size') || parsed.searchParams.get('size');
            if (sizeParam) size = parseInt(sizeParam, 10) || 500000;
        } catch (e) {}

        log('BitrateTest intercepted, returning synthetic', size, 'byte response');

        // Return a buffer of the requested size filled with zeros
        const buffer = new ArrayBuffer(size);
        return new Response(buffer, {
            status: 200,
            statusText: 'OK',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(size)
            }
        });
    }

    // ==================== Auth Header Helpers ====================

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

    function adaptUrlForEmby(url) {
        const translated = translateJellyfinToEmbyUrl(url);
        let result = translated || url;
        result = maybeAddEmbyPrefix(result);
        // Collapse double slashes in pathname (Bug 1 fix)
        try {
            const parsed = new URL(result);
            parsed.pathname = parsed.pathname.replace(/\/\/+/g, '/');
            return parsed.toString();
        } catch (e) {
            // For relative URLs
            return result.replace(/([^:])\/\/+/g, '$1/');
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

        // ---- BitrateTest: return synthetic response to avoid CORS issues ----
        if (isBitrateTestRequest(url)) {
            return Promise.resolve(createBitrateTestResponse(url));
        }

        // Full adaptation: route translation + optional prefix + double-slash fix
        let newUrl = adaptUrlForEmby(url);

        // Sanitize URL to prevent any remaining double slashes
        newUrl = sanitizeUrl(newUrl);

        // For PlaybackInfo GET requests, ensure UserId is in query params (Bug 4 fix)
        const method = (options.method || 'GET').toUpperCase();
        if (isPlaybackInfoRequest(newUrl) && method === 'GET') {
            newUrl = ensurePlaybackInfoUserId(newUrl);
        }

        // Transform headers
        const newHeaders = transformHeaders(options.headers);

        const newOptions = {
            ...options,
            headers: newHeaders
        };

        // ---- PlaybackInfo: transform POST body for Emby compatibility ----
        if (isPlaybackInfoRequest(newUrl) && options.body) {
            try {
                let bodyText = options.body;
                if (typeof bodyText !== 'string') {
                    // If body is a ReadableStream or other type, try to get it as text
                    if (bodyText instanceof Blob) {
                        // Can't synchronously convert Blob, handle async below
                    } else {
                        bodyText = String(bodyText);
                    }
                }
                if (typeof bodyText === 'string') {
                    newOptions.body = transformPlaybackInfoBody(bodyText);
                }
            } catch (e) {
                warn('PlaybackInfo body intercept error:', e);
            }
        }

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
        this._embyIsBitrateTest = false;

        let adaptedUrl = url;

        if (adapterEnabled && isConfigJsonRequest(String(url))) {
            this._embyIsConfigJson = true;
            return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
        }

        if (adapterEnabled && isEmbyApiRequest(String(url))) {
            // BitrateTest: flag for synthetic response in send()
            if (isBitrateTestRequest(String(url))) {
                this._embyIsBitrateTest = true;
                this._embyAdapted = true;
                return XHROpen.call(this, method, adaptedUrl, async !== false, user, password);
            }

            adaptedUrl = adaptUrlForEmby(String(url));
            // Sanitize URL to prevent any remaining double slashes
            adaptedUrl = sanitizeUrl(adaptedUrl);

            // For PlaybackInfo GET requests, ensure UserId is in query params (Bug 4 fix)
            if (isPlaybackInfoRequest(adaptedUrl) && method.toUpperCase() === 'GET') {
                adaptedUrl = ensurePlaybackInfoUserId(adaptedUrl);
            }

            this._embyAdapted = true;
            this._embyIsPlaybackInfo = isPlaybackInfoRequest(adaptedUrl);
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
        // config.json interception
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
                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
                self.dispatchEvent(new Event('readystatechange'));
                self.dispatchEvent(new Event('load'));
                self.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
        }

        // BitrateTest: return synthetic response
        if (this._embyIsBitrateTest) {
            const self = this;
            let size = 500000;
            try {
                const parsed = new URL(self._embyOriginalUrl);
                const sizeParam = parsed.searchParams.get('Size') || parsed.searchParams.get('size');
                if (sizeParam) size = parseInt(sizeParam, 10) || 500000;
            } catch (e) {}
            log('XHR BitrateTest intercepted, size:', size);

            const buffer = new ArrayBuffer(size);
            setTimeout(function() {
                Object.defineProperty(self, 'readyState', { value: 4, writable: false, configurable: true });
                Object.defineProperty(self, 'status', { value: 200, writable: false, configurable: true });
                Object.defineProperty(self, 'statusText', { value: 'OK', writable: false, configurable: true });
                Object.defineProperty(self, 'response', { value: buffer, writable: false, configurable: true });
                Object.defineProperty(self, 'responseText', { value: '', writable: false, configurable: true });
                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
                self.dispatchEvent(new Event('readystatechange'));
                self.dispatchEvent(new Event('load'));
                self.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
        }

        if (this._embyAdapted) {
            // Transform PlaybackInfo body
            if (this._embyIsPlaybackInfo && body && typeof body === 'string') {
                body = transformPlaybackInfoBody(body);
            }

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
                    if (node.nodeType === Node.ELEMENT_NODE) adaptImageUrls(node);
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        document.querySelectorAll('img').forEach(adaptImageElement);
    }

    function adaptImageUrls(element) {
        if (element.tagName === 'IMG') adaptImageElement(element);
        element.querySelectorAll && element.querySelectorAll('img').forEach(adaptImageElement);
    }

    function adaptImageElement(img) {
        const src = img.getAttribute('src');
        if (!src || !embyServerUrl || !embyAccessToken) return;
        try {
            const srcUrl = new URL(src, window.location.origin);
            const serverUrl = new URL(embyServerUrl);
            if (srcUrl.hostname === serverUrl.hostname && !srcUrl.searchParams.has('api_key')) {
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
                if (wsUrl.hostname === window.location.hostname) {
                    wsUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
                    wsUrl.hostname = serverUrl.hostname;
                    wsUrl.port = serverUrl.port;
                    log('WebSocket redirected to Emby server:', wsUrl.toString());
                }
                if (wsUrl.hostname === serverUrl.hostname) {
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
            if (!/^https?:\/\//i.test(normalized)) normalized = 'http://' + normalized;
            embyServerUrl = normalized;
            localStorage.setItem(EMBY_SERVER_KEY, embyServerUrl);
            log('Server URL set:', embyServerUrl);
        },

        getServerUrl: function() { return embyServerUrl; },

        setAccessToken: function(token) {
            embyAccessToken = token;
            localStorage.setItem(EMBY_TOKEN_KEY, token);
        },

        getAccessToken: function() { return embyAccessToken; },
        getUserId: function() { return getUserId(); },

        setEnabled: function(enabled) {
            adapterEnabled = enabled;
            log('Adapter', enabled ? 'enabled' : 'disabled');
        },

        isEnabled: function() { return adapterEnabled; },

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

        testConnection: async function(serverUrl) {
            let baseUrl = serverUrl || embyServerUrl;
            baseUrl = baseUrl.trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;

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
                    return { success: true, serverName: data.ServerName, version: data.Version, id: data.Id };
                }
            } catch (e) {
                log('No-prefix test failed, trying with /emby/:', e.message);
            }

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
                    return { success: true, serverName: data.ServerName, version: data.Version, id: data.Id };
                }
                return { success: false, error: 'HTTP ' + resp.status };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },

        authenticate: async function(serverUrl, username, password) {
            let baseUrl = (serverUrl || embyServerUrl).trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;

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
                    body: JSON.stringify({ Username: username, Pw: password })
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

// Ensure Babel (sourceType: 'unambiguous') treats this file as an ES module
// so that injected core-js polyfills use 'import' syntax consistent with webpack's ESM handling.
export {};
