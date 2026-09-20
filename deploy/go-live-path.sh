#!/usr/bin/env bash
# Mount ATC POS at https://atcworkspace.com/pos.
# No DNS change and no new certificate: it reuses the existing atcworkspace.com
# vhost and cert. Run as root:
#   sudo bash /home/atc-noc/atc-pos/deploy/go-live-path.sh
#
# Re-runnable. The nginx edit is backed up and rolled back automatically if the
# result fails `nginx -t` — a broken file in sites-enabled would otherwise block
# reloads for atcworkspace.com itself.

set -euo pipefail

VHOST=/etc/nginx/sites-available/default
PROJ=/home/atc-noc/atc-pos
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo"

# ------------------------------------------------------------- 1. nginx route
say "1/3  Adding the /pos route to the atcworkspace.com vhost"

if grep -q 'location ^~ /pos/' "$VHOST"; then
  echo "    Route already present, leaving the vhost alone."
else
  cp -a "$VHOST" "$VHOST.bak.$STAMP"
  echo "    Backup: $VHOST.bak.$STAMP"

  python3 - "$VHOST" <<'PY'
import sys

path = sys.argv[1]
src = open(path).read()

block = '''    # ATC POS (pos-prod compose stack).
    # ^~ so this wins outright over the regex locations above. The trailing
    # slash on proxy_pass strips the /pos prefix, so the container keeps
    # serving at "/" — the browser only ever sees the prefix because the Vite
    # bundle was built with base=/pos/.
    location = /pos { return 301 /pos/; }
    location ^~ /pos/ {
        proxy_pass http://127.0.0.1:8110/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 2m;

        # Several apps share this origin, so without this the pos_session
        # cookie would be sent on every ATC platform request too. Scope it.
        proxy_cookie_path / /pos/;
    }

'''

# Insert immediately before the first catch-all `location / {`, which lives in
# the TLS server block that owns atcworkspace.com.
anchor = '    location / {'
i = src.find(anchor)
if i == -1:
    sys.exit('could not find the catch-all location in ' + path)

open(path, 'w').write(src[:i] + block + src[i:])
print('    Inserted /pos route before the catch-all location.')
PY
fi

if ! nginx -t; then
  [ -f "$VHOST.bak.$STAMP" ] && cp -a "$VHOST.bak.$STAMP" "$VHOST"
  die "nginx -t failed; the vhost was restored from backup and nothing was reloaded"
fi
systemctl reload nginx
echo "    OK: nginx reloaded"

# ------------------------------------------------------------- 2. app running
say "2/3  Ensuring the pos-prod stack is up"
sudo -u atc-noc docker compose -f "$PROJ/docker-compose.prod.yml" up -d

# ------------------------------------------------------------------ 3. verify
say "3/3  Verifying"
sleep 5
p() { printf '    %-46s -> ' "$1"; curl -s -o /dev/null -w '%{http_code}\n' "$1"; }
p https://atcworkspace.com/pos/
p https://atcworkspace.com/pos/login
p https://atcworkspace.com/pos/api/health
p https://atcworkspace.com/
p https://atcworkspace.com/api/health
p https://atcworkspace.com/reviews/
printf '    %-46s -> ' "https://atcworkspace.com/pos (redirect)"
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://atcworkspace.com/pos
printf '    %-46s -> ' "app port is loopback-only"
ss -ltnp 2>/dev/null | grep -q '127.0.0.1:8110' && echo "yes" || echo "CHECK ME"

say "Done. Open https://atcworkspace.com/pos"
