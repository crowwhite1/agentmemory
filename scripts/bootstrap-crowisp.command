#!/bin/zsh
set -euo pipefail
REPO="$HOME/life/agentmemory"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "AgentMemory Crowisp migration is supported only on macOS." >&2
  exit 1
fi
if [[ -d "$REPO/.git" ]]; then
  if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
    echo "Uncommitted files in $REPO; refusing to overwrite. Commit/stash them and rerun." >&2
    exit 1
  fi
  git -C "$REPO" switch main
  git -C "$REPO" pull --ff-only origin main
elif [[ -e "$REPO" ]]; then
  echo "$REPO already exists but is not a git checkout; refusing to overwrite." >&2
  exit 1
else
  mkdir -p "$(dirname "$REPO")"
  git clone https://github.com/crowwhite1/agentmemory.git "$REPO"
fi
exec /bin/zsh "$REPO/scripts/migrate-from-proxy.command" "$@"
