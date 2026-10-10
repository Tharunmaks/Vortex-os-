'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isPrivateAddress, checkUrl, rewriteHtml, rewriteCssUrls } = require('../server/browser');

test('private and internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::10.0.0.1', '224.0.0.1']) {
    assert.ok(isPrivateAddress(ip), `${ip} should be private`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.ok(!isPrivateAddress(ip), `${ip} should be public`);
  }
});

test('URLs are vetted before fetching', () => {
  assert.equal(checkUrl('https://example.com/a#frag').href, 'https://example.com/a');
  for (const bad of ['file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'http://user:pw@example.com/',
    'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://metadata.google.internal/',
    'http://169.254.169.254/latest', 'http://example.com:22/', 'http://2130706433/', 'http://0x7f.1/']) {
    assert.throws(() => checkUrl(bad), undefined, bad);
  }
});

test('HTML is defanged and routed through the proxy', () => {
  const { html, title } = rewriteHtml(
    `<html><head><title>T &amp; T</title><script>evil()</script><base href="https://attacker/">
     <meta http-equiv="refresh" content="0;url=https://x"><link rel="preload" href="/p.js"><link rel="stylesheet" href="/s.css">
     <style>body{background:url('/bg.png')}</style></head>
     <body onload="evil()"><iframe src="https://x"></iframe><a href="javascript:evil()">j</a><a href="/next?a=1&amp;b=2">n</a>
     <img src="pic.png" srcset="big.png 2x" onerror="evil()"><img data-src="/lazy.png"><form action="/search"><input name=q></form>
     <svg><script>evil()</script></svg><object data="x.swf"></object><noscript><p>fallback</p></noscript></body></html>`,
    'https://example.com/dir/page',
  );
  assert.equal(title, 'T & T');
  assert.doesNotMatch(html, /<script|evil\(\)|<iframe|<base|refresh|<object|onerror|onload|srcset|javascript:/i);
  assert.match(html, /href="https:\/\/example\.com\/next\?a=1&amp;b=2"/);
  assert.match(html, /src="\/api\/browser\/asset\?url=https%3A%2F%2Fexample\.com%2Fdir%2Fpic\.png"/);
  assert.match(html, /src="\/api\/browser\/asset\?url=https%3A%2F%2Fexample\.com%2Flazy\.png"/);
  assert.match(html, /href="\/api\/browser\/asset\?url=https%3A%2F%2Fexample\.com%2Fs\.css"/);
  assert.match(html, /data-vortex-action="https:\/\/example\.com\/search"/);
  assert.match(html, /url\("\/api\/browser\/asset\?url=https%3A%2F%2Fexample\.com%2Fbg\.png"\)/);
  assert.match(html, /<p>fallback<\/p>/);
});

test('CSS urls and imports are proxied', () => {
  const css = rewriteCssUrls('@import "a.css"; .x{background:url(img/b.png)} .y{background:url(data:image/png;base64,AA==)}', 'https://cdn.example/css/');
  assert.match(css, /@import url\("\/api\/browser\/asset\?url=https%3A%2F%2Fcdn\.example%2Fcss%2Fa\.css"\)/);
  assert.match(css, /url\("\/api\/browser\/asset\?url=https%3A%2F%2Fcdn\.example%2Fcss%2Fimg%2Fb\.png"\)/);
  assert.match(css, /url\(data:image\/png;base64,AA==\)/);
});
