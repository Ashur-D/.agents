#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  read -r -p ":: Node.js / npm is not installed. Install it now? [Y/n]: " ans
  ans="${ans:-Y}"
  if [[ "$ans" =~ ^[Yy] ]]; then
    if command -v pacman &>/dev/null; then sudo pacman -S --needed --noconfirm nodejs npm
    elif command -v apt-get &>/dev/null; then sudo apt-get update && sudo apt-get install -y nodejs npm
    elif command -v dnf &>/dev/null; then sudo dnf install -y nodejs npm
    elif command -v brew &>/dev/null; then brew install node
    else echo ":: Could not detect package manager. Please install Node.js 18+ and npm manually." && exit 1
    fi
  else
    echo ":: Node.js and npm are required. Exiting."
    exit 1
  fi
fi

exec node "$SCRIPT_DIR/cli.mjs" "$@"
