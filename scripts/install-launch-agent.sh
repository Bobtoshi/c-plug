#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
RUNTIME_DIR="$HOME/Library/Application Support/CPlug"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex || true)"
RUNTIME_PATH="${NODE_BIN:h}:${CODEX_BIN:h}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TARGET="$HOME/Library/LaunchAgents/com.cplug.agent.plist"
TEMPLATE="$PROJECT_DIR/scripts/com.cplug.agent.plist.template"

mkdir -p "$RUNTIME_DIR" "$HOME/Library/LaunchAgents"
/usr/bin/rsync -a --delete \
  --exclude data --exclude output --exclude outputs --exclude .playwright-cli --exclude .git --exclude .DS_Store \
  "$PROJECT_DIR/" "$RUNTIME_DIR/"
mkdir -p "$RUNTIME_DIR/data"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR/data"
[[ -f "$RUNTIME_DIR/.env" ]] && chmod 600 "$RUNTIME_DIR/.env"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__RUNTIME__|$RUNTIME_DIR|g" -e "s|__PATH__|$RUNTIME_PATH|g" "$TEMPLATE" > "$TARGET"
plutil -lint "$TARGET"
launchctl bootout "gui/$UID/com.cplug.agent" 2>/dev/null || true
sleep 1
if ! launchctl bootstrap "gui/$UID" "$TARGET"; then
  sleep 1
  launchctl bootstrap "gui/$UID" "$TARGET"
fi
launchctl enable "gui/$UID/com.cplug.agent"
echo "Installed com.cplug.agent from $RUNTIME_DIR. Open http://127.0.0.1:4317 to finish iMessage pairing."
