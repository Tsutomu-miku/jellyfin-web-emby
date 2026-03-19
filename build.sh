#!/bin/bash
set -e

# Strip leading 'v' if present (handle both '10.10.7' and 'v10.10.7')
RAW_VERSION=${JELLYFIN_WEB_VERSION:-"10.10.7"}
JELLYFIN_WEB_VERSION="${RAW_VERSION#v}"

JELLYFIN_WEB_RELEASE_URL="https://github.com/jellyfin/jellyfin-web/archive/refs/tags/v${JELLYFIN_WEB_VERSION}.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
DIST_DIR="${SCRIPT_DIR}/dist"
SRC_DIR="${SCRIPT_DIR}/src"

echo "============================================"
echo " Jellyfin Web Emby Adapter Build Script"
echo "============================================"
echo ""
echo "Jellyfin Web Version: ${JELLYFIN_WEB_VERSION}"
echo "Download URL: ${JELLYFIN_WEB_RELEASE_URL}"
echo "Build Directory: ${BUILD_DIR}"
echo "Distribution Directory: ${DIST_DIR}"
echo ""

# ---------------------------------------------------------------------------
# Helper: increase file descriptor limit to avoid EMFILE errors in CI
# Some GitHub Actions runners default to ulimit -n 1024, which is too low
# for npm ci on large dependency trees (jellyfin-web has 1856 packages).
# ---------------------------------------------------------------------------
bump_fd_limit() {
    local target="${1:-4096}"
    local current
    current="$(ulimit -n 2>/dev/null || echo 0)"
    if [ "$current" -lt "$target" ] 2>/dev/null; then
        echo "  -> Current open-file limit is ${current}; attempting to raise to ${target}..."
        ulimit -n "$target" 2>/dev/null || true
        echo "  -> Open-file limit is now $(ulimit -n 2>/dev/null || echo unknown)"
    else
        echo "  -> Open-file limit is already ${current} (>= ${target}); no change needed."
    fi
}

# ---------------------------------------------------------------------------
# Helper: resilient npm install
#   1. Try `npm ci --no-audit` (fast, exact lockfile install).
#   2. If it fails with an EMFILE-related error, fall back to
#      `npm install --no-audit --maxsockets=1` which throttles network and
#      file operations to a single concurrent socket.
# ---------------------------------------------------------------------------
resilient_npm_install() {
    local npm_log
    npm_log="$(mktemp)"

    echo "  -> Trying: npm ci --no-audit ..."
    if npm ci --no-audit > "$npm_log" 2>&1; then
        echo "  -> npm ci succeeded."
        echo "  -- last 20 lines of npm output --"
        tail -20 "$npm_log"
        rm -f "$npm_log"
        return 0
    fi

    # npm ci failed – check whether the failure is EMFILE-related
    local exit_code=$?
    echo "  -> npm ci failed (exit code ${exit_code})."
    echo "  -- last 20 lines of npm output --"
    tail -20 "$npm_log"

    if grep -qi 'EMFILE\|too many open files' "$npm_log"; then
        echo ""
        echo "  ** EMFILE detected – falling back to npm install --maxsockets=1 **"
        echo ""
        if npm install --no-audit --maxsockets=1 > "$npm_log" 2>&1; then
            echo "  -> npm install --maxsockets=1 succeeded."
            echo "  -- last 20 lines of npm output --"
            tail -20 "$npm_log"
            rm -f "$npm_log"
            return 0
        else
            local fallback_exit=$?
            echo "  -> npm install --maxsockets=1 also failed (exit code ${fallback_exit})."
            echo "  -- last 20 lines of npm output --"
            tail -20 "$npm_log"
            rm -f "$npm_log"
            return "$fallback_exit"
        fi
    fi

    # Non-EMFILE failure – propagate the original error
    rm -f "$npm_log"
    return "$exit_code"
}

# Clean previous build
echo "[1/7] Cleaning previous build..."
rm -rf "${BUILD_DIR}" "${DIST_DIR}"
mkdir -p "${BUILD_DIR}" "${DIST_DIR}"

# Download jellyfin-web source
echo "[2/7] Downloading jellyfin-web v${JELLYFIN_WEB_VERSION}..."
TARBALL="${BUILD_DIR}/jellyfin-web-${JELLYFIN_WEB_VERSION}.tar.gz"
if ! curl -fSL "${JELLYFIN_WEB_RELEASE_URL}" -o "${TARBALL}"; then
    echo "Error: Failed to download jellyfin-web v${JELLYFIN_WEB_VERSION} from:"
    echo "  ${JELLYFIN_WEB_RELEASE_URL}"
    exit 1
fi

# Extract source
echo "[3/7] Extracting source..."
tar xzf "${TARBALL}" -C "${BUILD_DIR}"
JELLYFIN_SRC="${BUILD_DIR}/jellyfin-web-${JELLYFIN_WEB_VERSION}"

if [ ! -d "${JELLYFIN_SRC}" ]; then
    echo "Error: Expected source directory not found: ${JELLYFIN_SRC}"
    exit 1
fi

# Install dependencies
echo "[4/7] Installing dependencies..."
cd "${JELLYFIN_SRC}"

# Raise file descriptor limit before running npm
bump_fd_limit 4096

# Run npm install with EMFILE fallback
if ! resilient_npm_install; then
    echo ""
    echo "Error: npm dependency installation failed. See output above for details."
    exit 1
fi

# ========================================
# PATCH: Disable version check in node_modules (belt-and-suspenders)
# ========================================
echo "[5/7] Patching version checks in node_modules..."

# --- jellyfin-apiclient ---
echo "  - Patching jellyfin-apiclient initial version value..."
find "${JELLYFIN_SRC}/node_modules" -name "*.js" -path "*jellyfin-apiclient*" \
  -exec grep -l "_minServerVersion" {} \; 2>/dev/null | while read f; do
    echo "    Patching: $f"
    sed -i "s/\._minServerVersion\s*=\s*['\"][0-9.]*['\"]/._minServerVersion = '0.0.0'/g" "$f"
done

# --- @jellyfin/sdk ---
echo "  - Patching @jellyfin/sdk MINIMUM_VERSION..."
if [ -d "${JELLYFIN_SRC}/node_modules/@jellyfin/sdk" ]; then
    find "${JELLYFIN_SRC}/node_modules/@jellyfin/sdk" \( -name "*.js" -o -name "*.ts" \) 2>/dev/null | while read f; do
        if grep -q "MINIMUM_VERSION" "$f" 2>/dev/null; then
            echo "    Patching: $f"
            sed -i "s/MINIMUM_VERSION\s*=\s*['\"][0-9.]*['\"]/MINIMUM_VERSION = '0.0.0'/g" "$f"
        fi
    done
fi

echo "  Version patches applied."

# ========================================
# PATCH: Inject Emby adapter import into entry point
# ========================================
echo "[6/7] Injecting Emby adapter..."

# Copy adapter source files into the jellyfin-web source tree
ADAPTER_DEST="${JELLYFIN_SRC}/src/emby-adapter"
mkdir -p "${ADAPTER_DEST}"
cp "${SRC_DIR}/emby-adapter/embyAdapter.js" "${ADAPTER_DEST}/"
cp "${SRC_DIR}/emby-adapter/index.js" "${ADAPTER_DEST}/"

# ========================================
# CRITICAL FIX: Ensure embyAdapter.js is treated as an ES module by Babel.
#
# embyAdapter.js is an IIFE with no import/export statements. Babel's
# sourceType:'unambiguous' would classify it as a 'script', but webpack
# treats it as an ES module (because it is imported via `import` statement).
# When @babel/preset-env injects core-js polyfills with useBuiltIns:'usage',
# the mismatch between Babel's script mode (require) and webpack's ESM
# expectation (import) causes the production build to fail.
#
# Appending `export {};` makes Babel recognize the file as an ES module,
# ensuring polyfill injections use consistent `import` syntax.
# ========================================
echo "  Ensuring embyAdapter.js has ES module export for Babel compatibility..."
if ! grep -q '^export' "${ADAPTER_DEST}/embyAdapter.js"; then
    printf '\n// Ensure Babel (sourceType: unambiguous) treats this file as an ES module\nexport {};\n' >> "${ADAPTER_DEST}/embyAdapter.js"
    echo "  Added 'export {};' to embyAdapter.js"
fi

# Find the main entry point and inject adapter import at the top
ENTRY_FILE="${JELLYFIN_SRC}/src/index.jsx"
if [ ! -f "${ENTRY_FILE}" ]; then
    ENTRY_FILE="${JELLYFIN_SRC}/src/index.js"
fi
if [ ! -f "${ENTRY_FILE}" ]; then
    ENTRY_FILE=$(find "${JELLYFIN_SRC}/src" -maxdepth 1 -name "index.*" | head -1)
fi

if [ -f "${ENTRY_FILE}" ]; then
    # Only inject if not already present (idempotent)
    if ! grep -q "emby-adapter" "${ENTRY_FILE}"; then
        echo "  Injecting into entry point: ${ENTRY_FILE}"
        TMPFILE=$(mktemp)
        cat > "${TMPFILE}" << 'ADAPTER_INJECT'
// === Emby Adapter Injection (auto-generated by build.sh) ===
import './emby-adapter/embyAdapter.js';
import './emby-adapter/index.js';
// === End Emby Adapter Injection ===

ADAPTER_INJECT
        cat "${ENTRY_FILE}" >> "${TMPFILE}"
        mv "${TMPFILE}" "${ENTRY_FILE}"
        echo "  Adapter injected successfully."
    else
        echo "  Adapter already injected in entry point, skipping."
    fi
else
    echo "  WARNING: Could not find entry point to inject adapter!"
    echo "  Will fall back to copying adapter files to dist."
fi

# Build
echo "[7/7] Building jellyfin-web (this may take a while)..."
npm run build:production 2>&1 | tail -20

DIST_SRC="${JELLYFIN_SRC}/dist"
if [ ! -d "${DIST_SRC}" ]; then
    echo "Error: Build output not found at ${DIST_SRC}"
    exit 1
fi

# Copy build output to dist
cp -r "${DIST_SRC}"/* "${DIST_DIR}/"

# NOTE: embyAdapter.js and index.js are bundled by webpack (Phase 1).
# Do NOT copy raw source files to dist/ — they use ES module syntax (import/export)
# which causes SyntaxError when loaded via plain <script> tags.

# ========================================
# CRITICAL: Copy Service Worker to dist root
# ========================================
# The Service Worker MUST be at the root of the served directory
# so its scope covers all pages. It cannot be bundled by webpack
# because it runs in a separate context (ServiceWorkerGlobalScope).
echo "  Copying Service Worker (sw.js) to dist root..."
cp "${SRC_DIR}/emby-adapter/sw.js" "${DIST_DIR}/sw.js"

# NOTE: Script tag injection removed in v1.7.0.
# The adapter is bundled by webpack and included in the main bundle.
# Injecting raw <script> tags caused double-loading and SyntaxError
# (ES module export/import keywords are invalid in classic script mode).

cd "${SCRIPT_DIR}"

# Clean up build directory
rm -rf "${BUILD_DIR}"

echo ""
echo "============================================"
echo " Build Complete!"
echo "============================================"
echo "Output: ${DIST_DIR}"
echo ""
echo "Files in dist:"
ls -la "${DIST_DIR}" | head -30
