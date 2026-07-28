#!/usr/bin/env bash
# Build + sign TinkyStream.app — the stable-identity capture helper.
#
# WHY: a bare Mach-O signed ad-hoc (`codesign -s -`) gets a NEW cdhash and no
# stable Designated Requirement on every rebuild, so macOS TCC treats each build
# as new code and drops the Screen Recording grant (Apple DTS confirmed). A .app
# bundle signed with a STABLE Apple identity has a DR of identifier+team-id that
# survives rebuilds → the grant sticks. This script is the ONLY sanctioned way to
# (re)build the app so the identity never regresses to ad-hoc.
#
# Usage: ./build-tinkystream-app.sh [--dev]
#   default  → Developer ID Application: Roll SEO LLC (VN5845CUT7)  [distributable]
#   --dev    → Apple Development: luke kist (BSB58U2BBV)            [local dev]
set -euo pipefail

cd "$(dirname "$0")"

# --- signing identity (stable DR is the whole point) ---
DEVID="Developer ID Application: Roll SEO LLC (VN5845CUT7)"
APPLEDEV="Apple Development: luke kist (BSB58U2BBV)"
IDENTITY="$DEVID"
if [[ "${1:-}" == "--dev" ]]; then IDENTITY="$APPLEDEV"; fi

BUNDLE_ID="com.tinky.tinkystream"
APP_NAME="TinkyStream"
EXEC_NAME="TinkyStream"
OUT_APP="$PWD/${APP_NAME}.app"
DEPLOY_APP="$HOME/Applications/${APP_NAME}.app"

echo "==> Building release binary (tinky-os)…"
swift build -c release
BIN="$PWD/.build/release/tinky-os"
[[ -x "$BIN" ]] || { echo "build produced no binary at $BIN" >&2; exit 1; }

echo "==> Assembling ${APP_NAME}.app…"
rm -rf "$OUT_APP"
mkdir -p "$OUT_APP/Contents/MacOS"
cp "$BIN" "$OUT_APP/Contents/MacOS/${EXEC_NAME}"
chmod +x "$OUT_APP/Contents/MacOS/${EXEC_NAME}"

cat > "$OUT_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${EXEC_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundleVersion</key><string>1.1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>TinkyStream captures the desktop so Kist vision can see the screen live.</string>
</dict>
</plist>
PLIST

echo "==> Signing with: ${IDENTITY}"
# --options runtime (hardened runtime) is required for a Developer ID app to hold
# a durable TCC grant and to be notarizable later. --timestamp for the same reason.
codesign --force --options runtime --timestamp \
  --identifier "${BUNDLE_ID}" \
  --sign "${IDENTITY}" "$OUT_APP"

echo "==> Verifying signature + designated requirement…"
codesign --verify --deep --strict --verbose=2 "$OUT_APP"
echo "--- designated requirement (must be identifier+team, NOT cdhash) ---"
codesign -d -r - "$OUT_APP" 2>&1 | sed -n 's/^designated => //p'

echo "==> Deploying to ${DEPLOY_APP}"
rm -rf "$DEPLOY_APP"
mkdir -p "$HOME/Applications"
cp -R "$OUT_APP" "$DEPLOY_APP"

echo "==> DONE. Signed ${APP_NAME}.app at:"
echo "      $OUT_APP  (build artifact)"
echo "      $DEPLOY_APP  (deployed)"
echo
echo "Next: grant Screen Recording ONCE (launch it, click Allow). The stable DR"
echo "means every future rebuild via this script keeps the grant — no re-prompt."
