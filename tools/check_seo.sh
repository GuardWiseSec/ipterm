#!/bin/sh
# Checks the search-engine groundwork: router-address typos redirect (301) to the exact address in
# SITEMAP_PATHS and nowhere else, hostile paths never redirect off the list, pages for non-public addresses
# are noindex unless curated, pages for networks whose holder may be a private person are noindex and left out
# of the ASN sitemap (and so are the whois and /cidr pages that name such a holder, while other ASN pages list
# it as an upstream by number only), and the sitemap index and its files are there with the expected URL counts.
# Run against `npx wrangler dev` (default) or the live site:
#   sh tools/check_seo.sh
#   sh tools/check_seo.sh https://ipterm.net
#   ROUTES=1 sh tools/check_seo.sh      # also the /cidr routing section (asks RIPEstat; no IPinfo)
# Nothing here makes an IPinfo lookup: every address page is non-public, the ASN and /cidr pages ask RIPEstat
# only, whois pages ask RDAP only, and the sitemap is generated in the Worker.
# (Git Bash on Windows: run with MSYS_NO_PATHCONV=1 so paths like /192.168.l.l aren't rewritten.)
B=${1:-http://127.0.0.1:8787}
UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; }

# path expected-status expected-location ('' = no Location header)
redir() {
  out=$(curl -s -o /dev/null -A "$UA" -w '%{http_code} %header{location}' "$B$1")
  code=${out%% *}; loc=${out#* }; [ "$loc" = "$out" ] && loc=''
  if [ "$code" = "$2" ] && [ "$loc" = "$3" ]; then ok "$1 -> $code ${3:-(no redirect)}"; else no "$1 -> $code [$loc], expected $2 [$3]"; fi
}
echo '-- typos of curated router addresses: 301 to the address in the list'
redir '/192.168.l.l' 301 /192.168.1.1
redir '/192.168.1.l' 301 /192.168.1.1
redir '/192,168,1,1' 301 /192.168.1.1
redir '/192.168.0.l' 301 /192.168.0.1
redir '/10.0.0.l' 301 /10.0.0.1
redir '/l92.168.1.1' 301 /192.168.1.1
redir '/192.168.o.1' 301 /192.168.0.1
redir '/192.168.001.001' 301 /192.168.1.1
redir '/192.168.1.1.' 301 /192.168.1.1
redir '/192%20168%201%201' 301 /192.168.1.1
redir '/192;168;1;1' 301 /192.168.1.1
redir '/192.168.l.254' 301 /192.168.1.254
redir '/10.0.0.l38' 301 /10.0.0.138
redir '/l.l.l.l' 301 /1.1.1.1
redir '/192.168.l.l?next=//evil.example' 301 /192.168.1.1
echo '-- valid addresses: no redirect'
redir '/192.168.1.1' 200 ''
redir '/10.0.0.1' 200 ''
redir '/192.168.5.5' 200 ''
echo '-- typos of addresses that are not curated: the 404 page with a "did you mean", no redirect'
redir '/192.168.5.l' 404 ''
redir '/10.0.0.13l' 404 ''
echo '-- hostile paths: never a redirect off the list'
for p in '//evil.example' '/%2F%2Fevil.example' '/%5Cevil.example' '/192.168.l.l%0d%0aSet-Cookie:x=1' \
  '/192.168.l.l%2F..%2F..%2Fevil.example' '/192.168.1.1@evil.example' '/javascript:alert(1)' '/http://192.168.l.l' \
  '/192.168.l.l%00' '/%E2%80%AE192.168.l.l' '/1.1.1.1.1' '/192.168.256.1' '/192.168.1.l/admin'; do
  loc=$(curl -s -o /dev/null -A "$UA" -w '%header{location}' "$B$p")
  case "$loc" in ''|/dns/*) ok "$p -> ${loc:-(no redirect)}" ;; *) no "$p -> $loc" ;; esac
done

# path: 1 if the page must carry noindex, 0 if it must not
robots() {
  meta=$(curl -s -A "$UA" "$B$1" | grep -o '<meta name="robots" content="[^"]*">')
  case "$2$meta" in 1*noindex*|0) ok "$1 ${meta:-(indexable)}" ;; *) no "$1 ${meta:-(indexable)}, expected $([ "$2" = 1 ] && echo noindex || echo indexable)" ;; esac
}
echo '-- noindex for non-public addresses outside SITEMAP_PATHS'
robots /192.168.5.5 1
robots /10.20.30.40 1
robots /100.64.1.1 1
robots /203.0.113.5 1
robots /fe80::1 1
robots /192.168.1.1 0
robots /10.0.0.1 0
robots /127.0.0.1 0
robots /169.254.1.1 0
echo '-- noindex for networks whose holder may be a private person (src/holder-heuristic.js; RIPEstat only)'
robots /AS35100 1
robots /AS50053 1
robots /AS13335 0
robots /AS15169 0
robots /AS3356 0
robots /AS5617 0     # a large business whose name has a spelled-out legal form (Spolka Akcyjna)
echo '-- ... and whois and /cidr pages that name one (RDAP and RIPEstat only)'
robots /whois/AS35100 1
robots /whois/AS50053 1
robots /whois/2.26.133.0 1      # an address block of AS50053, registered to its holder
robots /whois/AS13335 0
robots /whois/AS15169 0
robots /whois/AS3356 0
robots /whois/1.1.1.1 0
robots /whois/8.8.8.8 0
# Each network's largest prefix (the first in its JSON), whose routing section names the network's holder.
for a in AS35100:1 AS50053:1 AS13335:0 AS15169:0 AS3356:0; do
  px=$(curl -s -A curl/8 "$B/${a%:*}?format=json" | grep -o '"[0-9.]*/[0-9]*"' | head -1 | tr -d '"')
  if [ -n "$px" ]; then robots "/cidr/$px" "${a#*:}"; else no "${a%:*}: no prefix in its JSON"; fi
done
robots /cidr/1.1.1.0/24 0
robots /cidr/8.8.8.0/24 0
echo '-- an indexed ASN page lists an upstream that may be a private person by AS number only'
# AS203761 (an organization) has AS28748 (held by a person) as its upstream. The name comes from the JSON, which
# keeps it, so it isn't written here; the page must link the upstream but not name it, in its HTML or its data.
up=$(curl -s -A curl/8 "$B/AS203761?format=json" | grep -A1 '"asn": "AS28748"' | sed -n 's/.*"name": "\(.*\)".*/\1/p')
if [ -z "$up" ]; then
  printf 'SKIP  AS28748 is no longer a named upstream of AS203761 in the JSON: pick another pair\n'
else
  ok '/AS203761 JSON names its upstream AS28748'
  robots /AS203761 0
  page=$(curl -s -A "$UA" "$B/AS203761")
  case "$page" in *'href="/AS28748"'*) ok '/AS203761 links AS28748' ;; *) no '/AS203761 does not link AS28748' ;; esac
  case "$page" in *"$up"*) no '/AS203761 names AS28748, whose holder may be a person' ;; *) ok '/AS203761 lists AS28748 without its name' ;; esac
fi

echo '-- sitemap index and files'
idx=$(curl -s "$B/sitemap.xml")
case "$idx" in *'<sitemapindex'*) ok "/sitemap.xml is a sitemap index" ;; *) no "/sitemap.xml is not a sitemap index" ;; esac
asns=''
for f in $(printf '%s\n' "$idx" | grep -o '<loc>[^<]*' | sed 's/<loc>//; s#^[a-z]*://[^/]*##'); do
  body=$(curl -s "$B$f"); n=$(printf '%s\n' "$body" | grep -c '<url>'); u=$(printf '%s\n' "$body" | grep -o '<loc>[^<]*' | sort -u | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ] && [ "$n" -le 50000 ] && [ "$n" = "$u" ]; then ok "$f: $n URLs, all different"; else no "$f: $n URLs ($u different)"; fi
  case "$f" in /sitemap-asn-*) printf '%s\n' "$body" | grep -q '<loc>[^<]*/AS[0-9]*</loc>' && ok "$f lists ASN pages" || no "$f lists no ASN pages"
    asns="$asns $(printf '%s\n' "$body" | grep -o '/AS[0-9]*</loc>' | tr '\n' ' ')" ;; esac
done
printf '%s\n' "$idx" | grep -q 'sitemap-asn-1.xml' && ok 'the index lists sitemap-asn-1.xml' || no 'the index lists no ASN sitemap'
# The same rules decide both: these two are large enough for the ASN sitemap, but left out, and their pages are noindex.
for a in AS35100 AS50053; do case "$asns" in *"/$a</loc>"*) no "$a is in an ASN sitemap, but its page is noindex" ;; *) ok "$a (noindex) is in no ASN sitemap" ;; esac; done
for a in AS13335 AS15169 AS3356 AS5617; do case "$asns" in *"/$a</loc>"*) ok "$a is in an ASN sitemap" ;; *) no "$a is in no ASN sitemap" ;; esac; done
curl -s "$B/sitemap-pages.xml" | grep -q '<loc>[a-z]*://[^/]*/AS[0-9]*</loc>' && no 'sitemap-pages.xml still lists ASN pages' || ok 'sitemap-pages.xml leaves ASN pages to the ASN files'

if [ -n "$ROUTES" ]; then
  echo '-- routing on /cidr pages (RIPEstat)'
  for p in /cidr/1.1.1.0/24 /cidr/8.8.8.0/24; do
    curl -s -A "$UA" "$B$p" | grep -q 'is announced in BGP by AS' && ok "$p has a routing section" || no "$p has no routing section"
  done
  curl -s -A curl/8 "$B/route/8.8.8.8" | grep -q '"prefix": "8.8.8.0/24"' && ok '/route/8.8.8.8 is routed in 8.8.8.0/24' || no '/route/8.8.8.8'
  curl -s -A "$UA" "$B/cidr/10.0.0.0/22" | grep -q 'announced in BGP' && no '/cidr/10.0.0.0/22 has a routing section' || ok '/cidr/10.0.0.0/22 (private) has no routing section'
  code=$(curl -s -o /dev/null -w '%{http_code}' -A curl/8 "$B/route/192.168.1.0/24"); [ "$code" = 400 ] && ok '/route/192.168.1.0/24 is refused (400)' || no "/route/192.168.1.0/24 -> $code"
fi
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
