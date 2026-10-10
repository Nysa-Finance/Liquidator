#!/usr/bin/env bash
# Read-only security check of the server running the liquidator (Docker
# deployment). Changes nothing; prints OK / WARN / FAIL per item.
#
#   sudo bash /opt/liquidator/app/deploy/check-security.sh
set -u
BASE=/opt/liquidator
APP=$BASE/app
fails=0
warns=0
ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
info() { printf '      %s\n' "$*"; }
envval() { grep -m1 "^$1=" "$BASE/.env" 2>/dev/null | cut -d= -f2-; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

echo "== SSH"
cfg=$(sshd -T 2>/dev/null)
if [ -z "$cfg" ]; then
  warn "could not read the effective sshd configuration (sshd -T)"
else
  for kv in "passwordauthentication no" "kbdinteractiveauthentication no" "permitrootlogin no"; do
    if grep -qx "$kv" <<<"$cfg"; then ok "sshd $kv"
    else fail "sshd: want '$kv', have '$(grep "^${kv%% *} " <<<"$cfg")'"; fi
  done
fi
login=${SUDO_USER:-ubuntu}
case "$(passwd -S "$login" 2>/dev/null | awk '{print $2}')" in
  P) ok "$login has a password for the OVH emergency console" ;;
  *) warn "$login has no password: the OVH KVM console could not log you in (sudo passwd $login)" ;;
esac

echo "== Firewall and open ports"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ufw status verbose | grep -q 'deny (incoming)'; then ok "ufw active, incoming denied by default"
  else fail "ufw active but incoming traffic is not denied by default"; fi
  ufw status | sed -n '/^--/,$p' | tail -n +2 | while read -r r; do [ -n "$r" ] && info "allowed: $r"; done
else
  fail "ufw is not active"
fi
# Anything listening on a non-loopback address, TCP. Docker-published ports
# show up here too, as docker-proxy.
ss -Htlnp 2>/dev/null | awk '{print $4, $6}' | while read -r addr proc; do
  case "$addr" in 127.*|\[::1\]:*|::1:*) continue ;; esac
  port=${addr##*:}
  if [ "$port" = 22 ]; then [ -n "${seen22:-}" ] && continue; seen22=1; info "port 22 (ssh) reachable from the internet; Cloudflare Access would hide it"
  else echo "FAIL  port $port listening on $addr ($proc)"; fi
done
n=$(ss -Htln 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | grep -vc ':22$')
[ "$n" -eq 0 ] && ok "no TCP port open to the internet besides ssh" || fails=$((fails + n))

echo "== Updates"
if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then ok "automatic security updates on"
else fail "automatic security updates off (sudo dpkg-reconfigure -plow unattended-upgrades)"; fi
[ -f /var/run/reboot-required ] && warn "an update is waiting for a reboot (sudo reboot; the bot restarts by itself)"

echo "== Docker"
if ! command -v docker >/dev/null; then
  fail "docker not found"
else
  pub=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E '(0\.0\.0\.0|\[::\]|:::)[0-9]+->')
  if [ -z "$pub" ]; then ok "no container publishes a port to the internet"
  else while read -r l; do fail "published to the internet: $l"; done <<<"$pub"; fi
  members=$(getent group docker | cut -d: -f4)
  [ -z "$members" ] && ok "nobody in the docker group" || warn "in the docker group (equivalent to root): $members"

  if [ "$(docker inspect -f '{{.State.Status}}' liquidator 2>/dev/null)" = running ]; then
    ok "liquidator container running"
    ins() { docker inspect -f "$1" liquidator; }
    [ "$(ins '{{.Config.User}}')" = "10001:10001" ] && ok "runs as uid 10001" || fail "runs as '$(ins '{{.Config.User}}')', not 10001:10001"
    [ "$(ins '{{.HostConfig.ReadonlyRootfs}}')" = true ] && ok "read-only filesystem" || fail "filesystem is writable"
    ins '{{.HostConfig.SecurityOpt}}' | grep -q no-new-privileges && ok "no-new-privileges" || fail "no-new-privileges missing"
    ins '{{.HostConfig.CapDrop}}' | grep -q ALL && ok "all capabilities dropped" || fail "capabilities not dropped"
    [ "$(ins '{{.HostConfig.RestartPolicy.Name}}')" = always ] && ok "restarts always" || warn "restart policy is not 'always'"
    case "$(ins '{{json .HostConfig.PortBindings}}')" in {}|null) ok "liquidator publishes no ports" ;; *) fail "liquidator publishes ports" ;; esac
    found=$(docker run --rm --entrypoint sh "$(ins '{{.Config.Image}}')" -c \
      'find /app /root /home -path /app/node_modules -prune -o \( -name .env -o -name liquidator.json \) -print 2>/dev/null')
    [ -z "$found" ] && ok "image holds neither .env nor the key" || fail "secret files baked into the image: $found"
    info "DRY_RUN=$(docker exec liquidator printenv DRY_RUN 2>/dev/null || echo '(unset, so true)')"
  else
    fail "liquidator container is not running (liq up -d)"
  fi
fi

echo "== Secrets"
mode() { # path, wanted mode, wanted uid:gid
  if [ ! -e "$1" ]; then fail "$1 missing"; return; fi
  local m o; m=$(stat -c '%a' "$1"); o=$(stat -c '%u:%g' "$1")
  if [ "$m" = "$2" ] && [ "$o" = "$3" ]; then ok "$1 mode $m owner $o"
  else fail "$1 is mode $m owner $o, want mode $2 owner $3"; fi
}
mode "$BASE" 700 0:0
mode "$BASE/.env" 600 0:0
mode "$BASE/liquidator.json" 400 10001:10001
stray=$(find "$APP" -path "$APP/.git" -prune -o -path "$APP/node_modules" -prune -o \( -name .env -o -name liquidator.json \) -print 2>/dev/null)
[ -z "$stray" ] && ok "no .env or key inside the git checkout" || fail "secret files inside the checkout: $stray"
url=$(git -C "$APP" remote get-url origin 2>/dev/null)
case "$url" in
  git@*) ok "repository pulled over ssh (deploy key)" ;;
  https://*@*) fail "a token is embedded in the git remote URL" ;;
  *) info "git remote: $url" ;;
esac
[ -z "$(git -C "$APP" status --porcelain 2>/dev/null)" ] && ok "checkout has no local edits" || warn "checkout has local edits (git -C $APP status)"

echo "== Logs"
if docker inspect liquidator >/dev/null 2>&1; then
  logs=$(docker logs liquidator 2>&1)
  leaked=0
  for name in RPC_PRIMARY RPC_SECONDARY TELEGRAM_BOT_TOKEN; do
    v=$(envval "$name")
    case "$name" in RPC_*) v=${v#*://}; v=${v#*/} ;; esac # the part after the host carries the key
    [ ${#v} -ge 12 ] && grep -qF -- "$v" <<<"$logs" && { fail "$name secret appears in the container logs"; leaked=1; }
  done
  [ "$leaked" = 0 ] && ok "no RPC key or Telegram token in the logs"
fi

echo
echo "To check by hand:"
info "GitHub, repo Settings > Deploy keys: the key has NO write access"
info "Mac: FileVault on; ~/.liquidator/liquidator.json not in iCloud or any backup you share"
info "wallet holds only SOL for fees; profits swept to your own wallet"
echo
echo "$fails FAIL, $warns WARN"
[ "$fails" -eq 0 ]
