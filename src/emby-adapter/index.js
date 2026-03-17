/**
 * Emby Adapter - Entry Point
 * 
 * This script initializes the Emby adapter and provides
 * a setup UI when no server is configured.
 */

// Load the core adapter first
import './embyAdapter.js';

(function() {
    'use strict';

    const EMBY_SERVER_KEY = 'emby_server_url';
    const EMBY_TOKEN_KEY = 'emby_access_token';

    /**
     * Inject Jellyfin credentials format so Jellyfin Web recognizes the login
     */
    function syncCredentialsToJellyfin() {
        const serverUrl = localStorage.getItem(EMBY_SERVER_KEY);
        const token = localStorage.getItem(EMBY_TOKEN_KEY);
        const userId = localStorage.getItem('emby_user_id');

        if (!serverUrl || !token || !userId) return;

        // Jellyfin Web stores credentials in this format
        const credentials = {
            Servers: [{
                ManualAddress: serverUrl,
                Id: localStorage.getItem('emby_server_id') || '',
                UserId: userId,
                AccessToken: token,
                Name: localStorage.getItem('emby_server_name') || 'Emby Server',
                DateLastAccessed: new Date().toISOString()
            }]
        };

        // Store in Jellyfin's credential format
        localStorage.setItem('jellyfin_credentials', JSON.stringify(credentials));

        console.log('[EmbyAdapter] Credentials synced to Jellyfin format');
    }

    /**
     * Check if we need to show the setup page
     */
    function checkSetupNeeded() {
        const serverUrl = localStorage.getItem(EMBY_SERVER_KEY);
        if (!serverUrl) {
            showSetupPage();
            return true;
        }
        return false;
    }

    /**
     * Normalize a server URL input - supports formats like:
     *   192.168.1.100:8096
     *   http://myserver:8096
     *   https://emby.example.com
     *   myserver.local:8096
     */
    function normalizeServerUrl(input) {
        let url = input.trim().replace(/\/+$/, '');
        // Add protocol if missing
        if (!/^https?:\/\//i.test(url)) {
            url = 'http://' + url;
        }
        return url;
    }

    /**
     * Show the Emby server setup page
     */
    function showSetupPage() {
        // Wait for DOM to be ready
        const show = () => {
            document.body.innerHTML = '';
            document.body.style.cssText = 'margin:0;padding:0;background:#101010;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;';

            const container = document.createElement('div');
            container.style.cssText = 'max-width:420px;width:100%;padding:40px;background:#1a1a1a;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

            container.innerHTML = `
                <div style="text-align:center;margin-bottom:32px;">
                    <h1 style="margin:0 0 8px;font-size:24px;font-weight:600;color:#00a4dc;">Jellyfin Web for Emby</h1>
                    <p style="margin:0;color:#888;font-size:14px;">Connect to your Emby server</p>
                </div>
                <div id="setup-form">
                    <div style="margin-bottom:20px;">
                        <label style="display:block;margin-bottom:6px;font-size:13px;color:#aaa;">Server Address</label>
                        <input id="emby-server-url" type="text" placeholder="192.168.1.100:8096 or https://emby.example.com" 
                               style="width:100%;padding:10px 12px;background:#252525;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;outline:none;"
                               onfocus="this.style.borderColor='#00a4dc'" onblur="this.style.borderColor='#333'" />
                        <p style="margin:4px 0 0;font-size:11px;color:#666;">Supports IP:port, hostname:port, or full URL</p>
                    </div>
                    <div style="margin-bottom:20px;">
                        <label style="display:block;margin-bottom:6px;font-size:13px;color:#aaa;">Username</label>
                        <input id="emby-username" type="text" placeholder="Username" 
                               style="width:100%;padding:10px 12px;background:#252525;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;outline:none;"
                               onfocus="this.style.borderColor='#00a4dc'" onblur="this.style.borderColor='#333'" />
                    </div>
                    <div style="margin-bottom:24px;">
                        <label style="display:block;margin-bottom:6px;font-size:13px;color:#aaa;">Password</label>
                        <input id="emby-password" type="password" placeholder="Password" 
                               style="width:100%;padding:10px 12px;background:#252525;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;outline:none;"
                               onfocus="this.style.borderColor='#00a4dc'" onblur="this.style.borderColor='#333'" />
                    </div>
                    <button id="emby-connect-btn" 
                            style="width:100%;padding:12px;background:#00a4dc;border:none;border-radius:6px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:background 0.2s;"
                            onmouseover="this.style.background='#0088b8'" onmouseout="this.style.background='#00a4dc'">
                        Connect
                    </button>
                    <div id="emby-status" style="margin-top:16px;text-align:center;font-size:13px;min-height:20px;"></div>
                </div>
                <div style="margin-top:24px;padding-top:16px;border-top:1px solid #333;text-align:center;">
                    <p style="margin:0;color:#555;font-size:12px;">
                        Powered by <a href="https://github.com/Tsutomu-miku/jellyfin-web-emby" target="_blank" style="color:#00a4dc;text-decoration:none;">jellyfin-web-emby</a>
                    </p>
                </div>
            `;

            document.body.appendChild(container);

            // Bind events
            document.getElementById('emby-connect-btn').addEventListener('click', handleConnect);
            document.getElementById('emby-password').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConnect();
            });
            // Also allow Enter on username field
            document.getElementById('emby-username').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') document.getElementById('emby-password').focus();
            });
            // Also allow Enter on server URL field
            document.getElementById('emby-server-url').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') document.getElementById('emby-username').focus();
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show);
        } else {
            show();
        }
    }

    /**
     * Handle the connect button click
     */
    async function handleConnect() {
        const rawServerUrl = document.getElementById('emby-server-url').value.trim();
        const username = document.getElementById('emby-username').value.trim();
        const password = document.getElementById('emby-password').value;
        const statusEl = document.getElementById('emby-status');
        const btn = document.getElementById('emby-connect-btn');

        if (!rawServerUrl) {
            statusEl.innerHTML = '<span style="color:#e74c3c;">Please enter a server address</span>';
            return;
        }
        if (!username) {
            statusEl.innerHTML = '<span style="color:#e74c3c;">Please enter a username</span>';
            return;
        }

        // Normalize the server URL (handles IP:port, hostname:port, etc.)
        const serverUrl = normalizeServerUrl(rawServerUrl);

        btn.disabled = true;
        btn.textContent = 'Connecting...';
        btn.style.opacity = '0.7';
        statusEl.innerHTML = '<span style="color:#aaa;">Testing connection to ' + serverUrl + '...</span>';

        // Step 1: Test connection
        const testResult = await window.EmbyAdapter.testConnection(serverUrl);
        if (!testResult.success) {
            statusEl.innerHTML = '<span style="color:#e74c3c;">Connection failed: ' + testResult.error + '</span>';
            btn.disabled = false;
            btn.textContent = 'Connect';
            btn.style.opacity = '1';
            return;
        }

        statusEl.innerHTML = '<span style="color:#aaa;">Connected to ' + (testResult.serverName || 'server') + ' (v' + (testResult.version || '?') + '). Authenticating...</span>';

        // Store server info
        localStorage.setItem('emby_server_name', testResult.serverName || '');
        localStorage.setItem('emby_server_id', testResult.id || '');

        // Step 2: Authenticate
        const authResult = await window.EmbyAdapter.authenticate(serverUrl, username, password);
        if (!authResult.success) {
            statusEl.innerHTML = '<span style="color:#e74c3c;">' + authResult.error + '</span>';
            btn.disabled = false;
            btn.textContent = 'Connect';
            btn.style.opacity = '1';
            return;
        }

        statusEl.innerHTML = '<span style="color:#2ecc71;">Authenticated as ' + authResult.userName + '. Loading...</span>';

        // Step 3: Sync credentials to Jellyfin format and reload
        syncCredentialsToJellyfin();

        setTimeout(() => {
            window.location.reload();
        }, 1000);
    }

    // ==================== Main ====================

    // If already configured, sync credentials and let Jellyfin Web load normally
    const serverUrl = localStorage.getItem(EMBY_SERVER_KEY);
    const token = localStorage.getItem(EMBY_TOKEN_KEY);

    if (serverUrl && token) {
        syncCredentialsToJellyfin();
        console.log('[EmbyAdapter] Emby server configured, Jellyfin Web will load normally with adapter active');
    } else {
        // Show setup page
        checkSetupNeeded();
    }

})();
