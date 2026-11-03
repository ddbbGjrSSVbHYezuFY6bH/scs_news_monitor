import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeHTML } from 'entities';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class ResolutionError extends Error {
  constructor(code, message = code, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ResolutionError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function publisherUrl(value) {
  if (typeof value !== 'string' || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.port || !host.includes('.') || host.endsWith('.') || isIP(host) || host.startsWith('[') ||
        host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host === 'google.com' || host.endsWith('.google.com')) return null;
    return url.href;
  } catch { return null; }
}

export function googleArticleId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'news.google.com' || url.port || url.username || url.password) return null;
    return /^\/(?:rss\/articles|articles|read)\/([A-Za-z0-9_-]{1,4096})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export function rssUrl(query) {
  const url = new URL('https://news.google.com/rss/search');
  url.search = new URLSearchParams({ q: query.query, hl: query.language, gl: query.country, ceid: query.edition });
  return url.href;
}

export function parseRss(xml) {
  // No DTDs or custom entities; the upstream feed is untrusted input.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ResolutionError('InvalidFeed', 'DTD declarations are not supported.');
  if (XMLValidator.validate(xml) !== true) throw new ResolutionError('InvalidFeed', 'Malformed RSS XML.');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel || typeof channel !== 'object') throw new ResolutionError('InvalidFeed', 'Response is not an RSS channel.');
  const items = channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];
  const text = value => typeof value === 'object' && value ? String(value['#text'] ?? '') : String(value ?? '');
  return items.flatMap(item => {
    const link = text(item.link);
    if (!googleArticleId(link) && !publisherUrl(link)) return [];
    const date = Date.parse(text(item.pubDate));
    return [{
      title: decodeHTML(text(item.title)), publisher: decodeHTML(text(item.source)),
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      rssDescription: decodeHTML(text(item.description)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      rssUrl: link, googleArticleId: googleArticleId(link),
    }];
  });
}

export function decodingParameters(html, expectedId) {
  for (const match of html.matchAll(/<[a-z][^>]*\bdata-n-a-sg\s*=[^>]*>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/\b(data-n-a-(?:sg|ts|id))\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(m => [m[1], decodeHTML(m[2] ?? m[3])]));
    const timestamp = Number(attributes['data-n-a-ts']);
    if (attributes['data-n-a-sg'] && Number.isSafeInteger(timestamp) && timestamp > 0 &&
        (!attributes['data-n-a-id'] || attributes['data-n-a-id'] === expectedId)) {
      return { signature: attributes['data-n-a-sg'], timestamp };
    }
  }
  throw new ResolutionError('NoDecodingParameters');
}

export function rpcForm(articleId, { signature, timestamp }, edition) {
  const context = [
    ['X', 'X', ['X', 'X'], null, null, 1, 1, edition, null, 1, null, null, null, null, null, 0, 1],
    'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
  ];
  const inner = ['garturlreq', context, articleId, timestamp, signature];
  return new URLSearchParams({ 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify(inner)]]]) }).toString();
}

function decodedPayload(value) {
  if (!Array.isArray(value) || value[0] !== 'garturlres') return null;
  return publisherUrl(value[1]);
}

function rpcUrlInFrame(value, depth = 0) {
  if (!Array.isArray(value) || depth > 64) return null;
  if (value[0] === 'wrb.fr' && value[1] === 'Fbv4je' && typeof value[2] === 'string') {
    try { return decodedPayload(JSON.parse(value[2])); } catch { return null; }
  }
  for (const child of value) {
    const found = rpcUrlInFrame(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function varint(bytes, cursor) {
  let value = 0;
  for (let shift = 0; shift <= 49 && cursor.offset < bytes.length; shift += 7) {
    const byte = bytes[cursor.offset++];
    value += (byte & 127) * 2 ** shift;
    if (!Number.isSafeInteger(value)) throw new Error('Invalid protobuf integer.');
    if (!(byte & 128)) return value;
  }
  throw new Error('Truncated protobuf integer.');
}

function protobufRpc(bytes) {
  const cursor = { offset: 0 };
  let rpcId, payload;
  while (cursor.offset < bytes.length) {
    const tag = varint(bytes, cursor), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error('Invalid protobuf tag.');
    if (wire === 2) {
      const size = varint(bytes, cursor);
      if (size > bytes.length - cursor.offset) throw new Error('Truncated protobuf field.');
      if (field === 1) rpcId = bytes.subarray(cursor.offset, cursor.offset + size).toString('utf8');
      if (field === 2) payload = bytes.subarray(cursor.offset, cursor.offset + size).toString('utf8');
      cursor.offset += size;
    } else if (wire === 0) varint(bytes, cursor);
    else if (wire === 1 || wire === 5) {
      cursor.offset += wire === 1 ? 8 : 4;
      if (cursor.offset > bytes.length) throw new Error('Truncated protobuf field.');
    } else throw new Error('Unsupported protobuf wire type.');
  }
  return rpcId === 'Fbv4je' && payload ? decodedPayload(JSON.parse(payload)) : null;
}

export function parseRpcResponse(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes[0] === 10) {
    try {
      const found = protobufRpc(bytes);
      if (found) return found;
    } catch { /* Only framed JSON below is an allowed alternative. */ }
  }
  // Scan complete JSON arrays. This accepts XSSI prefixes, length lines and multiline frames.
  const text = bytes.toString('utf8');
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (c === '[') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (++depth > 128) throw new ResolutionError('InvalidRpcResponse'); }
    else if (c === ']' || c === '}') {
      if (--depth === 0) {
        try {
          const found = rpcUrlInFrame(JSON.parse(text.slice(start, i + 1)));
          if (found) return found;
        } catch { /* Look for another complete frame, never an arbitrary URL. */ }
        start = -1;
      }
    }
  }
  throw new ResolutionError('InvalidRpcResponse');
}

async function responseBytes(response, maxBytes = 6 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ResolutionError('ResponseTooLarge');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new ResolutionError('ResponseTooLarge');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export class GoogleNewsClient {
  constructor({ fetchImpl = fetch, intervalMs = 1200, timeoutMs = 10000, budgetMs = 480000,
    now = Date.now, wait = sleep } = {}) {
    Object.assign(this, { fetchImpl, intervalMs, timeoutMs, now, wait });
    this.deadline = now() + budgetMs;
    this.nextRequest = now();
    this.requests = 0;
  }

  async request(url, options = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['news.google.com', 'consent.google.com'].includes(target.hostname) ||
        target.port || target.username || target.password) throw new ResolutionError('RedirectNotAllowed');
    for (let attempt = 0; attempt < 2; attempt++) {
      const pause = Math.max(0, this.nextRequest - this.now());
      if (this.now() + pause >= this.deadline) throw new ResolutionError('TimeBudgetExceeded');
      if (pause) await this.wait(pause);
      const remaining = this.deadline - this.now();
      if (remaining <= 0) throw new ResolutionError('TimeBudgetExceeded');
      const signal = AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, remaining)));
      let error;
      try {
        this.requests++;
        const response = await this.fetchImpl(target, {
          ...options, redirect: 'manual', signal,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9', ...options.headers },
        });
        this.nextRequest = this.now() + this.intervalMs;
        if (response.status === 429) {
          await response.body?.cancel();
          throw new ResolutionError('RateLimited', 'Google throttled this run.', {
            status: 429, retryAfter: response.headers.get('retry-after'),
          });
        }
        if (response.status === 403) { await response.body?.cancel(); throw new ResolutionError('GoogleChallenge', undefined, { status: 403 }); }
        if (response.status >= 500) { await response.body?.cancel(); throw new ResolutionError('UpstreamUnavailable', undefined, { status: response.status }); }
        if (response.status >= 400) { await response.body?.cancel(); throw new ResolutionError('HTTPError', undefined, { status: response.status }); }
        const bytes = await responseBytes(response);
        return { status: response.status, headers: response.headers, bytes };
      } catch (cause) {
        this.nextRequest = this.now() + this.intervalMs;
        error = cause instanceof ResolutionError ? cause : new ResolutionError(
          signal.aborted ? (this.now() >= this.deadline ? 'TimeBudgetExceeded' : 'Timeout') : 'TransportError');
        if (!['UpstreamUnavailable', 'Timeout', 'TransportError'].includes(error.code) || attempt === 1) throw error;
        this.nextRequest = this.now() + Math.max(this.intervalMs, 1500);
      }
    }
  }

  async feed(query) {
    const response = await this.request(rssUrl(query), { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (response.status !== 200) throw new ResolutionError('FeedRedirect', undefined, { status: response.status });
    return parseRss(response.bytes.toString('utf8'));
  }

  async resolve(rssLink, locale) {
    const id = googleArticleId(rssLink);
    if (!id) {
      const direct = publisherUrl(rssLink);
      if (direct) return { publisherUrl: direct, method: 'direct' };
      throw new ResolutionError('InvalidArticleUrl');
    }
    const page = new URL(`https://news.google.com/rss/articles/${id}`);
    page.search = new URLSearchParams({ hl: locale.language, gl: locale.country, ceid: locale.edition });
    let current = page, response;
    for (let hop = 0; hop <= 5; hop++) {
      response = await this.request(current, { headers: { Accept: 'text/html' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new ResolutionError('InvalidRedirect');
      let next;
      try { next = new URL(location, current); } catch { throw new ResolutionError('InvalidRedirect'); }
      const direct = publisherUrl(next.href);
      if (direct) return { publisherUrl: direct, method: 'redirect' };
      if (/\/sorry(?:\/|$)/.test(next.pathname) && /(^|\.)google\.com$/.test(next.hostname)) throw new ResolutionError('GoogleChallenge');
      if (hop === 5) throw new ResolutionError('RedirectLimitExceeded');
      current = next;
    }
    if (current.hostname === 'consent.google.com') throw new ResolutionError('GoogleConsentRequired');
    if (response.status !== 200) throw new ResolutionError('HTTPError', undefined, { status: response.status });
    const html = response.bytes.toString('utf8');
    if (/\/sorry\/|id=["']captcha|unusual traffic/i.test(html)) throw new ResolutionError('GoogleChallenge');
    const params = decodingParameters(html, id);
    const decoded = await this.request('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je&rt=b', {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Origin: 'https://news.google.com', Referer: 'https://news.google.com/', 'X-Same-Domain': '1',
      }, body: rpcForm(id, params, locale.edition),
    });
    if (decoded.status !== 200) throw new ResolutionError('HTTPDecodeFailed', undefined, { status: decoded.status });
    return { publisherUrl: parseRpcResponse(decoded.bytes), method: 'rpc' };
  }
}
