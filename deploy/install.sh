#!/usr/bin/env bash
# Installs or updates the liquidator on a Debian/Ubuntu server. Idempotent:
# run it for the first install and again after every `git pull`.
#
#   sudo bash /opt/liquidator/app/deploy/install.sh
#
# It does NOT start the bot and does NOT touch .env or the key: those are yours.
set -euo pipefail

BASE=/opt/liquidator
APP=$BASE/app
SVC=/etc/systemd/system/liquidator.service

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -d "$APP/.git" ] || { echo "clone the repository into $APP first"; exit 1; }

echo "== system packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git >/dev/null 2>&1

echo "== node 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi
# the lockfile is written by npm 12; older npm rejects it in `npm ci`
npm --version | grep -q '^12\.' || npm install -g --silent npm@12
echo "node $(node -v), npm $(npm -v)"

echo "== service user"
id liquidator >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin liquidator
chown -R liquidator:liquidator "$BASE"
chmod 700 "$BASE"

# updates are pulled as root into a checkout the service user owns; without
# this git refuses with "dubious ownership"
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP" \
  || git config --system --add safe.directory "$APP"

echo "== dependencies and build"
cd "$APP"
# runuser ships with util-linux; minimal images have no sudo
as_bot() { runuser -u liquidator -- env HOME="$BASE" "$@"; }
as_bot npm ci --no-audit --no-fund
as_bot npm run build
[ -f "$APP/dist/src/index.js" ] || { echo "build produced no dist/src/index.js"; exit 1; }

echo "== secrets"
for f in "$BASE/.env" "$BASE/liquidator.json"; do
  if [ -f "$f" ]; then chown liquidator:liquidator "$f"; chmod 600 "$f"; echo "ok   $f";
  else echo "MISSING $f"; fi
done
if [ -f "$BASE/.env" ] && grep -qE '^[A-Z_]+=.*[[:space:]]#' "$BASE/.env"; then
  echo "WARNING: $BASE/.env has a trailing comment on a setting; systemd keeps it as part of the value"
fi

echo "== systemd unit"
if [ -d /run/systemd/system ]; then
  install -m 644 "$APP/deploy/liquidator.service" "$SVC"
  systemctl daemon-reload
  systemctl enable liquidator >/dev/null
  echo "installed. start or apply an update with: sudo systemctl restart liquidator"
else
  echo "systemd not running here; unit not installed"
fi
