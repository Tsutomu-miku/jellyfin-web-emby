/**
 * Emby CORS Proxy Service Worker v1.2.0
 *
 * Intercepts requests to the Emby server and adds CORS headers.
 * This is critical for <video>/<audio> element direct playback,
 * which cannot be intercepted by fetch/XHR monkey-patching.
 *
 * The Emby server origin is received from the main page via postMessage.
 *
 * v1.2.0 changes:
 * - Rewrite /Videos/{id}/stream or /Videos/{id}/original URLs to /Audio/{id}/stream
 *   to bypass Cloudflare WAF blocking /Videos/ paths with 403 Forbidden.
 *   /Audio/{id}/stream serves the full original file (video+audio) and supports
 *   Range requests. This is the CRITICAL fix for video playback 403 errors,
 *   because <video> element src requests do NOT go through fetch/XHR interceptors
 *   and can ONLY be rewritten at the Service Worker level.
 *
 * v1.1.0 changes:
 * - Filter out non-standard headers (X-Emby-Authorization, X-MediaBrowser-Token, etc.)
 *   before forwarding requests, because the Emby server's CORS policy only allows
 *   Content-Type and Authorization. Non-standard headers cause preflight failures.
 * - Convert X-Emby-Authorization to Authorization when no Authorization header exists,
 *   so the auth token is still sent but via a CORS-safe header.
 */

// ==================== State ====================

let embyServerOrigin = '';

// ==================== Lifecycle ====================

self.addEventListener('install', (event) => {
    console.log('[SW] Installing Emby CORS Proxy Service Worker v1.2.0');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activated, claiming all clients');
    event.waitUntil(self.clients.claim());
});

// ==================== Message Channel ====================

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SET_EMBY_SERVER') {
        const newOrigin = event.data.origin || '';
        if (newOrigin !== embyServerOrigin) {
            embyServerOrigin = newOrigin;
            console.log('[SW] Emby server origin set to:', embyServerOrigin);
        }
    }

    if (event.data && event.data.type === 'GET_STATUS') {
        if (event.source) {
            event.source.postMessage({
                type: 'SW_STATUS',
                embyServerOrigin: embyServerOrigin,
                version: '1.2.0'
            });
        }
    }
});

// ==================== Video URL Rewriting ====================

/**
 * v1.2.0: Rewrite /Videos/ paths to /Audio/ to bypass Cloudflare WAF.
 *
 * Cloudflare WAF blocks all requests to /Videos/ (and /videos/) with 403.
 * The /Audio/{id}/stream endpoint on Emby serves the FULL original file
 * (video + audio + subtitles) despite the /Audio/ path name. It also
 * supports Range requests (HTTP 206) for seeking.
 *
 * This rewrite handles ALL known URL patterns:
 *   /Videos/{id}/stream.{ext}   -> /Audio/{id}/stream
 *   /Videos/{id}/original.{ext} -> /Audio/{id}/stream
 *   /videos/{id}/stream.{ext}   -> /Audio/{id}/stream
 *   /videos/{id}/original.{ext} -> /Audio/{id}/stream
 *   /emby/Videos/{id}/...       -> /emby/Audio/{id}/stream
 *   /emby/videos/{id}/...       -> /emby/Audio/{id}/stream
 *
 * @param {string} url - The original request URL
 * @returns {string} - The rewritten URL, or the original if no rewrite needed
 */
function rewriteVideoUrl(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname;

        // Match /Videos/{id}/stream.{ext} or /Videos/{id}/original.{ext}
        // Also matches with /emby/ prefix and case-insensitive /videos/
        const match = pathname.match(
            /^(\/(?:emby\/)?)[Vv]ideos\/([^/]+)\/(stream|original)(?:\.\w+)?$/i
        );
        if (match) {
            const prefix = match[1];   // "/" or "/emby/"
            const itemId = match[2];
            parsed.pathname = prefix + 'Audio/' + itemId + '/stream';

            // Ensure Static=true is present for direct stream
            if (!parsed.searchParams.has('Static')) {
                parsed.searchParams.set('Static', 'true');
            }

            console.log('[SW] Rewrote video URL:', pathname, '->', parsed.pathname);
            return parsed.toString();
        }

        // Also catch bare /Videos/{id}/stream or /Videos/{id}/original (no extension)
        const bareMatch = pathname.match(
            /^(\/(?:emby\/)?)[Vv]ideos\/([^/]+)\/(stream|original)\/?$/i
        );
        if (bareMatch) {
            const prefix = bareMatch[1];
            const itemId = bareMatch[2];
            parsed.pathname = prefix + 'Audio/' + itemId + '/stream';

            if (!parsed.searchParams.has('Static')) {
                parsed.searchParams.set('Static', 'true');
            }

            console.log('[SW] Rewrote bare video URL:', pathname, '->', parsed.pathname);
            return parsed.toString();
        }
    } catch (e) {
        console.warn('[SW] Video URL rewrite error:', e);
    }
    return url;
}

/**
 * Check if a URL is a video stream request that might need rewriting.
 */
function isVideoStreamUrl(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return /\/videos\/[^/]+\/(stream|original)/.test(pathname);
    } catch (e) {
        return false;
    }
}

// ==================== Fetch Interceptor ====================

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only intercept requests to the Emby server
    if (!embyServerOrigin || url.origin !== embyServerOrigin) {
        return;
    }

    event.respondWith(proxyRequest(event.request));
});

// ==================== Header Sanitization ====================

/**
 * Headers that are safe to forward to the Emby server.
 * The Emby server's CORS policy typically only allows:
 *   Access-Control-Allow-Headers: Content-Type, Authorization
 * Any other non-simple header will cause CORS preflight to fail.
 *
 * We whitelist known-safe headers and convert Emby-specific auth headers
 * to the standard Authorization header.
 */
const SAFE_HEADERS = new Set([
    'accept',
    'accept-language',
    'accept-encoding',
    'content-type',
    'content-length',
    'authorization',
    'range',
    'if-none-match',
    'if-modified-since',
    'cache-control',
    'pragma'
]);

/**
 * Headers that carry auth info and should be converted to Authorization
 * if no Authorization header is already present.
 */
const EMBY_AUTH_HEADERS = new Set([
    'x-emby-authorization',
    'x-emby-token',
    'x-mediabrowser-token'
]);

function sanitizeHeaders(originalHeaders) {
    const headers = new Headers();
    let hasAuthorization = false;
    let embyAuthValue = null;

    // First pass: check what we have
    for (const [key, value] of originalHeaders) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'authorization') {
            hasAuthorization = true;
        }
        if (lowerKey === 'x-emby-authorization' && value) {
            embyAuthValue = value;
        }
    }

    // Second pass: copy safe headers only
    for (const [key, value] of originalHeaders) {
        const lowerKey = key.toLowerCase();
        if (SAFE_HEADERS.has(lowerKey)) {
            headers.set(key, value);
        }
        // Skip Emby-specific headers (they'd cause CORS failures)
        // Skip user-agent (forbidden header, browsers ignore it anyway)
    }

    // If no Authorization but we have X-Emby-Authorization, promote it
    if (!hasAuthorization && embyAuthValue) {
        headers.set('Authorization', embyAuthValue);
    }

    return headers;
}

// ==================== Proxy Logic ====================

async function proxyRequest(request) {
    let url = request.url;

    // v1.2.0: Rewrite /Videos/ -> /Audio/ to bypass Cloudflare WAF 403
    // This is the CRITICAL fix for <video> element playback.
    // <video> src requests do NOT go through fetch/XHR monkey-patches,
    // so this Service Worker is the ONLY place we can rewrite these URLs.
    if (isVideoStreamUrl(url)) {
        url = rewriteVideoUrl(url);
    }

    // Handle OPTIONS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': [
                    'Content-Type',
                    'Range',
                    'Authorization',
                    'X-Emby-Token',
                    'X-Emby-Authorization',
                    'X-MediaBrowser-Token',
                    'Accept',
                    'Accept-Language',
                    'Accept-Encoding'
                ].join(', '),
                'Access-Control-Max-Age': '86400'
            }
        });
    }

    try {
        // Sanitize headers: remove non-standard headers that would cause
        // CORS preflight failures on the actual Emby server
        const headers = sanitizeHeaders(request.headers);

        // Construct the proxied request
        const fetchOptions = {
            method: request.method,
            headers: headers,
            mode: 'cors',
            credentials: 'omit',
            redirect: 'follow'
        };

        // Only attach body for methods that can have one
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            fetchOptions.body = request.body;
        }

        const response = await fetch(new Request(url, fetchOptions));

        // Build response with CORS headers added
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Expose-Headers', [
            'Content-Length',
            'Content-Range',
            'Accept-Ranges',
            'Content-Type',
            'Content-Disposition',
            'X-Emby-Token'
        ].join(', '));

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });

    } catch (corsError) {
        console.warn('[SW] CORS fetch failed for:', url, corsError.message);

        // Fallback: try no-cors (gives opaque response)
        try {
            const opaqueResponse = await fetch(url, {
                method: request.method,
                mode: 'no-cors',
                credentials: 'omit',
                redirect: 'follow'
            });
            console.log('[SW] Fallback to opaque response for:', url);
            return opaqueResponse;
        } catch (opaqueError) {
            console.error('[SW] All fetch attempts failed for:', url, opaqueError.message);
            return new Response(
                JSON.stringify({
                    error: 'Service Worker proxy error',
                    message: corsError.message,
                    url: url
                }),
                {
                    status: 502,
                    statusText: 'Bad Gateway',
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                }
            );
        }
    }
}
