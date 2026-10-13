// Turns a link someone emailed (Leonardo, Freepik, a shared ChatGPT / Gemini chat, any page...)
// into the actual image / video files.

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|mp4|webm|mov|m4v)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const isMediaType = (type) => (type.startsWith('image/') && !type.includes('svg')) || type.startsWith('video/');
const contentTypeOf = (res) => (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

// A link that lands on a login page means the image/video is private.
const LOGIN_PAGE = /\/(login|log-in|signin|sign-in|signup|sign-up|auth)\b/i;
const PRIVATE_MESSAGE = 'הקישור מוביל לדף התחברות: כנראה שהתמונה/הסרטון פרטיים. שלחו קישור שיתוף ציבורי';

function parseHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

const hostIn = (host, domains) => domains.some((d) => host === d || host.endsWith('.' + d));

/** Is this a link the bot handles (any site, or one of ALLOWED_DOMAINS)? */
export function isAllowedUrl(url) {
  const u = parseHttpUrl(url);
  if (!u) return false;
  return config.anySite || hostIn(u.hostname.toLowerCase(), config.allowedDomains);
}

const isChatShare = (url) => hostIn(new URL(url).hostname.toLowerCase(), config.chatShareHosts);

// Internal / private network addresses: never fetched (protects the server's own network).
const privateRanges = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
]) privateRanges.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  privateRanges.addSubnet(addr, prefix, 'ipv6');
}

const publicHostCache = new Map();

async function isPublicHost(hostname) {
  if (!publicHostCache.has(hostname)) {
    publicHostCache.set(hostname, lookupIsPublic(hostname));
    setTimeout(() => publicHostCache.delete(hostname), 10 * 60 * 1000).unref();
  }
  return publicHostCache.get(hostname);
}

async function lookupIsPublic(hostname) {
  try {
    const addrs = await dns.lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
    return addrs.length > 0 && addrs.every(({ address, family }) => {
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
      if (mapped) return !privateRanges.check(mapped[1], 'ipv4');
      return !privateRanges.check(address, family === 6 ? 'ipv6' : 'ipv4');
    });
  } catch {
    return false;
  }
}

/**
 * Links must be handled sites (see isAllowedUrl); a page's image may live on another CDN, so for
 * images any public host is fine. Nothing on a private / internal network is ever fetched, except
 * domains explicitly listed in ALLOWED_DOMAINS.
 */
async function checkUrl(url, anyPublicHost) {
  const u = parseHttpUrl(url);
  if (!u) throw new Error('קישור לא תקין');
  const host = u.hostname.toLowerCase();
  if (!config.anySite && hostIn(host, config.allowedDomains)) return;
  if ((anyPublicHost || config.anySite) && (await isPublicHost(host))) return;
  throw new Error(`הקישור מפנה לאתר לא מורשה: ${u.hostname}`);
}

/** Removes the quoted earlier messages from a reply, so links from old emails are not re-sent. */
function stripQuotedText(text) {
  const lines = String(text).split(/\r?\n/);
  const cut = lines.findIndex((line) => {
    const l = line.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim(); // Gmail wraps Hebrew in direction marks
    return /^(On .+ wrote:|בתאריך .+:|-{2,}\s*Original Message\s*-{2,}|-{5,}\s*Forwarded message)/i.test(l);
  });
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.trimStart().startsWith('>')).join('\n');
}

function stripQuotedHtml(html) {
  return String(html)
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[\s\S]*$/i, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
}

/** Finds the links in the new (non-quoted) part of an email. */
export function findLinks(text = '', html = '') {
  const found = new Set();
  const urlRegex = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  const ownText = stripQuotedText(text);
  const ownHtml = stripQuotedHtml(html);

  for (const m of ownHtml.matchAll(hrefRegex)) found.add(decodeEntities(m[1]));
  for (const m of `${ownText}\n${ownHtml}`.matchAll(urlRegex)) found.add(decodeEntities(m[0]));

  const links = [];
  for (let link of found) {
    link = link.replace(/[.,;:!?]+$/, ''); // trailing punctuation from the sentence
    if (isAllowedUrl(link) && !links.includes(link)) links.push(link);
  }
  return links.slice(0, config.maxLinksPerEmail);
}

/** Turns share links of file-hosting sites into direct downloads of the original file. */
export function directDownloadUrl(link) {
  const u = new URL(link);
  const host = u.hostname.toLowerCase();
  // Google Drive: /file/d/ID/view, /open?id=ID, /uc?id=ID
  if (host === 'drive.google.com') {
    const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] || u.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  }
  // Dropbox: ?dl=0 shows a page, ?dl=1 downloads the file.
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return link;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');
}

/** fetch() that checks every redirect hop as well. */
async function safeFetch(url, accept, anyPublicHost = false) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(current, anyPublicHost);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9,he;q=0.8' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('יותר מדי הפניות (redirects)');
}

class TooLargeError extends Error {}

async function readLimited(res, limit) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) {
    res.body?.cancel().catch(() => {});
    throw new TooLargeError('הקובץ גדול מדי');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new TooLargeError('הקובץ גדול מדי');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Pulls candidate image/video URLs out of a page's HTML, best candidates first. */
export function mediaUrlsFromHtml(html, pageUrl, { metaOnly = false } = {}) {
  const videos = [];
  const images = [];
  const add = (list, u) => {
    if (!u) return;
    try {
      const abs = new URL(decodeEntities(u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/')), pageUrl).toString();
      if (parseHttpUrl(abs) && !list.includes(abs)) list.push(abs);
    } catch {
      /* ignore malformed */
    }
  };

  // 1. Social-preview meta tags: the main video / image of the page.
  const videoMeta = ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream'];
  const imageMeta = ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (videoMeta.includes(key)) add(videos, content);
    if (imageMeta.includes(key)) add(images, content);
  }
  // Prefer real files over generic site banners.
  images.sort((a, b) => rankByExt(a) - rankByExt(b));

  if (metaOnly) return [...videos, ...images];

  // 2. Direct file URLs in the page source / embedded JSON (e.g. cdn.leonardo.ai/...jpg).
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const fileUrl = /https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif|mp4|webm|mov|m4v)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of unescaped.matchAll(fileUrl)) {
    add(VIDEO_EXT.test(new URL(m[0]).pathname) ? videos : images, m[0]);
  }
  // A video's thumbnail is also an image on the page, so the video comes first.
  return [...videos, ...images];
}

/** Only the page's own declared main media (og:video / og:image meta tags). */
function metaMediaUrls(html, pageUrl) {
  return mediaUrlsFromHtml(html, pageUrl, { metaOnly: true });
}

/**
 * The identifiers in a link (e.g. "sSEWcE8l8e" in /app/creation/sSEWcE8l8e, the UUID at the end of a
 * Leonardo link, "1234567" in a Freepik ..._1234567.htm). An image whose address contains one of them
 * is the image the link points to, not some other picture on the same page.
 */
export function linkIds(link) {
  const u = new URL(link);
  const text = decodeURIComponent(u.pathname + ' ' + [...u.searchParams.values()].join(' '));
  const ids = new Set();
  for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) ids.add(m[0]);
  for (const token of text.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, ' ').split(/[^A-Za-z0-9]+/)) {
    if (/^\d{5,}$/.test(token)) ids.add(token); // numeric ids
    else if (token.length >= 8 && /\d/.test(token) && /[a-z]/i.test(token)) ids.add(token); // e.g. sSEWcE8l8e
  }
  return [...ids].map((id) => id.toLowerCase());
}

const matchesId = (url, ids) => {
  let u = url.toLowerCase();
  try {
    u = decodeURIComponent(u);
  } catch {
    /* keep as is */
  }
  return ids.some((id) => u.includes(id));
};

function rankByExt(u) {
  return MEDIA_EXT.test(new URL(u).pathname) ? 0 : 1;
}

const BLOCKED_MESSAGE = 'האתר חסם את הבוט (בדיקת "האם אתה רובוט"), אי אפשר להוריד ממנו אוטומטית';

/**
 * Opens the page in a headless browser (for pages built with JavaScript) and calls fn(page, loaded)
 * once it has loaded. `loaded` lists every image / video the page downloaded, with its size.
 * Returns null when no browser is available.
 */
async function withBrowserPage(pageUrl, fn, { scroll = false } = {}) {
  if (!config.useBrowserFallback) return null;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null; // Playwright is optional
  }
  // Each browser takes a few hundred MB of memory, so only a couple run at once.
  while (openBrowsers >= MAX_BROWSERS) await new Promise((r) => setTimeout(r, 200));
  openBrowsers++;
  try {
    return await renderPage(chromium, pageUrl, fn, scroll);
  } finally {
    openBrowsers--;
  }
}

const MAX_BROWSERS = 2;
let openBrowsers = 0;

async function renderPage(chromium, pageUrl, fn, scroll) {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT, viewport: { width: 1280, height: 1600 } });
    // The page itself must not reach the server's internal network either.
    await page.route('**/*', async (route) => {
      const u = parseHttpUrl(route.request().url());
      if (!u) return route.continue(); // data:, blob:
      const host = u.hostname.toLowerCase();
      const ok = (!config.anySite && hostIn(host, config.allowedDomains)) || (await isPublicHost(host));
      return ok ? route.continue() : route.abort();
    });
    // Every image / video the page downloads, with its size: the generated one is usually the biggest.
    const loaded = [];
    page.on('response', async (response) => {
      const headers = response.headers();
      const type = (headers['content-type'] || '').toLowerCase();
      if (!isMediaType(type)) return;
      const total = Number(/\/(\d+)$/.exec(headers['content-range'] || '')?.[1] || headers['content-length'] || 0);
      const size = total || (await response.body().then((b) => b.length).catch(() => 0));
      loaded.push({ url: response.url(), size, video: type.startsWith('video/') });
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.fetchTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (LOGIN_PAGE.test(new URL(page.url()).pathname) && !LOGIN_PAGE.test(new URL(pageUrl).pathname)) {
      throw new Error(PRIVATE_MESSAGE);
    }
    if (/just a moment|attention required|verify you are human/i.test(await page.title())) {
      throw new Error(BLOCKED_MESSAGE);
    }
    // Chats: scroll through so lazy-loaded images further down load too. Not for single-image pages:
    // scrolling there loads "more like this" pictures that are not the one the link points to.
    if (scroll) await page.evaluate(async () => {
      // Chat sites scroll an inner box, not the window, so both are scrolled.
      const boxes = [...document.querySelectorAll('*')].filter(
        (el) => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY),
      );
      for (let i = 0; i < 20; i++) {
        let moved = false;
        const y = window.scrollY;
        window.scrollBy(0, window.innerHeight);
        moved ||= window.scrollY !== y;
        for (const el of boxes) {
          const top = el.scrollTop;
          el.scrollTop += el.clientHeight;
          moved ||= el.scrollTop !== top;
        }
        await new Promise((r) => setTimeout(r, 250));
        if (!moved) break;
      }
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return await fn(page, loaded);
  } finally {
    await browser.close();
  }
}

/**
 * Candidate URLs for the page's main image / video, found by rendering it, best first:
 * files whose address contains the link's id, then the page's declared main media, then what is
 * shown biggest on the opening screen (the main picture, not thumbnails further down).
 */
async function mediaUrlsWithBrowser(pageUrl, ids) {
  const urls = await withBrowserPage(pageUrl, async (page, loaded) => {
    const html = await page.content();
    const onScreen = await page.evaluate(() => {
      const visibleArea = (el) => {
        const r = el.getBoundingClientRect();
        const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
        return r.width >= 150 && r.height >= 150 && w > 0 && h > 0 ? w * h : 0;
      };
      const pick = (els, src) =>
        els
          .map((el) => ({ src: src(el), area: visibleArea(el) }))
          .filter((i) => i.src && i.area > 0)
          .sort((a, b) => b.area - a.area)
          .map((i) => i.src);
      return {
        videos: pick([...document.querySelectorAll('video')], (v) => v.currentSrc || v.src || v.querySelector('source')?.src),
        images: pick([...document.images], (img) => img.currentSrc || img.src),
        all: [...document.querySelectorAll('img, video, video source')].map((el) => el.currentSrc || el.src),
      };
    });
    const everything = [...mediaUrlsFromHtml(html, pageUrl), ...onScreen.all, ...loaded.map((i) => i.url)];
    return [
      ...everything.filter((u) => matchesId(u, ids)),
      ...metaMediaUrls(html, pageUrl),
      ...onScreen.videos,
      ...onScreen.images.slice(0, 2),
    ];
  });
  return [...new Set(urls || [])].filter((u) => parseHttpUrl(u)); // skips blob: streams
}

/**
 * For shared AI chats: every generated image / video in the conversation, in order.
 * Small pictures (avatars, icons) are skipped.
 */
async function allMediaWithBrowser(pageUrl) {
  return withBrowserPage(pageUrl, async (page) => {
    const urls = await page.evaluate(() => {
      const out = [];
      // Pictures the user uploaded into the chat are not what they want back.
      const userMessage =
        '[data-message-author-role="user"], user-query, .user-query, [data-testid="user-message"], .font-user-message';
      for (const el of document.querySelectorAll('img, video')) {
        if (el.closest(userMessage)) continue;
        if (el.tagName === 'VIDEO') {
          const src = el.currentSrc || el.src || el.querySelector('source')?.src;
          if (src) out.push(src);
        } else if (el.naturalWidth >= 256 && el.naturalHeight >= 256) {
          out.push(el.currentSrc || el.src);
        }
      }
      return out;
    });
    const results = [];
    const seen = new Set();
    for (const url of urls) {
      if (results.length >= config.maxFilesPerLink) break;
      if (!parseHttpUrl(url) || seen.has(url)) continue; // skips blob: / data:
      seen.add(url);
      const media =
        (await downloadMedia(fullSizeUrl(url)).catch(() => null)) ||
        (await downloadMedia(url).catch(() => null)) ||
        // Some chat sites only serve the file to the browser session that opened the chat.
        (await downloadWithBrowser(page, url).catch(() => null));
      if (media && !results.some((m) => m.sourceUrl === media.sourceUrl)) results.push(media);
    }
    return results;
  }, { scroll: true });
}

// Google image URLs carry a size suffix (…=w512-h512); "=s0" asks for the original size.
function fullSizeUrl(url) {
  const u = new URL(url);
  if (/(^|\.)googleusercontent\.com$/i.test(u.hostname) && /=[\w-]+$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/=[\w-]+$/, '=s0');
    return u.toString();
  }
  return url;
}

async function downloadWithBrowser(page, url) {
  await checkUrl(url, true);
  // No redirects: each hop would otherwise skip the internal-network check.
  const res = await page.context().request.get(url, { timeout: config.fetchTimeoutMs, maxRedirects: 0 });
  const type = (res.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!res.ok() || !isMediaType(type)) return null;
  const base = { contentType: type, filename: filenameFor(url, type), sourceUrl: url };
  const content = await res.body();
  return content.length > config.maxFileBytes ? { ...base, tooLarge: true } : { ...base, content };
}

async function downloadMedia(url) {
  const { res, finalUrl } = await safeFetch(url, 'video/*,image/avif,image/webp,image/*,*/*;q=0.8', true);
  if (!res.ok) throw new Error(`השרת החזיר שגיאה ${res.status}`);
  const type = contentTypeOf(res);
  if (!isMediaType(type)) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  return toResult(res, finalUrl, type);
}

/** Reads the file; one that is too big for an email comes back as a link only. */
async function toResult(res, finalUrl, type) {
  const base = { contentType: type, filename: filenameFor(finalUrl, type), sourceUrl: finalUrl };
  try {
    return { ...base, content: await readLimited(res, config.maxFileBytes) };
  } catch (err) {
    if (err instanceof TooLargeError) return { ...base, tooLarge: true };
    throw err;
  }
}

function filenameFor(url, type) {
  let base = path.basename(new URL(url).pathname) || 'file';
  base = base.replace(/[^\w.\-]+/g, '_').slice(-80).replace(MEDIA_EXT, '') || 'file';
  return base + (CONTENT_TYPE_EXT[type] || (type.startsWith('video/') ? '.mp4' : '.jpg'));
}

const browserErrors = new Set([PRIVATE_MESSAGE, BLOCKED_MESSAGE]);

/**
 * Main entry: given a link someone sent, returns a list of files, each
 * { filename, contentType, sourceUrl, content } or { ..., tooLarge: true } for a file too big to attach.
 * Throws an Error with a (Hebrew) user-facing message if nothing could be found.
 */
export async function getMediaFromLink(link) {
  await checkUrl(link, false);
  if (isChatShare(link)) {
    const all = await allMediaWithBrowser(link);
    if (all === null) throw new Error('צריך דפדפן כדי לפתוח שיחות משותפות, והוא לא מותקן בשרת');
    if (!all.length) throw new Error('לא נמצאו תמונות או סרטונים בשיחה (ייתכן שהשיתוף לא כולל אותם)');
    return all;
  }
  const one = await getMainMedia(directDownloadUrl(link));
  return [one];
}

/** The main image / video behind a link (direct file, page meta tags, or the rendered page). */
async function getMainMedia(link) {
  // The link might already be a direct image / video.
  const { res, finalUrl } = await safeFetch(link, 'text/html,application/xhtml+xml,video/*,image/*;q=0.9,*/*;q=0.8');
  const type = contentTypeOf(res);
  if (res.ok && isMediaType(type)) return toResult(res, finalUrl, type);

  if (LOGIN_PAGE.test(new URL(finalUrl).pathname) && !LOGIN_PAGE.test(new URL(link).pathname)) {
    res.body?.cancel().catch(() => {});
    throw new Error(PRIVATE_MESSAGE);
  }

  const ids = linkIds(link);
  let fromSource = [];
  let fromMeta = [];
  if (res.ok && type.includes('html')) {
    const html = String(await readLimited(res, 5 * 1024 * 1024));
    fromSource = mediaUrlsFromHtml(html, finalUrl);
    fromMeta = metaMediaUrls(html, finalUrl);
  } else {
    res.body?.cancel().catch(() => {});
  }

  const tried = new Set();
  const tryCandidates = async (list) => {
    for (const url of list) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const media = await downloadMedia(url);
        if (media) return media;
      } catch {
        /* try the next one */
      }
    }
    return null;
  };

  // 1. A file whose address contains the link's id, 2. the page's declared main image / video.
  const direct = await tryCandidates([...fromSource.filter((u) => matchesId(u, ids)), ...fromMeta].slice(0, 8));
  if (direct) return direct;

  // 3. Page blocked us, or the file only appears after JavaScript runs.
  const fromBrowser = await mediaUrlsWithBrowser(finalUrl, ids).catch((err) => {
    if (browserErrors.has(err.message)) throw err;
    console.error('browser fallback failed:', err.message);
    return [];
  });
  const rendered = await tryCandidates(fromBrowser.slice(0, 8));
  if (rendered) return rendered;

  // 4. Last resort (no browser available): any other image / video named in the page source.
  const other = await tryCandidates(fromSource.slice(0, 8));
  if (other) return other;

  if (!res.ok) throw new Error(`האתר חסם את הגישה או שהקישור לא תקין (קוד ${res.status})`);
  throw new Error('לא נמצאו תמונה או סרטון בקישור');
}
