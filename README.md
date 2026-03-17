# jellyfin-web-emby

Jellyfin Web frontend adapted to work with **Emby** server backend. Deploy as a pure static site on GitHub Pages — all authentication and API adaptation happens in the browser.

## How It Works

Jellyfin was originally forked from Emby in 2018, and their APIs remain ~80-90% compatible. This project leverages that compatibility by:

1. **Building from upstream Jellyfin Web** source code (preserving the ability to sync bugfixes)
2. **Injecting a lightweight Emby Adapter layer** that intercepts all API requests in the browser
3. **Transparently transforming** requests to match Emby's API format:
   - Adds `/emby/` path prefix to API endpoints
   - Converts `MediaBrowser` auth headers to `Emby` format (`X-Emby-Authorization`)
   - Handles Emby-specific authentication flow (`Pw` field, token management)
   - Adapts WebSocket connections and image URLs

```
┌─────────────────────────────────────────┐
│  Browser                                │
│                                         │
│  ┌────────────────┐                     │
│  │ Jellyfin Web   │  (unmodified UI)    │
│  │ (static files) │                     │
│  └───────┬────────┘                     │
│          │ fetch / XHR / WebSocket      │
│  ┌───────▼────────┐                     │
│  │ Emby Adapter   │  (intercept layer)  │
│  │ - URL rewrite  │                     │
│  │ - Auth rewrite │                     │
│  │ - Token mgmt   │                     │
│  └───────┬────────┘                     │
│          │                              │
└──────────┼──────────────────────────────┘
           │ HTTPS
  ┌────────▼────────┐
  │  Emby Server    │
  │  (your own)     │
  └─────────────────┘
```

## Quick Start

### Option 1: Use the hosted GitHub Pages version

1. Visit: **https://Tsutomu-miku.github.io/jellyfin-web-emby/**
2. Enter your Emby server address (e.g., `http://your-server:8096`)
3. Enter your Emby username and password
4. Done — you'll see the Jellyfin Web interface connected to your Emby server

> **Note**: Your Emby server must have CORS enabled or be accessible from the browser. If your server is behind HTTPS, the GitHub Pages site (also HTTPS) can connect to it directly. For HTTP servers, you may need to deploy this project on the same network or use a reverse proxy.

### Option 2: Build and self-host

```bash
# Clone this repo
git clone https://github.com/Tsutomu-miku/jellyfin-web-emby.git
cd jellyfin-web-emby

# Build (clones jellyfin-web, injects adapter, builds)
chmod +x build.sh
bash build.sh

# Serve locally
cd dist && npx serve -s .
```

### Option 3: Deploy via GitHub Actions

1. Fork this repository
2. Go to Settings > Pages > Source: select "GitHub Actions"
3. Push to `main` branch or trigger the workflow manually
4. Your site will be available at `https://<username>.github.io/jellyfin-web-emby/`

## Build Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JELLYFIN_WEB_VERSION` | `v10.10.7` | Jellyfin Web git tag to build from |

### Changing Jellyfin Web Version

```bash
# Build with a specific version
JELLYFIN_WEB_VERSION=v10.10.6 bash build.sh
```

Or trigger GitHub Actions manually and specify the version.

## CORS Configuration

Since this is a pure frontend app making cross-origin requests to your Emby server, you need to ensure CORS is properly configured.

### Option A: Emby Built-in CORS (if available)

Some Emby versions support CORS configuration in the dashboard settings.

### Option B: Reverse Proxy

Use Nginx, Caddy, or similar as a reverse proxy in front of Emby:

```nginx
# Nginx example
server {
    listen 443 ssl;
    server_name emby.yourdomain.com;

    location / {
        proxy_pass http://localhost:8096;
        
        # CORS headers
        add_header Access-Control-Allow-Origin "https://your-github-pages-url" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-Emby-Authorization, X-Emby-Token" always;
        add_header Access-Control-Allow-Credentials "true" always;
        
        if ($request_method = OPTIONS) {
            return 204;
        }

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Syncing with Upstream Jellyfin Web

This project is designed to easily track upstream Jellyfin Web bugfixes:

1. The **Emby adapter is isolated** in `src/emby-adapter/` — it doesn't modify any Jellyfin Web source files
2. The **injection is done via a single `sed` command** in `build.sh` that adds one import line
3. To update: simply change `JELLYFIN_WEB_VERSION` in `build.sh` or the GitHub Actions workflow

```bash
# Update to latest Jellyfin Web release
JELLYFIN_WEB_VERSION=v10.10.8 bash build.sh
```

If a new Jellyfin Web version introduces breaking changes, only the adapter layer needs to be updated.

## Debugging

Enable debug logging in the browser console:

```javascript
localStorage.setItem('emby_adapter_debug', 'true');
// Reload the page to see adapter logs
```

Access the adapter API:

```javascript
// Check adapter status
EmbyAdapter.version        // "1.0.0"
EmbyAdapter.isEnabled()    // true
EmbyAdapter.getServerUrl() // "http://your-server:8096"

// Test connection
await EmbyAdapter.testConnection('http://your-server:8096')

// Clear stored credentials (logout)
EmbyAdapter.clearCredentials()
location.reload()
```

## Known Limitations

| Feature | Status | Notes |
|---------|--------|-------|
| Browse library | ✅ Works | Core Items/Library API is compatible |
| Media playback (direct) | ✅ Works | Direct play/stream should work |
| User authentication | ✅ Works | Custom Emby auth flow implemented |
| Search | ✅ Works | Search API is compatible |
| Media playback (transcode) | ⚠️ Partial | Transcoding parameters may differ |
| Live TV / DVR | ⚠️ Partial | API differences in TV guide |
| Server dashboard/admin | ⚠️ Limited | Admin APIs have diverged significantly |
| Emby Premiere features | ❌ N/A | Premiere-specific APIs not supported |
| Sync / Offline | ❌ N/A | Requires native client |
| Trickplay / Chapters | ⚠️ Partial | Jellyfin-specific features may not map |

## Project Structure

```
jellyfin-web-emby/
├── src/
│   └── emby-adapter/
│       ├── index.js          # Entry point, setup UI, credential sync
│       └── embyAdapter.js    # Core adapter (fetch/XHR/WS interception)
├── patches/                   # Git patches for jellyfin-web (if needed)
├── .github/
│   └── workflows/
│       └── build-and-deploy.yml   # CI/CD pipeline
├── build.sh                   # Build script
├── config.json                # Jellyfin Web config template
├── LICENSE                    # GPL-2.0 (inherited from Jellyfin Web)
└── README.md                  # This file
```

## How the Adapter Works (Technical Details)

### Request Interception

The adapter monkey-patches `window.fetch`, `XMLHttpRequest`, and `WebSocket` before any Jellyfin Web code loads:

1. **URL Rewriting**: API requests get `/emby/` prefix added to their path
2. **Header Transformation**: `Authorization: MediaBrowser Client="..." ...` becomes `X-Emby-Authorization: Emby Client="..." ...`
3. **Body Transformation**: Login requests ensure the `Pw` field is present (Emby's plaintext password field)
4. **Token Extraction**: Auth responses are intercepted to store the `AccessToken`
5. **Image URLs**: A MutationObserver adds `api_key` query params to `<img>` src attributes
6. **WebSocket**: Connection URLs get `/emby/` prefix and `api_key` parameter

### Credential Sync

The adapter maintains its own credential storage and syncs to Jellyfin Web's expected format (`jellyfin_credentials` in localStorage), so Jellyfin Web's built-in session management works seamlessly.

## Contributing

1. Fork the repository
2. Make changes to files in `src/emby-adapter/`
3. Test locally with `bash build.sh && cd dist && npx serve -s .`
4. Submit a pull request

## License

This project is licensed under **GPL-2.0-or-later**, inherited from [Jellyfin Web](https://github.com/jellyfin/jellyfin-web).

The Emby adapter code in `src/emby-adapter/` is also released under GPL-2.0-or-later.
