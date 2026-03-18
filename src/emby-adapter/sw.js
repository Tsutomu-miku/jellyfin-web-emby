/**
 * Emby CORS Proxy Service Worker v1.0.0
 *
 * Intercepts requests to the Emby server and adds CORS headers.
 * This is critical for <video>/<audio> element direct playback,
 * which cannot be intercepted by fetch/XHR monkey-patching.
 *
 * The Emby server origin is received from the main page via postMessage.
 */

// ==================== State ====================

let embyServerOrigin = '';

// ==================== Lifecycle ====================

self.addEventListener('install', (event) => {
    console.log('[SW] Installing Emby CORS Proxy Service Worker');
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
                version: '1.0.0'
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
        // Build new headers, preserving Range and other important headers
        const headers = new Headers();
        for (const [key, value] of request.headers) {
            headers.set(key, value);
        }

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
