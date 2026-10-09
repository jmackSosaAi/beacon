#!/bin/zsh
# Installs Claude Code managed settings (ROADMAP M6): machine-wide deny rules for keys, finance/, ~/.ssh, Keychains,
# Messages and the Chrome profile; write protection on the Mac node's own Claude settings and LaunchAgents.
# Plugin marketplaces are left alone (his existing plugins keep working). Root-owned, so no Claude session can edit it.
# Bypass mode is NOT disabled machine-wide (Jackson's `claude` alias uses it); the node never runs in bypass mode.
# Run with sudo in a regular Terminal (it asks for your Mac password, hidden input).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo $0"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)/agent-node/managed-settings.json"
DEST="/Library/Application Support/ClaudeCode"
/usr/bin/python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$SRC" || { echo "managed-settings.json is not valid JSON"; exit 1; }
mkdir -p "$DEST"
install -o root -g wheel -m 0644 "$SRC" "$DEST/managed-settings.json"
chown root:wheel "$DEST"; chmod 0755 "$DEST"
echo "Installed $DEST/managed-settings.json (root:wheel 0644). New Claude Code sessions pick it up."
