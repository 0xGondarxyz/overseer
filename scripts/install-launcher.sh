#!/usr/bin/env bash
# Adds Overseer to the app menu. Run again any time; it overwrites its own launcher only.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
# The electron binary itself, not node_modules/.bin/electron: that one needs `node` on PATH,
# and an app-menu launch gets a minimal PATH.
cat > "$APPS/overseer.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Overseer
Comment=Claude Code tabs with an overseer
Exec=$ROOT/node_modules/electron/dist/electron $ROOT
Icon=$ROOT/assets/icon.svg
Terminal=false
Categories=Development;
StartupWMClass=overseer
EOF
chmod 644 "$APPS/overseer.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
echo "Overseer is in the app menu: $APPS/overseer.desktop"
