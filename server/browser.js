'use strict';
/**
 * Vortex Browser backend — a privacy-preserving, SSRF-safe fetch proxy.
 *
 * The bee's real browser never talks to the internet directly: pages and their
 * images/stylesheets are fetched here, with every hop (including redirects and
 * DNS answers) checked against private/internal address ranges, then rendered
 * by the client inside a script-less sandboxed iframe.
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const config = require('./config');

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const UA = `Mozilla/5.0 (X11; Linux x86_64) VortexOS/${config.version} (MNX Hive Browser)`;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16],
]) blocked.addSubnet(addr, prefix, 'ipv6');

class BrowseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** True when an IP address must never be reached from the hive. */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / translated addresses: judge the embedded IPv4.
    const mapped = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
      return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

/** Parse and vet a user-supplied URL. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new BrowseError('That does not look like a web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BrowseError('Only http and https are allowed');
  if (u.username || u.password) throw new BrowseError('Credentials in URLs are not allowed');
  if (!ALLOWED_PORTS.has(u.port)) throw new BrowseError('Only standard web ports (80, 443, 8080, 8443) are allowed', 403);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!config.browser.allowPrivate) {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
      throw new BrowseError('Internal hosts are off-limits to the hive browser', 403);
    }
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw new BrowseError('Private and internal networks are off-limits to the hive browser', 403);
    }
  }
  u.hash = '';
  return u;
}

/** DNS lookup that refuses to hand back internal addresses (defeats DNS rebinding). */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!config.browser.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`${hostname} resolves to a private address`);
      e.code = 'EPRIVATE';
      return callback(e);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** Resolve + vet a host without connecting (used before tunnelling through an upstream proxy). */
function vetHost(hostname) {
  return new Promise((resolve, reject) => {
    if (net.isIP(hostname)) return resolve();
    safeLookup(hostname, { all: true }, (err) => (err ? reject(err) : resolve()));
    return undefined;
  });
}

/** Open a CONNECT tunnel through VORTEX_UPSTREAM_PROXY (for networks that require one). */
function tunnel(u) {
  return new Promise((resolve, reject) => {
    const p = new URL(config.browser.upstreamProxy);
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const target = `${u.hostname}:${port}`;
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: target, headers: { Host: target }, timeout: config.browser.timeoutMs });
    req.on('connect', (res, socket) => {
      // The tunnel may be reset after the exchange has finished; never let that crash the hive.
      socket.on('error', () => {});
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new BrowseError(`The upstream proxy refused ${u.hostname} (${res.statusCode})`, 502));
      } else resolve(socket);
    });
    req.on('timeout', () => req.destroy(new BrowseError('The upstream proxy took too long', 504)));
    req.on('error', (err) => reject(err instanceof BrowseError ? err : new BrowseError(`Upstream proxy unreachable (${err.code || err.message})`, 502)));
    req.end();
  });
}

function requestOnce(u, accept, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      method: 'GET',
      lookup: safeLookup,
      timeout: config.browser.timeoutMs,
      headers: {
        'User-Agent': UA,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        ...extraHeaders,
      },
    };
    const fail = (err) => {
      if (err instanceof BrowseError) return reject(err);
      if (err.code === 'EPRIVATE') return reject(new BrowseError('That host points at a private network — blocked', 403));
      if (err.code === 'ENOTFOUND') return reject(new BrowseError('Site not found', 502));
      return reject(new BrowseError(`Could not reach the site (${err.code || err.message})`, 502));
    };
    const start = (socket) => {
      if (socket) {
        opts.agent = false;
        opts.createConnection = () => {
          if (u.protocol !== 'https:') return socket;
          const t = tls.connect({ socket, servername: u.hostname });
          t.on('error', () => {}); // surfaced through the request's own 'error' event
          return t;
        };
      }
      const req = mod.request(u, opts, (res) => resolve(res));
      req.on('timeout', () => req.destroy(new BrowseError('The site took too long to answer', 504)));
      req.on('error', fail);
      req.end();
    };
    if (config.browser.upstreamProxy) {
      // The address is vetted locally first, then reached through the proxy's tunnel.
      vetHost(u.hostname).then(() => tunnel(u)).then(start, fail);
    } else start(null);
  });
}

function decompress(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function collect(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(new BrowseError('Page is too large for the hive browser', 413));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err instanceof BrowseError ? err : new BrowseError('Download failed', 502)));
  });
}

/** Fetch with manually-followed, re-validated redirects. */
async function safeFetch(raw, accept = '*/*', headers = {}) {
  let u = checkUrl(raw);
  for (let hop = 0; hop <= config.browser.maxRedirects; hop++) {
    const res = await requestOnce(u, accept, headers);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      u = checkUrl(new URL(res.headers.location, u).href);
      continue;
    }
    const body = await collect(decompress(res), config.browser.maxBytes);
    return { url: u.href, status: res.statusCode, headers: res.headers, body };
  }
  throw new BrowseError('Too many redirects', 508);
}

// ── HTML rewriting ───────────────────────────────────────────────────────────

const assetUrl = (abs) => `/api/browser/asset?url=${encodeURIComponent(abs)}`;

function resolveUrl(value, base) {
  try {
    const u = new URL(decodeEntities(value.trim()), base);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    if (u.protocol === 'data:' && /^data:image\/(png|gif|jpe?g|webp)/i.test(u.href)) return u.href;
  } catch {
    /* fall through */
  }
  return null;
}

function decodeEntities(s) {
  return s.replace(/&(amp|quot|#39|lt|gt|#x27);/g, (m, e) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>', '#x27': "'" })[e]);
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function rewriteCssUrls(css, base) {
  return css
    // `@import "x.css"` → `@import url("x.css")`, so the single url() pass below proxies it.
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, href) => `@import url("${href}")`)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, href) => {
      if (/^data:/i.test(href.trim())) return m;
      const abs = resolveUrl(href, base);
      return abs ? `url("${assetUrl(abs)}")` : 'none';
    });
}

const DROP_BLOCKS = /<(script|iframe|frame|frameset|object|embed|applet|template|svg:script)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS = /<\/?(script|iframe|frame|frameset|object|embed|applet|base|portal)\b[^>]*>/gi;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function rewriteTag(tag, attrs, base) {
  const name = tag.toLowerCase();
  const parsed = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrs))) {
    parsed.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? null]);
  }
  const get = (k) => parsed.find(([a]) => a === k)?.[1];

  if (name === 'meta') {
    const equiv = (get('http-equiv') || '').toLowerCase();
    if (equiv === 'refresh' || equiv === 'content-security-policy' || equiv === 'set-cookie') return '';
  }
  if (name === 'link') {
    const rel = (get('rel') || '').toLowerCase();
    if (!/\b(stylesheet|icon)\b/.test(rel)) return '';
  }

  const out = [];
  for (let [k, v] of parsed) {
    if (k.startsWith('on') || k === 'srcset' || k === 'integrity' || k === 'nonce' || k === 'ping') continue;
    if (v === null) {
      out.push(k);
      continue;
    }
    if (k === 'href' && (name === 'a' || name === 'area')) {
      const abs = resolveUrl(v, base);
      if (!abs) continue;
      out.push(`href="${escAttr(abs)}"`);
      continue;
    }
    if ((k === 'href' && name === 'link') || ((k === 'src' || k === 'poster') && name !== 'a')) {
      const abs = resolveUrl(v, base);
      if (!abs) continue;
      out.push(`${k}="${escAttr(abs.startsWith('data:') ? abs : assetUrl(abs))}"`);
      continue;
    }
    if (k === 'action' && name === 'form') {
      const abs = resolveUrl(v || base, base);
      if (abs) out.push(`data-vortex-action="${escAttr(abs)}"`);
      continue;
    }
    if (k === 'style') {
      out.push(`style="${escAttr(rewriteCssUrls(decodeEntities(v), base))}"`);
      continue;
    }
    if (/^(xlink:href|formaction|background|lowsrc|dynsrc)$/.test(k)) continue;
    out.push(`${k}="${escAttr(decodeEntities(v))}"`);
  }

  // Lazy-loaded images rely on JS we will never run: promote data-src.
  if (name === 'img' && !get('src') && get('data-src')) {
    const abs = resolveUrl(get('data-src'), base);
    if (abs) out.push(`src="${escAttr(assetUrl(abs))}"`);
  }
  if (name === 'form' && get('action') === undefined) out.push(`data-vortex-action="${escAttr(base)}"`);
  return `<${tag}${out.length ? ' ' + out.join(' ') : ''}>`;
}

function rewriteHtml(html, base) {
  let title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  title = decodeEntities(title.replace(/\s+/g, ' ').trim()).slice(0, 200);

  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_BLOCKS, '')
    .replace(DROP_TAGS, '')
    .replace(/<\/?noscript\b[^>]*>/gi, '') // scripts never run here, so show the fallbacks
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + rewriteCssUrls(css, base) + b)
    .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?\s*(\/?)>/g, (m, tag, attrs, selfClose) => {
      if (!attrs) return m;
      const t = rewriteTag(tag, attrs, base);
      return t && selfClose ? t.slice(0, -1) + ' />' : t;
    });

  return { title, html: out };
}

function charsetOf(contentType, body) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

function decode(body, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType, body)).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Fetch a page for the Vortex Browser window. */
async function page(raw) {
  const res = await safeFetch(raw, 'text/html,application/xhtml+xml,text/plain;q=0.9,image/*;q=0.8,*/*;q=0.5');
  const type = String(res.headers['content-type'] || '').toLowerCase();
  const base = { url: res.url, status: res.status };
  if (type.includes('html') || type.includes('xml') || (!type && /^\s*</.test(res.body.subarray(0, 100).toString()))) {
    const { title, html } = rewriteHtml(decode(res.body, type), res.url);
    return { ...base, kind: 'html', title: title || new URL(res.url).hostname, html };
  }
  if (type.startsWith('image/')) return { ...base, kind: 'image', title: res.url.split('/').pop(), src: assetUrl(res.url) };
  if (type.startsWith('text/') || type.includes('json') || type.includes('javascript')) {
    return { ...base, kind: 'text', title: res.url.split('/').pop() || res.url, text: decode(res.body, type).slice(0, 500_000) };
  }
  return { ...base, kind: 'binary', title: res.url, contentType: type || 'unknown', size: res.body.length };
}

const ASSET_TYPES = /^(image\/(png|gif|jpeg|webp|avif|x-icon|vnd\.microsoft\.icon|bmp|svg\+xml)|text\/css|font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/;

/** Fetch a sub-resource (image, stylesheet, font). */
async function asset(raw) {
  const res = await safeFetch(raw, 'image/*,text/css,font/*,*/*;q=0.1');
  let type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!type && /\.(woff2?|ttf|otf)(\?|$)/i.test(res.url)) type = 'font/' + RegExp.$1.toLowerCase();
  if (!ASSET_TYPES.test(type)) throw new BrowseError('Unsupported resource type', 415);
  let body = res.body;
  if (type === 'text/css') body = Buffer.from(rewriteCssUrls(decode(body, res.headers['content-type']), res.url));
  return { type, body, status: res.status };
}

/** Tiny token bucket per bee. */
class Bucket {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.state = new Map();
  }
  take(key) {
    const now = Date.now();
    const s = this.state.get(key) || { tokens: this.perMinute, at: now };
    s.tokens = Math.min(this.perMinute, s.tokens + ((now - s.at) / 60_000) * this.perMinute);
    s.at = now;
    this.state.set(key, s);
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }
}

module.exports = { page, asset, safeFetch, checkUrl, isPrivateAddress, rewriteHtml, rewriteCssUrls, BrowseError, Bucket };
