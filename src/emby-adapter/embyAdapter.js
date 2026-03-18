/**
 * Jellyfin-Web Emby Adapter
 * 
 * Intercepts all network requests from Jellyfin Web and translates them
 * for Emby server compatibility. Handles:
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

    const ADAPTER_VERSION = '1.2.0';
    let DEBUG = localStorage.getItem('embyAdapterDebug') === 'true';

    const SPOOFED_JELLYFIN_VERSION = '10.10.7';

    // Paths whose responses need version spoofing (will be matched case-insensitively)
    const VERSION_SPOOF_PATHS = [
        '/system/info/public',
        '/system/info',
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
    // URL Transformation
    // ========================================

    /**
     * Check whether a URL targets the configured Emby server.
     */
    function isEmbyApiUrl(url) {
        const serverUrl = getEmbyServerUrl();
        if (!serverUrl || !url) return false;
        try {
            const u = new URL(url, window.location.origin);
            const s = new URL(serverUrl);
            return u.hostname === s.hostname && u.port === s.port;
        } catch { return false; }
    }

    /**
     * Ensure the URL path is prefixed with /emby/ when talking to the Emby server.
     * Jellyfin Web sends e.g. /System/Info/Public but Emby expects /emby/System/Info/Public.
     */
    function ensureEmbyPrefix(url) {
        if (!isEmbyApiUrl(url)) return url;
        try {
            const u = new URL(url, window.location.origin);
            if (!u.pathname.toLowerCase().startsWith('/emby/') && !u.pathname.toLowerCase().startsWith('/emby')) {
                u.pathname = '/emby' + u.pathname;
            }
            return u.toString();
        } catch { return url; }
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
                // Match both /system/info/public and /emby/system/info/public
                if (pathname.endsWith(lowerPath) || pathname.endsWith('/emby' + lowerPath)) {
                    return true;
                }
            }

            // Exact match for /system/info (but NOT /system/info/public which is handled above)
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
                data.Version = SPOOFED_JELLYFIN_VERSION;
                // Also ensure ProductName looks right
                if (!data.ProductName) {
                    data.ProductName = 'Jellyfin Server';
                }
                log('Spoofed Version to', SPOOFED_JELLYFIN_VERSION, '(was', data.Version, ')');
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
     * Uses ONLY the standard "Authorization" header to avoid CORS preflight
     * issues with custom X-Emby-* headers.
     */
    function buildEmbyAuthHeaderValue(originalValue) {
        if (!originalValue) return originalValue;

        // Replace "MediaBrowser" or "Jellyfin" scheme with "Emby"
        let value = originalValue;
        if (value.startsWith('MediaBrowser ')) {
            value = 'Emby ' + value.substring('MediaBrowser '.length);
        } else if (value.startsWith('Jellyfin ')) {
            value = 'Emby ' + value.substring('Jellyfin '.length);
        }

        // Inject token if present and not already in the value
        const token = getEmbyToken();
        if (token && !value.includes('Token=')) {
            value = value.replace(/\s*$/, '') + ', Token="' + token + '"';
        }

        return value;
    }

    /**
     * Transform headers: keep only standard headers, convert auth to Emby format.
     * Strips X-Emby-*, X-MediaBrowser-* to prevent CORS issues.
     */
    function transformHeaders(headers) {
        if (!headers) return headers;

        let h;
        if (headers instanceof Headers) {
            h = new Headers();
            for (const [key, value] of headers.entries()) {
                const lk = key.toLowerCase();
                // Strip non-standard Emby/Jellyfin headers
                if (lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-')) {
                    // If this is the auth header, fold it into Authorization
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

        if (typeof headers === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(headers)) {
                const lk = key.toLowerCase();
                if (lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-')) {
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

            // Strip /emby prefix to get the canonical API path
            if (lowerPath.startsWith('/emby/')) {
                return path.substring(5); // keeps the leading /
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
            if (isEmbyApiUrl(url)) {
                // Add /emby/ prefix
                url = ensureEmbyPrefix(url);
                log('Fetch intercepted:', url);

                // Transform headers
                if (modifiedInit.headers) {
                    modifiedInit.headers = transformHeaders(modifiedInit.headers);
                }

                // Reconstruct input
                if (typeof input === 'string') {
                    input = url;
                } else if (input instanceof Request) {
                    input = new Request(url, input);
                    // Headers from init take precedence
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

        return originalFetch.call(this, input, init);
    };

    async function transformResponseByPath(response, apiPath) {
        const lowerPath = apiPath.toLowerCase();
        // Skip system/info — already handled by version spoofing
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
        if (isEmbyApiUrl(url)) {
            url = ensureEmbyPrefix(url);
            this._embyIntercepted = true;
            log('XHR intercepted:', method, url);
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this._embyIntercepted) {
            const lk = name.toLowerCase();
            // Strip custom headers that cause CORS issues
            if (lk.startsWith('x-emby-') || lk.startsWith('x-mediabrowser-')) {
                if (lk === 'x-emby-authorization') {
                    return originalXHRSetHeader.call(this, 'Authorization', buildEmbyAuthHeaderValue(value));
                }
                return; // drop the header
            }
            if (lk === 'authorization') {
                return originalXHRSetHeader.call(this, 'Authorization', buildEmbyAuthHeaderValue(value));
            }
        }
        return originalXHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        // For version spoofing in XHR we override responseText via getter
        if (this._embyIntercepted && needsVersionSpoof(this._embyOrigUrl)) {
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

            // Save config
            this.configure(serverUrl, token);

            // Sync to Jellyfin credentials format
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

    /**
     * Sync authentication data to Jellyfin's credential format so the
     * ConnectionManager picks it up after page reload.
     */
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
