#!/usr/bin/env bash
# Alphadome Worker (macOS / Linux). Same thing the .cmd does on Windows.
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  Alphadome Worker"
echo "  ----------------"
echo "  Leave this window open while you want captures to run."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi

if [ ! -f worker-token.txt ]; then
  printf '  Paste the worker token from your Alphadome portal (starts with wkr_): '
  read -r TOKEN
  if [ -z "${TOKEN}" ]; then
    echo "  No token entered, nothing started."
    exit 1
  fi
  # 600: the token is a credential, so only this user may read it.
  umask 077
  printf '%s\n' "${TOKEN}" > worker-token.txt
  echo "  Saved to worker-token.txt in this folder. Keep the folder private."
fi

node scripts/browser_actor_worker.mjs --token-file worker-token.txt --config worker-config.json
echo "  Worker stopped. Run this file again to restart it."
