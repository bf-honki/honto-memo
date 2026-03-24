#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/honki-memo"
BRANCH="${BRANCH:-main}"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "App directory $APP_DIR is not a git repository."
  exit 1
fi

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cargo build --release
sudo systemctl restart honki-memo
sudo systemctl status honki-memo --no-pager || true
