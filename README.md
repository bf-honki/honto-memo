# HonKi Memo

Rust + MySQL remote memo app.
Different devices can open the same site, create notes, and save them straight into MySQL.

## Why the old site timed out

If the old site was running on your laptop, the service disappeared the moment:

- the laptop went to sleep or was turned off
- the school network blocked direct inbound access
- the public IP changed or port forwarding broke

This version is meant to be deployed on an always-on server, so your laptop no longer needs to stay awake.

## Stack

- Frontend: plain HTML/CSS/JS
- Backend: Rust + Axum
- Database: MySQL
- Static hosting: served by the Rust server itself

## Features

- shared notes across devices
- automatic MySQL save
- image placement inside notes
- local temporary cache when the network is unstable
- retry sync when the internet comes back
- if MySQL save fails on the server, a `.txt` backup is written into `failed_notes/`

## API

- `GET /api/health`
- `GET /api/notes`
- `PUT /api/notes/:id`
- `DELETE /api/notes/:id`

## Environment variables

Copy `.env.example` to `.env` and edit it:

```env
DATABASE_URL=mysql://username:password@127.0.0.1:3306/honki_memo
PORT=3000
RUST_LOG=info
```

## Local run

1. Create a MySQL database named `honki_memo`.
2. Set `DATABASE_URL` in `.env`.
3. Start the app:

```powershell
cargo run
```

Then open `http://127.0.0.1:3000`.

If MySQL is unavailable, the server still starts and writes note backups into `failed_notes/`.

## Push to GitHub

```powershell
git init
git add .
git commit -m "Build Rust + MySQL remote memo app"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

## Recommended free deployment

For the most stable free setup:

1. Put this code on GitHub.
2. Create a free MySQL instance.
3. Create a free always-on VM.
4. Pull this repo on the VM and run the Rust server there.

That way:

- GitHub stores the code
- the VM stays online
- MySQL stays outside your laptop
- failed DB writes still leave a txt backup on the server

## Practical provider combo

Recommended pair:

- Oracle Cloud Always Free VM for the Rust server
- Aiven for MySQL free tier for the database

Why this combo is better than running from your notebook:

- the server keeps running after you close your laptop
- school Wi-Fi no longer needs to reach your personal machine directly
- MySQL is managed outside the app server

## Ubuntu VM deploy example

On the server:

```bash
sudo apt update
sudo apt install -y git build-essential pkg-config libssl-dev
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
git clone https://github.com/YOUR_NAME/YOUR_REPO.git /opt/honki-memo
cd /opt/honki-memo
cp .env.example .env
nano .env
cargo build --release
sudo cp systemd/honki-memo.service /etc/systemd/system/honki-memo.service
sudo systemctl daemon-reload
sudo systemctl enable honki-memo
sudo systemctl start honki-memo
sudo systemctl status honki-memo
```

Open port `3000`, or better, reverse proxy it with Nginx on ports `80/443`.

## Notes about GitHub Pages

GitHub Pages is good for static files only.
Because this app needs a Rust server and MySQL writes, GitHub Pages alone is not enough for the final deployment.

## Docker option

You can also build a container:

```bash
docker build -t honki-memo .
docker run --env-file .env -p 3000:3000 honki-memo
```
