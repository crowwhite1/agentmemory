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
if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is missing; refusing unpinned install." >&2
  exit 1
fi
echo "[agentmemory-migrate] Building fork and running tests before modifying services..."
npm ci
npm test
exec python3 scripts/migrate-from-proxy.py
