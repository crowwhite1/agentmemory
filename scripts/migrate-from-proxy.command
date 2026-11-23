#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This migration supports macOS only." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Install Node.js 20+ and npm before migration." >&2
  exit 1
fi
# AgentMemory intentionally does not commit package-lock.json.
# Use the same installation flags as the upstream CI matrix.
echo "[agentmemory-migrate] Building fork and running tests before modifying services..."
# macOS system python3 may be 3.9; this migration needs tomllib (3.11+).
PYTHON=""
for candidate in python3.12 python3.11 "$HOME/life/agentmemory-proxy/.venv/bin/python" python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import tomllib; import sys; assert sys.version_info >= (3, 11)' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.11+ not found. Install it before attempting migration." >&2
  exit 1
fi
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm run skills:check
npm run typecheck:hooks
npm test
"$PYTHON" scripts/test-proxy-migration.py
exec "$PYTHON" scripts/migrate-from-proxy.py
