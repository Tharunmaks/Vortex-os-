# Vortex OS security model

Vortex OS gives bees a **real Linux shell** in the cloud. Its security is built in layers, and no
single layer has to be perfect. This document describes the layers, what each one stops, and
where each one stops working.

## 1. The container: the security boundary

The terminal runs real bash, so a determined bee can run any program the container allows. **The
container is the actual security boundary.** The provided `docker-compose.yml` sets it up like this:

| Control | Effect |
| --- | --- |
| `USER bee` (uid 10001) | Nothing runs as root. There is no `sudo` and no setuid helpers are used. |
| `read_only: true` | The OS can't be modified. Only `/var/lib/vortex` (the volume) and tmpfs mounts are writable. |
| `cap_drop: [ALL]` | The process has no Linux capabilities (`CapEff: 0`). It can't use raw sockets, mount, change file ownership, and so on. |
| `no-new-privileges` | No process can gain privileges, even through setuid binaries. |
| `pids_limit`, `mem_limit`, `cpus` | Fork bombs and runaway jobs can't take down the host. |
| Loopback-only port | Vortex is reachable only through the HTTPS proxy (Caddy profile). |

All bees in one container share the `bee` Unix user. Vortex keeps each bee to their own home folder
in the Files API and starts each shell there. **Inside the shell, though, a worker bee can read
other bees' homes.** If the bees must not trust each other, run **one container per bee or team**
(for example one compose project each). Use the Drone role for bees who should have no shell.

For stronger isolation in multi-tenant clouds, run the container under gVisor (`runtime: runsc`)
or Kata Containers, and add egress firewall rules.

## 2. Accounts and sessions

- Passwords are hashed with **scrypt** (N=16384, r=8, p=1) using a random 16-byte salt per bee, and compared in constant time.
- A password needs at least 10 characters and 3 of the 4 character classes, and must not contain the bee name.
- New bees and password resets get **one-time passwords**. The bee can do nothing else until they choose a new one, and the server enforces this.
- **Lockout.** 5 failures per bee name or 20 per IP within 15 minutes locks that name or IP out for 15 minutes. Unknown bee names still go through a full scrypt check, so the response time doesn't reveal whether a name exists.
- Session tokens are 256-bit random values, stored only in server memory. The cookie is `HttpOnly; SameSite=Strict` (plus `Secure` with `VORTEX_SECURE_COOKIES=1`). Sessions end after 30 minutes idle or 12 hours in total.
- **CSRF and cross-site WebSocket hijacking.** Every non-GET request and every WebSocket upgrade must carry an `Origin` that matches the host.
- Disabling, demoting, removing or resetting a bee immediately ends their sessions and closes their terminals.
- The hive always keeps at least one active queen, and queens can't demote or remove themselves.

## 3. Hive Guard (shell seatbelt)

`server/shell/hive-rc.sh` installs a bash `DEBUG` trap with `extdebug` set. The trap checks **the
whole command line** (read from history) and **each simple command** before it runs. It refuses:

- recursive deletes of `/`, the home folder or system directories, and `--no-preserve-root`
- fork bombs
- `mkfs`, and raw writes to block devices with `dd`, `shred` or `>`
- shutdown, reboot, halt and runlevel changes
- `chmod -R` and `chown -R` on `/`
- `curl … | sh` and `wget … | sh`
- `/dev/tcp` and `nc -e` reverse shells
- known crypto-miners
- attempts to switch the guard off: `trap`, `shopt -u extdebug`, `set +o history`, `unset __hive*`, `history -c`, `bash --norc`, `env -i`

Blocked commands appear in the audit log as `guard.blocked` alerts. The guard's functions and
rule tables are `readonly`, and nested interactive shells load the guard through
`/etc/bash.bashrc`.

**Limits, stated honestly:** the guard checks text, so indirection can get past it. Examples are
`x=/; rm -rf $x`, scripts kept in files, and other interpreters such as `python -c`. It is meant to
catch accidents and casual abuse and to leave an audit trail. It is **not** a sandbox. Section 1 is
the sandbox.

## 4. File cells

- Every path is normalised against the bee's home folder, so `..` can never climb above it.
- The real path (`realpath`) of the deepest existing ancestor must be inside the home folder. This stops bees from using symlinks created in the terminal to escape.
- NUL bytes and over-long paths are rejected, and file names can't contain `/`, `\` or `..`.
- The server refuses to delete or rename the home folder itself.
- Uploads are streamed to a temporary file, checked against the size limit and the per-bee quota, and then renamed into place atomically.
- Downloads are sent with `Content-Disposition: attachment` and `nosniff`, so uploaded HTML can't run as part of the Vortex site.

## 5. Browser (SSRF and XSS)

The bee's own browser never contacts websites directly. `server/browser.js` fetches pages and
sub-resources for it, and the page is then rendered by **Vortex Engine**, a from-scratch HTML/CSS
engine that has no JavaScript runtime at all:

- Only `http` and `https` are allowed, on ports 80, 443, 8080 or 8443, and URLs with embedded credentials are rejected.
- Host names like `localhost`, `*.local`, `*.internal` and `metadata.google.internal` are refused.
- **The DNS answer is pinned.** A custom `lookup` refuses any answer in a blocked range: RFC 1918, loopback, link-local (including `169.254.169.254`), CGNAT, multicast, reserved ranges, IPv6 ULA and link-local, and IPv4 addresses embedded in IPv6 (`::ffff:`, `64:ff9b::`). The connection then uses the address that was checked, so DNS rebinding doesn't work.
- Redirects are followed by hand, and each hop is checked again. The proxy enforces a 5-redirect limit, a 5 MB size limit, a 15-second timeout and per-bee rate limits.
- HTML is stripped of `<script>`, `<iframe>`, `<object>`, event handlers, `javascript:` URLs, meta refresh and `<base>`. Images, CSS and fonts are rewritten so they also load through the proxy.
- **There is no DOM and no script engine to attack.** The page is parsed into a private tree, laid out and drawn onto a `<canvas>`. Page content is never inserted into the Vortex document as HTML, and there is no iframe, so there is no markup path from a website into the desktop. The proxy's sanitising is a second layer, not the only one.
- Form controls shown on a page are real inputs created by Vortex itself; the page's markup can only set their label, placeholder and initial value as text.
- Proxied sub-resources are served with `Content-Security-Policy: sandbox; default-src 'none'`, so opening one directly can't run script on the Vortex site.
- Built-in `vortex://` pages escape every value (history titles and URLs come from websites).
- **Vortex Search** queries public sources (DuckDuckGo, Bing, Wikipedia, Wiktionary, Open-Meteo) through the same SSRF-safe fetcher, so a search never reaches internal networks either. Result pages are parsed on the server and only titles, links and snippets go to the bee as escaped text. Queries are rate-limited per bee and recorded in the audit log as `browser.search`; they are sent to those third-party services, so bees should not search for secrets.
- With `VORTEX_UPSTREAM_PROXY` set, every host is still resolved and checked against the blocked ranges before it is reached through the proxy's CONNECT tunnel. The proxy resolves the name again itself, so the DNS-rebinding guarantee becomes "checked, then trusted to the proxy"; only use a proxy you control.

## 6. HTTP hardening

- A strict CSP: `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`, and HSTS when cookies are secure.
- Static files are served only from `public/`, and only for whitelisted asset types.
- Request bodies are size-limited, and errors return generic messages with no stack traces.
- Shells start with a **clean environment**, so server secrets never reach bees.

## 7. Audit trail

`data/audit.log` holds one JSON object per line, and the latest 1000 entries are viewable in Hive
Control. It records:

- logins, failed logins and lockouts
- terminals opening and closing, and each command line typed
- Hive Guard blocks
- file writes, uploads, renames and deletes
- process kills
- browser visits and blocked URLs
- every admin action

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the hive's queen directly. Please
don't post exploit details in public issues.
