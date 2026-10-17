#!/bin/sh
# Checks /go, the address-bar search: what people type goes to its page, and hostile input never sends anyone
# off the site. Every answer must be a 302 to exactly the path below (always one on this site, made from
# parsed values) or a 400. Run against `npx wrangler dev` (default) or the live site:
#   sh tools/check_go.sh
#   sh tools/check_go.sh https://ipterm.net
# Nothing here makes an upstream lookup: /go only redirects.
B=${1:-http://127.0.0.1:8787}
fails=0
answer() {   # the status and Location for a raw query string
  curl -s -o /dev/null -D - "$B/go?$1" | tr -d '\r' | awk 'NR == 1 { s = $2 } tolower($1) == "location:" { l = " " $2 } END { print s l }'
}
show() {     # the expected answer, what came back, and the input as typed
  case "$2" in "$1") r=PASS ;; *) r=FAIL; fails=$((fails + 1)) ;; esac
  # Any Location that isn't a plain path on this site fails, whatever was expected.
  case "$2" in "302 //"* | "302 /\\"* | "302 "[!/]*) r=FAIL; fails=$((fails + 1)) ;; esac
  printf '%s  %-42.42s -> %s\n' "$r" "$(printf '%s' "$3" | tr '\r\n\t' '???')" "$2"
}
go() {       # expected ("302 /path" or "400") and the input
  enc=$(printf '%s' "$2" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g')
  if [ -n "$2" ] && [ -z "$enc" ]; then fails=$((fails + 1)); echo "FAIL  (couldn't encode the input; run again)"; return; fi
  show "$1" "$(answer "q=$enc")" "$2"
}
raw() {      # expected and a query string sent as it is (for bytes a shell variable can't hold)
  show "$1" "$(answer "$2")" "$2"
}

echo '--- what people type'
go '302 /'                       ''
go '302 /'                       'whoami'
go '302 /8.8.8.8'                '8.8.8.8'
go '302 /8.8.8.8'                ' lookup   8.8.8.8 '
go '302 /2001:4860:4860::8888'   '2001:4860:4860:0:0:0:0:8888'
go '302 /2606:4700:4700::1111'   '[2606:4700:4700::1111]'
go '302 /192.168.1.1'            'http://192.168.1.1/admin'
go '302 /AS13335'                'AS13335'
go '302 /AS15169'                'as 15169'
go '302 /AS13335'                'asn 13335'
go '302 /dns/example.com'        'example.com'
go '302 /dns/example.com'        'Example.COM.'
go '302 /dns/github.com'         'https://GitHub.com/anthropics/claude-code?tab=readme'
go '302 /dns/xn--bcher-kva.de'   'bücher.de'
go '302 /dns/gmail.com/MX'       'dig gmail.com mx'
go '302 /dns/8.8.8.8'            'dig 8.8.8.8'
go '302 /whois/example.com'      'whois example.com'
go '302 /whois/AS13335'          'whois as13335'
go '302 /whois/1.1.1.1'          'whois 1.1.1.1'
go '302 /cidr/10.1.0.0/22'       '10.1.2.3/22'
go '302 /cidr/10.0.0.0/22'       '10.0.0.0-22'
go '302 /cidr/192.168.1.0/24'    '192.168.1.10 255.255.255.0'
go '302 /cidr/2001:db8::/48'     'cidr 2001:db8::/48'
go '302 /mail/gmail.com'         'someone@gmail.com'
go '302 /mail/gmail.com'         'mailto:someone@gmail.com'
go '302 /mail/gmail.com'         'mail gmail.com'
go '302 /mail/outlook.com?dkim=selector1' 'mail outlook.com --dkim selector1'
go '302 /mail/outlook.com?dkim=selector1' 'dkim outlook.com selector1'
go '302 /port/22'                'port 22'
go '302 /port/25565'             'port:25565'
go '302 /port/3389'              '3389/tcp'
go '302 /port/32400'             'port 32400 --info'
go '302 /grade/github.com'       'grade github.com'
go '302 /grade/github.com'       'grade https://GitHub.com/features?x=1'
go '302 /grade/example.com'      'badge example.com'
go '302 /grade/github.com'       'report github.com'
go '302 /grade/github.com'       'reportcard github.com'
go '302 /grade/github.com'       'scorecard github.com'
go '302 /grade'                  'grade'
go '302 /grade'                  'scorecard'
go '302 /dns/_dmarc.gmail.com/TXT' 'dig _dmarc.gmail.com txt'
go '302 /leaktest'               'leaktest'
go '302 /leaktest/r/1bjp'        'leaktest --result 1BJP'
go '302 /api'                    'help'
go '302 /dns'                    'dig'
go '302 /route/1.1.1.0/24'       'route 1.1.1.0/24'
go '302 /route/1.1.1.0/24'       'bgp 1.1.1.1/24'
go '302 /route/1.1.1.0/24'       'rpki 1.1.1.0-24'
go '302 /route/8.8.8.8'          'route 8.8.8.8'
go '302 /route/2606:4700::/32'   'route 2606:4700::/32'
go '302 /cidr/10.0.0.0/8'        'route 10.0.0.0/8'
go '302 /192.168.1.1'            'route 192.168.1.1'
go '302 /cidr'                   'route'
go '302 /192.168.1.1'            '192.168.l.l'
go '302 /192.168.1.1'            '192,168,1,1'
go '302 /192.168.1.1'            '192 168 1 1'
go '302 /192.168.1.1'            'lookup 192.168.l.l'
go '302 /192.168.1.1'            'http://192.168.l.l/admin'
go '302 /10.0.0.1'               '10.0.0.l'
go '302 /192.168.0.1'            '192.168.o.1'
go '302 /dns/route.com'          'route.com'

echo '--- hostile or unreadable: a 400, or a page on this site'
go '400'                         '//evil.com'
go '400'                         '///evil.com'
go '400'                         '/\evil.com'
go '400'                         '\\evil.com'
go '400'                         '\/\/evil.com'
go '400'                         '%2F%2Fevil.com'
go '400'                         'http:evil.com'
go '400'                         'https:/\evil.com'
go '400'                         'javascript:alert(1)'
go '400'                         'JaVaScRiPt:alert(document.domain)'
go '400'                         'data:text/html,<script>alert(1)</script>'
go '400'                         'ftp://evil.com'
go '400'                         '@evil.com'
go '400'                         'AS13335/../evil'
go '400'                         '1.1.1.1/../../evil.com'
go '400'                         '8.8.8.8 https://evil.com'
go '400'                         '8.8.8.8%0d%0aSet-Cookie:x=1'
go '400'                         "$(printf '8.8.8.8\r\nLocation: https://evil.com')"
go '400'                         "$(printf 'example.com\tevil.com')"
go '400'                         "$(printf 'evil.com\342\200\256moc')"
go '400'                         "$(printf 'example.com\342\200\213')"
go '400'                         'mail example.com --dkim ../../x'
go '400'                         'mail example.com --dkim=a%0d%0ab'
go '400'                         'dig example.com __proto__'
go '400'                         'dig example.com constructor'
go '400'                         'port 0'
go '400'                         'port 65536'
go '400'                         'AS0'
go '400'                         'AS4294967296'
go '400'                         '<script>alert(1)</script>'
go '400'                         '"><img src=x onerror=alert(1)>'
go '400'                         "$(printf 'a%.0s' $(seq 1 301)).com"
go '400'                         '13335'
go '400'                         '10.0.0.13l'
go '400'                         '8.8.8.l'
go '400'                         'route //evil.com'
go '400'                         'route https://evil.com'
go '400'                         'route javascript:alert(1)'
go '400'                         'route ../../x'
go '400'                         'route 1.1.1.0/24 x'
go '400'                         'leaktest --result ../x'
go '400'                         'leaktest --result //evil.com'
go '400'                         'leaktest --result 1bjq'
go '400'                         'leaktest 1bjp'
go '400'                         'grade 8.8.8.8'
go '400'                         'grade //evil.com'
go '400'                         'grade ../../x'
go '400'                         'grade javascript:alert(1)'
go '400'                         'grade github.com x'
go '400'                         'grade _dmarc.gmail.com'
go '400'                         'scorecard selector1._domainkey.outlook.com'
go '302 /dns/evil.com'           'https://evil.com'
go '302 /dns/evil.com'           'https://evil.com\@ipterm.net'
go '302 /8.8.8.8'                'http://evil.com@8.8.8.8/'
go '302 /dns/evil.com'           'evil.com/%2F%2Fattacker'
go '302 /dns/example.com'        'dig example.com/../../evil'
go '302 /mail/evil.com'          'a@b@evil.com'
raw '400'                        'q=8.8.8.8%00'
raw '400'                        'q=%E2%80%AEevil.com'
raw '400'                        'q=%C0%AF%C0%AFevil.com'
raw '302 /8.8.8.8'               'q=8.8.8.8&q=//evil.com'

echo "--- $fails failed"
[ "$fails" -eq 0 ]
