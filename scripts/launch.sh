#!/bin/zsh
# Start airoom from a double-click. A GUI launch has no nvm on PATH, so the
# commands run through the interactive shell's environment.
#   launch.sh         desktop shell (tray badge, notifications) — ~800 MB
#   launch.sh --lite  server only, UI in your browser — ~300 MB
# Stop the lite server: curl -X POST http://127.0.0.1:8787/shutdown
cd "$(dirname "$0")/.." || exit 1
mkdir -p ~/.airoom
if [[ "$1" != "--lite" ]]; then
  exec /bin/zsh -lic 'npm run app' > ~/.airoom/launch.log 2>&1
fi
url=http://127.0.0.1:8787
if ! curl -s -m 2 $url/health > /dev/null; then
  # No file watcher in lite mode: plain tsx, against a fresh web build.
  /bin/zsh -lic 'npm run build --prefix web && cd server && exec npx tsx src/index.ts' > ~/.airoom/launch.log 2>&1 &
  for i in {1..60}; do curl -s -m 2 $url/health > /dev/null && break; sleep 1; done
fi
open $url
