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
# This CANONICAL tree (~/.kist/mcp/tinky-vision-mcp) is the superset: capture
# (stream/see-through) AND window control (control-click/move/raise) AND the
# `control-inbox` grant-holder daemon. Building the app from here lets ONE signed
# app hold BOTH the Screen Recording grant (capture) and the Accessibility grant
# (drive windows behind the mirror for the launchd console).
#
# Usage: ./build-tinkystream-app.sh [--dev] [--deploy]
#   default   → build + sign the artifact in place; does NOT touch the live app.
#               Stage-test, then re-run with --deploy.
#   --deploy  → also install to ~/Applications and kickstart the agents.
#   --dev     → Apple Development identity instead of Developer ID.
set -euo pipefail

cd "$(dirname "$0")"

# --- signing identity (stable DR is the whole point) ---
DEVID="Developer ID Application: Roll SEO LLC (VN5845CUT7)"
APPLEDEV="Apple Development: luke kist (BSB58U2BBV)"
IDENTITY="$DEVID"
DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --dev) IDENTITY="$APPLEDEV" ;;
    --deploy) DEPLOY=1 ;;
  esac
done

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
  <key>CFBundleShortVersionString</key><string>1.2</string>
  <key>CFBundleVersion</key><string>1.2</string>
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

if [[ "$DEPLOY" -eq 0 ]]; then
  echo
  echo "==> Built + signed artifact (NOT deployed — live capture app untouched):"
  echo "      $OUT_APP"
  echo "    Stage-test it, then re-run with --deploy to install to ~/Applications."
  exit 0
fi

echo "==> Deploying to ${DEPLOY_APP}"
rm -rf "$DEPLOY_APP"
mkdir -p "$HOME/Applications"
cp -R "$OUT_APP" "$DEPLOY_APP"

echo "==> Kickstarting agents (capture + control inbox)…"
/bin/launchctl kickstart -k "gui/$(id -u)/com.tinky.tinkystream" 2>/dev/null || true
/bin/launchctl kickstart -k "gui/$(id -u)/com.tinky.tinkystream-control" 2>/dev/null || true

echo "==> DONE. Signed ${APP_NAME}.app at:"
echo "      $OUT_APP  (build artifact)"
echo "      $DEPLOY_APP  (deployed)"
echo
echo "If Accessibility was never granted: launch it once & click Allow, or add"
echo "$DEPLOY_APP in System Settings → Privacy & Security → Accessibility."
echo "The stable DR means every future rebuild via this script keeps the grant."
