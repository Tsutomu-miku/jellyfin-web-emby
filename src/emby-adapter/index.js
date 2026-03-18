/**
 * Emby Adapter Entry Point / Setup UI v2.0.0
 * 
 * Flow:
 * 1. Check if embyAdapterConfig has a serverUrl + token
 * 2. If YES → let Jellyfin Web load normally (adapter handles API interception)
 * 3. If NO → show login overlay, authenticate, save config, reload page
 */

(function () {
    'use strict';

    const config = (() => {
        try { return JSON.parse(localStorage.getItem('embyAdapterConfig') || '{}'); }
        catch { return {}; }
    })();

    // Already configured — let Jellyfin Web load
    if (config.serverUrl && config.token) {
        console.log('[EmbySetup] Server configured:', config.serverUrl);
        return;
    }

    // Not configured — show setup UI and PREVENT Jellyfin Web from loading
    console.log('[EmbySetup] No server configured, showing login UI');

    function normalizeServerUrl(input) {
        let url = input.trim();
        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) {
            url = 'http://' + url;
        }
        return url.replace(/\/+$/, '');
    }

    function showSetup() {
        // Hide the Jellyfin app root
        const appRoot = document.getElementById('app-root') || document.getElementById('reactRoot');
        if (appRoot) appRoot.style.display = 'none';

        const overlay = document.createElement('div');
        overlay.id = 'emby-setup-overlay';
        overlay.innerHTML = `
        <style>
            #emby-setup-overlay {
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: #101010; color: #eee; z-index: 999999;
                display: flex; justify-content: center; align-items: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            .setup-card {
                background: #1a1a2e; border-radius: 12px; padding: 40px;
                max-width: 420px; width: 90%; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
            }
            .setup-card h1 { margin: 0 0 8px; font-size: 24px; color: #00a4dc; }
            .setup-card p { margin: 0 0 24px; color: #aaa; font-size: 14px; }
            .setup-card label { display: block; margin-bottom: 6px; font-size: 13px; color: #ccc; }
            .setup-card input {
                width: 100%; box-sizing: border-box; padding: 10px 12px;
                border: 1px solid #333; border-radius: 6px;
                background: #0f0f1a; color: #eee; font-size: 14px;
                margin-bottom: 16px;
            }
            .setup-card input:focus { outline: none; border-color: #00a4dc; }
            .setup-card button {
                width: 100%; padding: 12px; border: none; border-radius: 6px;
                background: #00a4dc; color: #fff; font-size: 15px; font-weight: 600;
                cursor: pointer; transition: background .2s;
            }
            .setup-card button:hover { background: #0090c4; }
            .setup-card button:disabled { opacity: 0.6; cursor: wait; }
            .setup-error {
                background: #3a1a1a; color: #ff6b6b; padding: 10px; border-radius: 6px;
                margin-bottom: 16px; font-size: 13px; display: none;
            }
            .hint { color: #666; font-size: 12px; margin-top: -10px; margin-bottom: 16px; }
        </style>
        <div class="setup-card">
            <h1>Jellyfin Web \u00d7 Emby</h1>
            <p>Connect to your Emby server to get started.</p>
            <div class="setup-error" id="setup-error"></div>
            <label for="setup-server">Server Address</label>
            <input type="text" id="setup-server" placeholder="e.g. 192.168.1.100:8096 or https://emby.example.com" autocomplete="url" />
            <div class="hint">Supports IP:port, hostname:port, or full URL</div>
            <label for="setup-user">Username</label>
            <input type="text" id="setup-user" placeholder="Username" autocomplete="username" />
            <label for="setup-pass">Password</label>
            <input type="password" id="setup-pass" placeholder="Password" autocomplete="current-password" />
            <button id="setup-btn">Connect</button>
        </div>
        `;
        document.body.appendChild(overlay);

        const btnEl = document.getElementById('setup-btn');
        const errEl = document.getElementById('setup-error');

        async function doConnect() {
            const rawServer = document.getElementById('setup-server').value;
            const username = document.getElementById('setup-user').value.trim();
            const password = document.getElementById('setup-pass').value;
            const serverUrl = normalizeServerUrl(rawServer);

            if (!serverUrl) {
                errEl.textContent = 'Please enter a server address.';
                errEl.style.display = 'block';
                return;
            }
            if (!username) {
                errEl.textContent = 'Please enter a username.';
                errEl.style.display = 'block';
                return;
            }

            errEl.style.display = 'none';
            btnEl.disabled = true;
            btnEl.textContent = 'Connecting...';

            try {
                const test = await window.EmbyAdapter.testConnection(serverUrl);
                if (!test.success) {
                    throw new Error('Cannot reach server: ' + test.error);
                }

                await window.EmbyAdapter.authenticate(serverUrl, username, password);

                btnEl.textContent = 'Success! Reloading...';
                setTimeout(() => window.location.reload(), 500);
            } catch (e) {
                errEl.textContent = e.message || 'Connection failed.';
                errEl.style.display = 'block';
                btnEl.disabled = false;
                btnEl.textContent = 'Connect';
            }
        }

        btnEl.addEventListener('click', doConnect);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doConnect();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showSetup);
    } else {
        showSetup();
    }
})();
