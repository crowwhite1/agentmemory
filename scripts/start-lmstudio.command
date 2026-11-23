#!/bin/zsh
set -euo pipefail
LMS="$HOME/.lmstudio/bin/lms"
if [[ ! -x "$LMS" ]]; then
  LMS="$(command -v lms || true)"
fi
if [[ -z "$LMS" ]]; then
  echo "LM Studio CLI is unavailable" >&2
  exit 1
fi
"$LMS" daemon up || true
"$LMS" server start --port 1234 --bind 127.0.0.1
