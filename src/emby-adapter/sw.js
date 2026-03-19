/**
 * Emby CORS Proxy Service Worker v1.1.0
 *
 * Intercepts requests to the Emby server and adds CORS headers.
 * This is critical for <video>/<audio> element direct playback,
 * which cannot be intercepted by fetch/XHR monkey-patching.
 *
 * The Emby server origin is received from the main page via postMessage.
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
    console.log('[SW] Installing Emby CORS Proxy Service Worker v1.1.0');
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
                version: '1.1.0'
            });
        }
    }
});

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
    const url = request.url;

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
            const opaqueResponse = await fetch(request.url, {
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
