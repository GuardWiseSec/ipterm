#!/bin/sh
# Checks that link-preview bots and search crawlers get the HTML page and curl/scripts get JSON (or plain
# text for /). No line starts a port check: crawlers get the /port/22 page, and other callers there get
# a 403 (JSON). Then /text and /json after an address or AS number: text or JSON for every client, ANSI colors
# only with ?color=1 and never on JSON, and /8.8.8.8/txt a 404 that points to /8.8.8.8/text.
# Run against `npx wrangler dev` (default) or the live site:
#   sh tools/check_previews.sh
#   sh tools/check_previews.sh https://ipterm.net /8.8.8.8
# The default path is a private address, so the checks make no IPinfo lookups. The /text and /json lines use
# your own address (answered from Cloudflare's edge), non-public ones and AS13335 (RIPEstat only), so they make none.
B=${1:-http://127.0.0.1:8787}
P=${2:-/192.168.1.1}
check() {   # expected-type ua [accept] [path]
  exp=$1; ua=$2; acc=${3:-*/*}; path=${4:-$P}
  ct=$(curl -s -o /dev/null -w '%{content_type}' -A "$ua" -H "Accept: $acc" "$B$path")
  case "$ct" in "$exp"*) r=PASS ;; *) r=FAIL ;; esac
  printf '%s  %-26s %-45.45s -> %s\n' "$r" "$path" "$ua" "$ct"
}
H=text/html J=application/json
check $H 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
check $H 'WhatsApp/2.23.20.0 A'
check $H 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
check $H 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
check $H 'TelegramBot (like TwitterBot)'
check $H 'Twitterbot/1.0'
check $H 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)'
check $H 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'
check $H 'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)'
check $H 'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)'
check $H 'http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)'
check $H 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)'
check $H 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)'
check $H 'Iframely/1.3.1 (+https://iframely.com/docs/about)'
check $H 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' '*/*' /cidr/10.0.0.0/22
check $H 'Twitterbot/1.0' '*/*' /whois
check $H 'Twitterbot/1.0' '*/*' /grade
BING='Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'
GOOG='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
check $H "$BING"
check $H "$BING" '*/*' /port/22
check $H "$BING" '*/*' /cidr/10.0.0.0/22
check $H "$GOOG"
check $H "$GOOG" '*/*' /port/22
check $J "$BING" '*/*' "/port/22?format=json"
check $J "$BING" '*/*' "/api/port?n=22"
check $J 'curl/8.7.1'
check $J 'Wget/1.21.4'
check $J 'python-requests/2.32.3'
check $J 'axios/1.7.7'
check $J 'Go-http-client/2.0'
check $J 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'
check $J 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.22621.4391'
check $J 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' '*/*' "$P?format=json"
check $J 'curl/8.7.1' 'text/html' # CLI wins even if it asks for HTML
check $J 'curl/8.7.1' '*/*' /cidr/10.0.0.0/22
check $J 'curl/8.7.1' '*/*' /grade
check $J 'python-requests/2.32.3' '*/*' /port/22
check text/plain 'curl/8.7.1' '*/*' /
check $H 'Twitterbot/1.0' '*/*' /
printf 'Vary on a JSON answer:  '; curl -s -o /dev/null -D - -A 'curl/8.7.1' "$B$P" | grep -i '^vary'
printf 'Vary on an HTML answer: '; curl -s -o /dev/null -D - -A 'Twitterbot/1.0' "$B$P" | grep -i '^vary'

T=$(mktemp); ESC=$(printf '\033'); trap 'rm -f "$T"' EXIT
fmt() {   # path expected-status expected-type colors (1 = ANSI codes expected, 0 = none) [ua]
  ua=${5:-curl/8.7.1}
  got=$(curl -s -o "$T" -w '%{http_code} %{content_type}' -A "$ua" "$B$1")
  if grep -q "$ESC\[" "$T"; then c=1; else c=0; fi
  case "$got" in "$2 $3"*) [ "$c" = "$4" ] && r=PASS || r=FAIL ;; *) r=FAIL ;; esac
  printf '%s  %-30s %-14.14s -> %s, colors %s\n' "$r" "$1" "$ua" "$got" "$([ "$c" = 1 ] && echo yes || echo no)"
}
says() {  # the last answer must contain this text
  if grep -qF "$1" "$T"; then printf 'PASS  ... and points to %s\n' "$1"; else printf 'FAIL  ... and does not point to %s\n' "$1"; fi
}
ME=$(curl -s -A curl/8.7.1 "$B/")
fmt "/$ME/text" 200 text/plain 0
fmt "/$ME/text?color=1" 200 text/plain 1
fmt "/$ME/text?color=0" 200 text/plain 0
fmt "/$ME/json" 200 $J 0
fmt "/$ME/json?color=1" 200 $J 0
fmt /AS13335/text 200 text/plain 0
fmt /AS13335/text?color=1 200 text/plain 1
fmt /AS13335/json 200 $J 0
fmt /AS13335/json?color=1 200 $J 0
fmt /AS13335/text 200 text/plain 0 "$GOOG"      # bots and browsers get the text too, not the page
fmt /AS13335/json 200 $J 0 'Twitterbot/1.0'
fmt "/AS13335?format=text&color=1" 200 text/plain 1
fmt /AS13335?color=1 200 $J 0                    # JSON by default, never colored
fmt /fe80::1/text 400 text/plain 0               # IPv6 too (not public, so no lookup)
fmt /2001:db8::1/json 400 $J 0
fmt /192.168.1.1/text?color=1 400 text/plain 0   # an error message stays plain
fmt /192.168.1.1/cc 400 text/plain 0             # the /<ip>/<field> route still answers
fmt /8.8.8.8/txt 404 text/plain 0                # txt is not a field (and /dns/<name>/TXT means TXT records)
says /8.8.8.8/text
fmt /AS13335/txt 404 text/plain 0
says /AS13335/text
