/* ipterm port check: what common ports are used for and why they may be closed.
   One source of truth for the page (loaded as /ports.js, exposes window.IPTERM_PORTS) and the Worker
   (imported by src/worker.js for the /port/<n> pages and the check's answer). No dependencies.
   proto: 'tcp', 'udp' or 'tcp+udp'. The check itself can only test TCP. */
(function (root) {
  // [port, name, proto, what it is used for, why it may be closed / how to open it, caution (optional)]
  const LIST = [
    [21, 'FTP', 'tcp', 'FTP file transfers: the control connection of an FTP server, found on NAS boxes and older file-sharing setups.',
      'FTP also needs a range of passive-mode data ports forwarded, and many routers only handle it with their FTP helper turned on. Check that the server is running and that the forward points at its local IP.',
      'FTP sends passwords unencrypted. SFTP (over SSH, port 22) or FTPS is safer.'],
    [22, 'SSH', 'tcp', 'SSH: remote command-line logins and SFTP file transfers to a Linux machine, a Raspberry Pi, a NAS or a router.',
      'Check that sshd is running and listening on all addresses (not just 127.0.0.1), that the device firewall (ufw, firewalld) allows 22, and that the router forwards 22 to the device. Some providers block inbound 22; forwarding a high outside port such as 2222 to 22 inside gets around it.',
      'Bots try passwords on every open port 22 within minutes: allow key logins only (PasswordAuthentication no).'],
    [23, 'Telnet', 'tcp', 'Telnet: unencrypted remote logins, mostly on old routers, switches and IoT devices.',
      'Usually closed on purpose, which is right. If a device needs it, reach it from your own network or over a VPN.',
      'Telnet sends everything, passwords included, in plain text, and open Telnet ports are a favorite of botnets such as Mirai. Keep it closed to the internet.'],
    [25, 'SMTP', 'tcp', 'SMTP: mail servers delivering email to each other.',
      'Most home internet providers block port 25 to stop spam, so self-hosted mail usually needs a business line or an outgoing relay service.'],
    [53, 'DNS', 'tcp+udp', 'DNS: a name server or resolver such as Pi-hole, AdGuard Home or BIND. Lookups use UDP; TCP carries large answers and zone transfers.',
      'A home DNS server such as Pi-hole should only answer your own network, so closed is the right result. Only open it if you run the authoritative name server for a domain.',
      'An open resolver on port 53 gets abused for DDoS amplification attacks.'],
    [80, 'HTTP', 'tcp', "HTTP: web servers, and Let's Encrypt's HTTP-01 check, which has to reach port 80 to issue a certificate.",
      "Many home providers block inbound 80. The router's own admin page may be using it too: turn off its remote management or forward a different outside port. Check that the web server is running and the device firewall allows it."],
    [110, 'POP3', 'tcp', 'POP3: downloading email from a mail server, unencrypted (995 is POP3 over TLS).',
      "Only a mail server you host yourself needs it open. Mail apps connect out to your provider and don't need any port open at home."],
    [143, 'IMAP', 'tcp', 'IMAP: reading email on a mail server, unencrypted or upgraded with STARTTLS (993 is IMAP over TLS).',
      "Only a self-hosted mail server needs it open; reading mail from your provider doesn't."],
    [443, 'HTTPS', 'tcp', 'HTTPS: secure web servers, reverse proxies (Nginx Proxy Manager, Caddy, Traefik) and many self-hosted apps.',
      "Check that the web server or reverse proxy listens on 443, that the router forwards 443 to it, and that the router's own remote-management page isn't holding the port. Some providers block inbound 443 on home plans."],
    [445, 'SMB', 'tcp', 'SMB: Windows file sharing and network drives (also Samba on Linux and NAS boxes).',
      'Closed is the right result: most providers block 445, and it should never be forwarded. To reach your files from outside, use a VPN such as WireGuard or Tailscale.',
      'Open SMB ports are how WannaCry spread. Never open 445 to the internet.'],
    [554, 'RTSP', 'tcp', 'RTSP: live video streams from IP security cameras and video recorders (NVRs).',
      "Check that RTSP is turned on in the camera's settings and that the forward points at the camera or recorder. Most camera apps work through the maker's cloud service with no open port at all.",
      'Exposed cameras are routinely found and watched by strangers. Use a strong password, or better, a VPN.'],
    [587, 'SMTP submission', 'tcp', 'Mail submission: mail apps sending outgoing email through a mail server, with a login and STARTTLS.',
      "Only a self-hosted mail server needs it open. Unlike port 25, Cloudflare and most providers don't block it."],
    [993, 'IMAPS', 'tcp', 'IMAP over TLS: reading email from a mail server securely.',
      "Only a mail server you host yourself (Mailcow, Mail-in-a-Box) needs it open. Mail apps don't need it open at home."],
    [1194, 'OpenVPN', 'udp', 'OpenVPN servers, on UDP 1194 by default (PiVPN, many routers and NAS boxes).',
      'Forward UDP 1194 to the VPN server. OpenVPN can also run over TCP (proto tcp-server); only then can this check test it.'],
    [1723, 'PPTP', 'tcp', 'PPTP: an old VPN protocol (TCP 1723 plus GRE packets).',
      'Even with 1723 open, PPTP needs GRE passthrough on the router as well.',
      "PPTP's encryption is broken. WireGuard or OpenVPN are the modern choice."],
    [1883, 'MQTT', 'tcp', 'MQTT: messaging for smart-home devices and sensors (Mosquitto, Home Assistant, Zigbee2MQTT). 8883 is MQTT over TLS.',
      'Usually only needed inside your network. If outside devices must reach the broker, use 8883 with TLS and passwords.',
      'An open broker without a password lets anyone read and control your devices.'],
    [2456, 'Valheim', 'udp', 'Valheim dedicated servers (UDP 2456 to 2458).',
      "Forward UDP 2456-2458 to the server. With crossplay turned on, players can join through Steam's relay without any open port."],
    [3074, 'Xbox network', 'tcp+udp', 'Xbox network (Xbox Live) multiplayer and party chat, over TCP and UDP. Call of Duty uses it on PC and consoles too.',
      "A Strict or Moderate NAT type usually means UPnP is off on the router, or the console sits behind two routers (double NAT). Turn on UPnP, or forward 3074 TCP and UDP to the console's local IP."],
    [3306, 'MySQL', 'tcp', 'MySQL and MariaDB database servers.',
      'Closed is usually right: apps should reach the database on the same server or over an SSH tunnel. MySQL listens only on 127.0.0.1 unless bind-address is changed.',
      'Open databases are tried for weak passwords around the clock.'],
    [3389, 'Remote Desktop (RDP)', 'tcp', 'Remote Desktop (RDP): controlling a Windows PC from somewhere else.',
      "Remote Desktop must be turned on (Windows Pro or higher: Home can't host it), Windows Firewall must allow it on the network profile in use, and the router must forward 3389 to the PC's local IP.",
      'Open RDP ports are a top way in for ransomware gangs. Prefer a VPN (Tailscale, WireGuard) or an RD Gateway to forwarding 3389.'],
    [3478, 'STUN / TURN', 'tcp+udp', 'STUN and TURN: getting voice and video calls, WebRTC and PlayStation Network through NAT (TCP and UDP 3478 to 3480).',
      "Games and calls normally work without forwarding it; PlayStation lists it for NAT type troubleshooting. A TURN server you host yourself (coturn, for Nextcloud Talk) needs it open."],
    [5000, 'Synology DSM (HTTP)', 'tcp', "Synology DSM's web interface over plain HTTP, and many development servers (Flask). On a Mac, AirPlay Receiver listens on 5000 too.",
      "Synology's QuickConnect works without any open port. If you do forward one, use HTTPS on 5001 instead.",
      "Don't put the NAS admin page on the internet over plain HTTP."],
    [5001, 'Synology DSM (HTTPS)', 'tcp', "Synology DSM's web interface over HTTPS.",
      "Check that DSM's own firewall (Control Panel > Security > Firewall) allows it and that the router forwards 5001 to the NAS. QuickConnect or Tailscale avoid opening it at all.",
      'NAS admin pages are a ransomware target (DeadBolt, eCh0raix): keep DSM updated and turn on 2-factor sign-in.'],
    [5060, 'SIP', 'tcp+udp', 'SIP: VoIP phones and phone systems (Asterisk, FreePBX, 3CX), mostly over UDP, sometimes TCP.',
      "Most VoIP phones register out to their provider and need nothing open. A router's \"SIP ALG\" setting often breaks calls: turning it off fixes one-way audio more often than opening ports does.",
      'An open SIP port draws toll-fraud scanners within hours.'],
    [5432, 'PostgreSQL', 'tcp', 'PostgreSQL database servers.',
      'Closed is usually right: PostgreSQL listens on localhost only until listen_addresses and pg_hba.conf are changed. Reach it over an SSH tunnel or a VPN instead.',
      'Open databases are tried for weak passwords around the clock.'],
    [5900, 'VNC', 'tcp', 'VNC: remote screen sharing (RealVNC, TightVNC, macOS Screen Sharing).',
      'The VNC server must be running and listening on all addresses, and the device firewall must allow it.',
      'Many VNC setups have weak or no passwords. Tunnel it over SSH or a VPN rather than opening it.'],
    [6881, 'BitTorrent', 'tcp+udp', "BitTorrent clients' traditional listening port (6881 to 6889, TCP and UDP). qBittorrent and others pick a random port by default.",
      "An open listening port gets you more peers. Check which port your client actually uses (its connection settings), and if you use a VPN, whether it supports port forwarding."],
    [7777, 'Terraria', 'tcp', 'Terraria servers (TCP 7777). ARK: Survival Evolved uses 7777 too, over UDP.',
      'Forward TCP 7777 to the PC hosting the world, and allow Terraria through Windows Firewall when it asks.'],
    [8006, 'Proxmox VE', 'tcp', "Proxmox VE's web interface (HTTPS).",
      'Usually reached only from your own network, so closed is normal.',
      "Don't expose the hypervisor's admin page: reach it over a VPN."],
    [8080, 'HTTP alternate', 'tcp', "The usual second HTTP port: web servers, proxies, Tomcat, Jenkins, qBittorrent's web UI and admin pages that stay off port 80.",
      'Check which app is meant to answer, and that it listens on all addresses rather than localhost only.'],
    [8096, 'Jellyfin / Emby', 'tcp', "Jellyfin and Emby media servers over HTTP (8920 is Jellyfin's HTTPS port).",
      'In Jellyfin, check that Dashboard > Networking allows remote connections, then forward 8096 (or 8920) to the server.'],
    [8123, 'Home Assistant', 'tcp', "Home Assistant's web interface and its app connection.",
      'Home Assistant Cloud (Nabu Casa) or a tunnel gives remote access without opening it. If you forward it, put HTTPS in front (the DuckDNS and Let\'s Encrypt add-ons, or a reverse proxy on 443).'],
    [8443, 'HTTPS alternate', 'tcp', 'The usual second HTTPS port: UniFi Network controllers, web admin panels and proxies.',
      'Check which app is meant to answer and that the router forwards 8443 to it.'],
    [9987, 'TeamSpeak 3', 'udp', 'TeamSpeak 3 voice (UDP 9987). File transfers use TCP 30033 and server queries TCP 10011.',
      'Forward UDP 9987 for voice and TCP 30033 for file transfers to the server.'],
    [19132, 'Minecraft Bedrock', 'udp', 'Minecraft: Bedrock Edition servers (UDP 19132, and 19133 for IPv6).',
      "Bedrock uses UDP, so forward UDP 19132. Consoles can't add custom servers without workarounds."],
    [25565, 'Minecraft Java', 'tcp', 'Minecraft: Java Edition servers.',
      "The server must be running (its console says Done), server-ip in server.properties should be left blank, Windows Firewall must allow Java (javaw.exe) on both private and public networks, and the router must forward TCP 25565 to the server's local IP. If friends still can't join, your provider may use carrier-grade NAT, which no port forward gets through."],
    [27015, 'Steam / Source games', 'tcp+udp', 'Steam and Source engine game servers: Counter-Strike 2, Garry\'s Mod, Team Fortress 2, ARK\'s query port and more (game traffic over UDP, remote console over TCP).',
      'Forward UDP 27015 for players and TCP 27015 for the remote console (RCON).'],
    [28015, 'Rust', 'udp', 'Rust game servers (UDP 28015; RCON on TCP 28016 and Rust+ on TCP 28082).',
      'Forward UDP 28015 for players, and TCP 28016 and 28082 if you use RCON or the Rust+ app.'],
    [32400, 'Plex', 'tcp', "Plex Media Server's remote access.",
      "In Plex, Settings > Remote Access shows whether Plex can reach the server. Turn on \"Manually specify public port\" with 32400 and forward it to the server's local IP. Behind carrier-grade NAT or double NAT, Plex falls back to its slow relay."],
    [51413, 'Transmission', 'tcp+udp', "The Transmission BitTorrent client's default peer port (TCP and UDP).",
      'Check the port in Preferences > Network matches the forward, and turn off "use random port".'],
    [51820, 'WireGuard', 'udp', 'WireGuard VPN servers (UDP 51820 by default), also used by PiVPN and wg-easy.',
      "WireGuard ignores packets without a valid key, so even a correctly forwarded port looks closed to any outside check. Test it by connecting a phone on mobile data."],
    [64738, 'Mumble', 'tcp+udp', 'Mumble voice chat servers (Murmur), over TCP and UDP.',
      'Forward 64738 TCP and UDP to the server.'],
  ];
  // The day the port pages last changed (a row above, IANA below, or the page itself: portPage() in src/worker.js,
  // portAbout() in public/app.js). /sitemap-ports.xml gives it as every port page's <lastmod>, so search engines
  // recrawl them when it moves: change it with them, and only then.
  const UPDATED = '2026-10-25';
  // IANA's service names for each port above, on the protocol(s) of its row, from the Service Name and Transport
  // Protocol Port Number Registry (iana.org/assignments/service-names-port-numbers, the CSV of 2026-10-25). Space
  // separated, in the registry's order; '' when IANA has no entry for that port and protocol. For the tcp+udp rows
  // the names are the same on both. `node tools/check_pages.mjs <the registry CSV>` checks them against a new copy.
  const IANA = {
    21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http www www-http', 110: 'pop3', 143: 'imap',
    443: 'https', 445: 'microsoft-ds', 554: 'rtsp', 587: 'submission', 993: 'imaps', 1194: 'openvpn', 1723: 'pptp',
    1883: 'mqtt', 2456: 'altav-remmgt', 3074: 'xbox', 3306: 'mysql', 3389: 'ms-wbt-server', 3478: 'stun turn stun-behavior',
    5000: 'commplex-main', 5001: 'commplex-link', 5060: 'sip', 5432: 'postgresql', 5900: 'rfb', 6881: '', 7777: 'cbt',
    8006: 'wpl-analytics', 8080: 'http-alt', 8096: '', 8123: '', 8443: 'pcsync-https', 9987: 'dsm-scm-target', 19132: '',
    25565: '', 27015: '', 28015: '', 32400: 'plex', 51413: '', 51820: '', 64738: '',
  };
  // The ports above that whatportis.com has no page for: https://whatportis.com/ports/<n> answers 404 (checked on the
  // day below; the others answered 200, or 308 to a page that did). refs() leaves whatportis out for them.
  const NO_WHATPORTIS = { checked: '2026-10-25', ports: new Set([8096, 28015, 51413, 64738]) };
  // Ports ipterm can't check at all, and why: the Worker refuses them before connecting, and their pages
  // and the terminal say so instead of offering a check.
  const UNTESTABLE = { 25: "Cloudflare, which runs ipterm, doesn't allow connections to port 25 (email), to stop spam." };
  // Providers that usually share IPv4 addresses between customers (carrier-grade NAT), so no port forward
  // can work, by AS number. Mobile networks in general do; these are the common home-internet cases. The
  // Worker names yours in the notes under a result that isn't open, and the page hides the names in a
  // port result's Markdown, since they say who your provider is.
  const CGNAT = { 14593: 'Starlink', 21928: 'T-Mobile', 22394: 'Verizon Wireless', 6167: 'Verizon Wireless', 20057: 'AT&T Mobility' };
  const BY = new Map(LIST.map(([port, name, proto, use, tips, risk]) => [port, { port, name, proto, use, tips, risk: risk || null }]));
  const PROTO = { tcp: 'TCP', udp: 'UDP (this check can only test TCP)', 'tcp+udp': 'TCP and UDP (the check tests TCP)' };
  const valid = n => Number.isInteger(n) && n >= 1 && n <= 65535;
  root.IPTERM_PORTS = {
    get: n => BY.get(Number(n)) || null,
    list: () => [...BY.keys()],
    protoText: p => PROTO[p] || 'TCP',
    // why ipterm can't check port n (one sentence), or null when it can
    untestable: n => UNTESTABLE[Number(n)] || null,
    // the carrier-grade NAT provider on AS number asn, or null; and all their names
    cgnat: asn => (Object.hasOwn(CGNAT, asn) ? CGNAT[asn] : null),
    cgnatNames: () => [...new Set(Object.values(CGNAT))],
    // "22", " 022 " -> 22; anything else (ranges, lists, words) -> null
    parse: s => { const t = String(s == null ? '' : s).trim(); const n = /^\d{1,5}$/.test(t) ? Number(t) : NaN; return valid(n) ? n : null; },
    updated: UPDATED,
    // IANA's registered names for port n, and as one line ("ssh (TCP)", "not registered with IANA"), or null for a
    // port that isn't in the list (only these were checked against the registry)
    iana: n => {
      const s = BY.get(Number(n)), names = s && Object.hasOwn(IANA, s.port) ? IANA[s.port].split(' ').filter(Boolean) : null;
      if (!names) return null;
      return { names, text: names.length ? `${names.join(', ')} (${s.proto === 'tcp+udp' ? 'TCP and UDP' : s.proto.toUpperCase()})` : 'not registered with IANA' };
    },
    // Where to read more about port n: IANA's registry searched for it (there is no page per port) and whatportis.com,
    // where it has a page (NO_WHATPORTIS)
    refs: n => [['IANA registry', `https://www.iana.org/assignments/service-names-port-numbers?search=${Number(n)}`],
      ...(NO_WHATPORTIS.ports.has(Number(n)) ? [] : [['whatportis', `https://whatportis.com/ports/${Number(n)}`]])],
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
