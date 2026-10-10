'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseBing, parseDuckDuckGo, bingTarget, ddgTarget, instantIntent, fuse, relevance } = require('../server/search');

const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('Bing result pages are parsed and redirect links decoded', () => {
  const ck = (u) => `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64(u)}&amp;ntb=1`;
  const html = `<ol id="b_results">
    <li class="b_algo"><h2><a href="${ck('https://en.wikipedia.org/wiki/Paris')}">Paris - <strong>Wikipedia</strong></a></h2>
      <div class="b_caption"><p class="b_lineclamp2">Paris is the capital &amp; largest city of France.</p></div></li>
    <li class="b_algo"><h2><a href="https://example.org/direct">Direct link</a></h2><p class="b_lineclamp3">1 day ago · Fresh news about bees.</p></li>
    <li class="b_ad"><h2><a href="https://ads.example/">Ad</a></h2></li>
  </ol>`;
  const r = parseBing(html);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: 'Paris - Wikipedia', url: 'https://en.wikipedia.org/wiki/Paris', snippet: 'Paris is the capital & largest city of France.', source: 'Bing' });
  assert.equal(r[1].url, 'https://example.org/direct');
  assert.equal(r[1].snippet, 'Fresh news about bees.');
  assert.equal(bingTarget('https://www.bing.com/images/search?q=x'), null);
});

test('DuckDuckGo result pages are parsed, ads skipped, uddg links decoded', () => {
  const html = `
    <div class="result results_links results_links_deep result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
    <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.britannica.com%2Fplace%2FParis&amp;rut=x">Paris | <b>Britannica</b></a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Paris, city and <b>capital</b> of France.</a></div></div>`;
  const r = parseDuckDuckGo(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://www.britannica.com/place/Paris');
  assert.equal(r[0].title, 'Paris | Britannica');
  assert.equal(r[0].snippet, 'Paris, city and capital of France.');
  assert.equal(ddgTarget('https://duckduckgo.com/y.js?ad_provider=x'), null);
});

test('instant-answer intents are recognised', () => {
  assert.deepEqual(instantIntent('weather in Tokyo'), ['weather', 'tokyo']);
  assert.deepEqual(instantIntent('Paris weather today'), ['weather', 'paris']);
  assert.deepEqual(instantIntent('what time is it in Sydney?'), ['time', 'sydney']);
  assert.deepEqual(instantIntent('define serendipity'), ['define', 'serendipity']);
  assert.equal(instantIntent('how much time to boil an egg'), null);
  assert.equal(instantIntent('capital of france'), null);
});

test('results several engines agree on rank first, then relevance', () => {
  const r = (url, title, source) => ({ url, title, snippet: '', source });
  const merged = fuse([
    { items: [r('https://coupons.example/', 'Coupons | Honey', 'Bing'), r('https://bees.example/life', 'Honey bee lifespan', 'Bing')], weight: 1 },
    { items: [r('https://other.example/', 'Other', 'DuckDuckGo'), r('https://www.bees.example/life/', 'Honey bee lifespan', 'DuckDuckGo')], weight: 1 },
  ], 'honey bee lifespan');
  assert.equal(merged[0].url, 'https://bees.example/life');
  assert.deepEqual(merged[0].engines.sort(), ['Bing', 'DuckDuckGo']);
  assert.equal(merged.length, 3, 'www/trailing-slash duplicates merge');
  assert.equal(relevance('what is the capital of france', 'Paris is the capital of France'), 1);
});
