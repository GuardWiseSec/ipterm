#!/bin/sh
# Installs or updates ipterm's DNS leak test responder on Debian 12 or 13, or Ubuntu 24.04+. Run it as root,
# from this directory, with the server's public IPv4 address:
#   sh setup.sh 203.0.113.10
# Running it again (say, after copying newer files) updates the program and settings and keeps the key.
# Another zone or API host name: DNSLEAK_ZONE=dl.example.net DNSLEAK_API_HOST=dlapi.example.net sh setup.sh <ip>
set -eu

IP=${1:-}
ZONE=${DNSLEAK_ZONE:-dl.ipterm.net}
API_HOST=${DNSLEAK_API_HOST:-dlapi.ipterm.net}
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "setup: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it as root: sudo sh setup.sh $IP"
echo "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || die "usage: sh setup.sh <this server's public IPv4 address>"
for name in "$ZONE" "$API_HOST"; do
  echo "$name" | grep -Eq '^[a-z0-9-]+(\.[a-z0-9-]+)+$' || die "not a host name: $name"
done
command -v apt-get >/dev/null || die "this script is for Debian or Ubuntu"
for f in server.js dns.js store.js package.json dnsleak.service Caddyfile; do
  [ -f "$HERE/$f" ] || die "missing $f: run this from the dnsleak-server directory"
done

echo "== 1. Node.js and Caddy (from the distribution)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nodejs caddy ca-certificates
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || die "Node.js $major is too old (18 or newer needed): use Debian 13 (or 12) or Ubuntu 24.04"

echo "== 2. The program, in /opt/dnsleak"
install -d -m 0755 /opt/dnsleak
install -m 0644 "$HERE/server.js" "$HERE/dns.js" "$HERE/store.js" "$HERE/package.json" /opt/dnsleak/

echo "== 3. Settings, in /etc/dnsleak/dnsleak.env (readable by root only)"
ENV=/etc/dnsleak/dnsleak.env
install -d -m 0700 /etc/dnsleak
KEY=$(sed -n 's/^DNSLEAK_KEY=//p' "$ENV" 2>/dev/null || true)
[ -n "$KEY" ] || KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
# DNS listens on the public address itself, so it can't clash with a local resolver on 127.0.0.53:53.
if ip -4 -o addr show | grep -q " $IP/"; then
  BIND=$IP
else
  BIND=0.0.0.0
  echo "setup: $IP isn't on any network interface here (behind NAT?), so DNS listens on every address"
fi
umask 077
cat > "$ENV" <<EOF
# ipterm DNS leak test responder. Written by setup.sh, which keeps the key when it runs again.
DNSLEAK_ZONE=$ZONE
DNSLEAK_NS=ns1.$ZONE
DNSLEAK_NS_IPV4=$IP
DNSLEAK_DNS_BIND=$BIND
DNSLEAK_API_BIND=127.0.0.1
DNSLEAK_API_PORT=8053
DNSLEAK_KEY=$KEY
EOF
umask 022

echo "== 4. The service (dnsleak)"
install -m 0644 "$HERE/dnsleak.service" /etc/systemd/system/dnsleak.service
systemctl daemon-reload
systemctl enable dnsleak >/dev/null 2>&1
systemctl restart dnsleak

echo "== 5. HTTPS for the API (Caddy, certificate from Let's Encrypt)"
sed "s/dlapi\.ipterm\.net/$API_HOST/" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

echo "== 6. This machine's firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 53/udp && ufw allow 53/tcp && ufw allow 443/tcp
else
  echo "ufw isn't active: nothing to change here (the provider's firewall is set up separately)"
fi

sleep 2
systemctl is-active --quiet dnsleak || { journalctl -u dnsleak -n 20 --no-pager; die "dnsleak didn't start (its log is above)"; }
echo
echo "Done. dnsleak answers for $ZONE on $BIND port 53; the API is https://$API_HOST"
echo "The shared key, for: npx wrangler secret put DNSLEAK_KEY"
echo
echo "  $KEY"
echo
echo "(It is also in $ENV.) Next: the checks in README.md, step f."
