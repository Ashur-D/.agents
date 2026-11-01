#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node &>/dev/null; then
  echo ":: Node.js not found. Installing Node.js..."
  if command -v pacman &>/dev/null; then sudo pacman -S --needed --noconfirm nodejs npm
  elif command -v apt-get &>/dev/null; then sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v dnf &>/dev/null; then sudo dnf install -y nodejs npm
  elif command -v brew &>/dev/null; then brew install node
  else echo "Please install Node.js 18+ first." && exit 1
  fi
fi

exec node "$SCRIPT_DIR/cli.mjs" "$@"
