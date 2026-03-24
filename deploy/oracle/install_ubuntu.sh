#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/honki-memo"
REPO_URL="${REPO_URL:-https://github.com/bf-honki/HonTo_Memo.git}"

echo "[1/7] Installing system packages..."
sudo apt-get update
sudo apt-get install -y git build-essential pkg-config libssl-dev nginx ufw curl ca-certificates

echo "[2/7] Installing Rust toolchain if needed..."
if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
fi

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

echo "[3/7] Cloning or updating application code..."
if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$USER:$USER" "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only origin main
fi

echo "[4/7] Preparing environment file..."
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

echo "[5/7] Building Rust server..."
cargo build --release --manifest-path "$APP_DIR/Cargo.toml"

echo "[6/7] Installing systemd service and nginx reverse proxy..."
sudo install -m 0644 "$APP_DIR/systemd/honki-memo.service" /etc/systemd/system/honki-memo.service
sudo install -m 0644 "$APP_DIR/deploy/oracle/honto-memo.nginx.conf" /etc/nginx/sites-available/honto-memo
sudo ln -sf /etc/nginx/sites-available/honto-memo /etc/nginx/sites-enabled/honto-memo
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable honki-memo
sudo systemctl restart honki-memo
sudo nginx -t
sudo systemctl reload nginx

echo "[7/7] Opening firewall..."
sudo ufw allow OpenSSH || true
sudo ufw allow 'Nginx Full' || true

cat <<EOF

Bootstrap complete.

Next steps:
1. Edit $APP_DIR/.env
2. Put your MySQL DATABASE_URL into that file
3. Restart the app:
   sudo systemctl restart honki-memo
4. Check status:
   sudo systemctl status honki-memo --no-pager

EOF
