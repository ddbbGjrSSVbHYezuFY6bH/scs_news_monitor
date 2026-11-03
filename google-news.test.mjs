import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GoogleNewsClient, parseRss, rssUrl, googleArticleId, decodingParameters,
  rpcForm, parseRpcResponse, publisherUrl } from '../src/google-news.mjs';

const locale = { query: 'trade "talks" & peace', language: 'en-US', country: 'US', edition: 'US:en' };
const frame = url => [['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', url, 1])]];
const page = '<c-wiz><div data-n-a-ts="12345" data-n-a-sg="abc&amp;def" data-n-a-id="ABC"></div></c-wiz>';

test('RSS parsing handles CDATA, entities, singleton items and valid empty feeds', () => {
  const articles = parseRss(`<rss version="2.0"><channel><item><title><![CDATA[Trade &amp; peace]]></title>
    <link>https://news.google.com/rss/articles/ABC?oc=5</link><source url="https://publisher.example">Example News</source>
    <description><![CDATA[<a href="https://example.com">A headline</a>&nbsp; Publisher]]></description>
    <pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'Trade & peace');
  assert.equal(articles[0].rssDescription, 'A headline Publisher');
  assert.equal(articles[0].publisher, 'Example News');
  assert.equal(articles[0].googleArticleId, 'ABC');
  assert.equal(articles[0].publishedAt, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(parseRss('<rss><channel><title>Empty feed</title></channel></rss>'), []);
  assert.throws(() => parseRss('<html><body>Blocked</body></html>'));
  assert.throws(() => parseRss('<rss><channel>'));
  assert.throws(() => parseRss('<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>'));
});

test('query encoding and article validation do not treat arbitrary hosts as Google', () => {
  assert.equal(new URL(rssUrl(locale)).searchParams.get('q'), locale.query);
  assert.equal(googleArticleId('https://news.google.com/read/ABC'), 'ABC');
  for (const url of ['http://news.google.com/rss/articles/ABC', 'https://news.google.com.evil.example/read/ABC',
    'https://user:pass@news.google.com/read/ABC', 'https://news.google.com:444/read/ABC']) assert.equal(googleArticleId(url), null);
  for (const url of ['javascript:alert(1)', 'https://consent.google.com/', 'https://127.0.0.1/x',
    'https://localhost/x', 'https://user:pass@publisher.example/x', 'https://publisher.example./x']) assert.equal(publisherUrl(url), null);
});

test('signature and timestamp must come from the same article element', () => {
  assert.deepEqual(decodingParameters(page, 'ABC'), { signature: 'abc&def', timestamp: 12345 });
  assert.throws(() => decodingParameters('<div data-n-a-sg="one"></div><div data-n-a-ts="123"></div>', 'ABC'));
  assert.throws(() => decodingParameters(page, 'OTHER'));
  const envelope = JSON.parse(new URLSearchParams(rpcForm('ABC', decodingParameters(page, 'ABC'), 'US:en')).get('f.req'));
  assert.equal(envelope[0][0][0], 'Fbv4je');
  assert.deepEqual(JSON.parse(envelope[0][0][1]).slice(2), ['ABC', 12345, 'abc&def']);
});

test('RPC parsing accepts XSSI, length framing, multiline nested JSON and escaped URL characters', () => {
  const url = 'https://publisher.example/article?first=1&second=2';
  const json = JSON.stringify(frame(url), null, 2);
  assert.equal(parseRpcResponse(Buffer.from(`)]}'\n\n${Buffer.byteLength(json)}\n${json}\n`)), url);
  assert.throws(() => parseRpcResponse(Buffer.from('https://publisher.example/just-a-string')));
  assert.throws(() => parseRpcResponse(Buffer.from(JSON.stringify(['garturlres', url]))));
  assert.throws(() => parseRpcResponse(Buffer.from(JSON.stringify([['wrb.fr', 'WRONG', JSON.stringify(['garturlres', url])]]))));
  assert.throws(() => parseRpcResponse(Buffer.from(JSON.stringify(frame('https://news.google.com/')))));
});

function encodeVarint(value) {
  const bytes = [];
  do { const rest = value >>> 7; bytes.push((value & 127) | (rest ? 128 : 0)); value = rest; } while (value);
  return Buffer.from(bytes);
}

test('binary RPC parser uses protobuf lengths including multibyte lengths and rejects truncation', () => {
  const url = `https://publisher.example/${'long-'.repeat(60)}`;
  const payload = Buffer.from(JSON.stringify(['garturlres', url, 1]));
  const binary = Buffer.concat([Buffer.from([10, 6]), Buffer.from('Fbv4je'), Buffer.from([18]),
    encodeVarint(payload.length), payload, Buffer.from([50, 0])]);
  assert.equal(parseRpcResponse(binary), url);
  assert.throws(() => parseRpcResponse(binary.subarray(0, binary.length - 3)));
});

test('binary parser resolves the archived SCS wire-format response', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/binary-rpc.json', import.meta.url), 'utf8'));
  assert.equal(parseRpcResponse(Buffer.from(fixture.base64, 'base64')), fixture.publisherUrl);
});

test('HTTP resolver performs the expected two requests and never fetches the publisher', async () => {
  const calls = [], url = 'https://publisher.example/article';
  const client = new GoogleNewsClient({ intervalMs: 0, fetchImpl: async (target, options) => {
    calls.push({ url: String(target), options });
    return calls.length === 1 ? new Response(page) : new Response(JSON.stringify(frame(url)));
  } });
  assert.equal((await client.resolve('https://news.google.com/rss/articles/ABC', locale)).publisherUrl, url);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.ok(calls.every(call => new URL(call.url).hostname === 'news.google.com'));
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
});

test('HTTP resolver follows anonymous Google consent hops and stops at a publisher redirect', async () => {
  const calls = [];
  const client = new GoogleNewsClient({ intervalMs: 0, fetchImpl: async target => {
    calls.push(String(target));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://consent.google.com/m?continue=news' } });
    return new Response(null, { status: 302, headers: { Location: 'https://publisher.example/article' } });
  } });
  assert.equal((await client.resolve('https://news.google.com/rss/articles/ABC', locale)).method, 'redirect');
  assert.equal(calls.length, 2);
});

test('throttling is surfaced immediately with Retry-After; it is not retried', async () => {
  let calls = 0;
  const client = new GoogleNewsClient({ intervalMs: 0, fetchImpl: async () => {
    calls++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } });
  } });
  await assert.rejects(client.feed(locale), error => error.code === 'RateLimited' && error.retryAfter === '60');
  assert.equal(calls, 1);
});

test('transport errors retry once, and the budget prevents further requests', async () => {
  let calls = 0, clock = 1000;
  const client = new GoogleNewsClient({ intervalMs: 0, budgetMs: 10000, now: () => clock,
    wait: async ms => { clock += ms; }, fetchImpl: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(client.feed(locale), error => error.code === 'TransportError');
  assert.equal(calls, 2);
  clock = client.deadline;
  await assert.rejects(client.feed(locale), error => error.code === 'TimeBudgetExceeded');
  assert.equal(calls, 2);
});
