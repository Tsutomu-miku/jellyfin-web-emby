#!/bin/bash
set -euo pipefail

# ============================================================
# jellyfin-web-emby build script
# 
# Clones jellyfin-web, injects the Emby adapter layer,
# applies patches, and produces a static dist/ ready for
# deployment to GitHub Pages or any static file server.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JELLYFIN_WEB_VERSION="${JELLYFIN_WEB_VERSION:-v10.10.7}"
JELLYFIN_WEB_REPO="https://github.com/jellyfin/jellyfin-web.git"
WORK_DIR="${SCRIPT_DIR}/.build"
DIST_DIR="${SCRIPT_DIR}/dist"

echo "========================================"
echo " jellyfin-web-emby builder"
echo " Jellyfin Web version: ${JELLYFIN_WEB_VERSION}"
echo "========================================"

# ---- Step 1: Clone jellyfin-web ----
echo ""
echo "[1/6] Cloning jellyfin-web ${JELLYFIN_WEB_VERSION}..."

if [ -d "${WORK_DIR}/jellyfin-web" ]; then
    echo "  -> Cleaning previous build..."
    rm -rf "${WORK_DIR}/jellyfin-web"
fi

mkdir -p "${WORK_DIR}"
git clone --depth 1 --branch "${JELLYFIN_WEB_VERSION}" "${JELLYFIN_WEB_REPO}" "${WORK_DIR}/jellyfin-web" 2>&1 | tail -1

echo "  -> Cloned successfully."

# ---- Step 2: Copy Emby adapter files ----
echo ""
echo "[2/6] Injecting Emby adapter..."

ADAPTER_SRC="${SCRIPT_DIR}/src/emby-adapter"
ADAPTER_DST="${WORK_DIR}/jellyfin-web/src/emby-adapter"

mkdir -p "${ADAPTER_DST}"
cp -r "${ADAPTER_SRC}"/* "${ADAPTER_DST}/"

echo "  -> Adapter files copied to src/emby-adapter/"

# ---- Step 3: Apply patches ----
echo ""
echo "[3/6] Applying patches..."

PATCHES_DIR="${SCRIPT_DIR}/patches"
if [ -d "${PATCHES_DIR}" ] && ls "${PATCHES_DIR}"/*.patch 1>/dev/null 2>&1; then
    cd "${WORK_DIR}/jellyfin-web"
    for patch in "${PATCHES_DIR}"/*.patch; do
        echo "  -> Applying $(basename ${patch})..."
        git apply --allow-empty "${patch}" || {
            echo "  !! Patch failed, attempting with --3way..."
            git apply --3way "${patch}" || {
                echo "  !! WARNING: Patch $(basename ${patch}) failed to apply. Trying manual injection..."
            }
        }
    done
    cd "${SCRIPT_DIR}"
else
    echo "  -> No patches found, using script-based injection..."
fi

# ---- Step 3b: Script-based injection (fallback / primary method) ----
echo ""
echo "[3b/6] Injecting adapter via script modification..."

cd "${WORK_DIR}/jellyfin-web"

# Method: Inject adapter as the FIRST import in the main entry file
# The adapter MUST load before any Jellyfin code to intercept fetch/XHR
ENTRY_FILE="src/index.jsx"
if [ -f "${ENTRY_FILE}" ]; then
    # Add import at the very top of the entry file
    if ! grep -q "emby-adapter" "${ENTRY_FILE}"; then
        sed -i '1i\// Emby Adapter - must be first import\nimport "./emby-adapter/index.js";\n' "${ENTRY_FILE}"
        echo "  -> Injected adapter import into ${ENTRY_FILE}"
    else
        echo "  -> Adapter import already present in ${ENTRY_FILE}"
    fi
else
    echo "  !! Entry file ${ENTRY_FILE} not found!"
    # Try alternative entry points
    for alt in "src/index.js" "src/index.ts" "src/index.tsx"; do
        if [ -f "${alt}" ]; then
            sed -i '1i\// Emby Adapter - must be first import\nimport "./emby-adapter/index.js";\n' "${alt}"
            echo "  -> Injected adapter import into ${alt}"
            break
        fi
    done
fi

cd "${SCRIPT_DIR}"

# ---- Step 4: Install dependencies ----
echo ""
echo "[4/6] Installing dependencies..."

cd "${WORK_DIR}/jellyfin-web"

# Use npm ci for reproducible builds, fall back to npm install
if [ -f "package-lock.json" ]; then
    npm ci --no-audit --no-fund 2>&1 | tail -3
else
    npm install --no-audit --no-fund 2>&1 | tail -3
fi

echo "  -> Dependencies installed."

# ---- Step 5: Build ----
echo ""
echo "[5/6] Building Jellyfin Web with Emby adapter..."

# Set production mode
export NODE_ENV=production

npm run build:production 2>&1 | tail -5

echo "  -> Build complete."

cd "${SCRIPT_DIR}"

# ---- Step 6: Prepare dist ----
echo ""
echo "[6/6] Preparing distribution..."

rm -rf "${DIST_DIR}"
cp -r "${WORK_DIR}/jellyfin-web/dist" "${DIST_DIR}"

# Copy our custom config.json
if [ -f "${SCRIPT_DIR}/config.json" ]; then
    cp "${SCRIPT_DIR}/config.json" "${DIST_DIR}/config.json"
    echo "  -> Custom config.json copied."
fi

# Create a .nojekyll file for GitHub Pages
touch "${DIST_DIR}/.nojekyll"

# Create 404.html for SPA routing on GitHub Pages
if [ -f "${DIST_DIR}/index.html" ]; then
    cp "${DIST_DIR}/index.html" "${DIST_DIR}/404.html"
    echo "  -> 404.html created for SPA routing."
fi

echo ""
echo "========================================"
echo " Build complete!"
echo " Output: ${DIST_DIR}/"
echo ""
echo " To test locally:"
echo "   cd dist && npx serve -s ."
echo ""
echo " To deploy to GitHub Pages:"
echo "   Push to main branch (GitHub Actions)"
echo "   or manually upload dist/ contents"
echo "========================================"
