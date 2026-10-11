// Turns a Leonardo / Freepik / Magnific link into the actual image or video file.

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

/** Is this link on one of the supported sites (Leonardo, Freepik, Magnific...)? */
export function isAllowedUrl(url) {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  return config.allowedDomains.some((d) => host === d || host.endsWith('.' + d));
}

// Internal / private network addresses: never fetched (protects the server's own network).
const privateRanges = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
]) privateRanges.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  privateRanges.addSubnet(addr, prefix, 'ipv6');
}

async function isPublicHost(hostname) {
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
 * Links people send must be on a supported site. The image those pages point to may live on
 * another CDN, so for images any public host is fine.
 */
async function checkUrl(url, anyPublicHost) {
  const u = parseHttpUrl(url);
  if (!u) throw new Error('קישור לא תקין');
  if (isAllowedUrl(url)) return;
  if (anyPublicHost && (await isPublicHost(u.hostname))) return;
  throw new Error(`הקישור מפנה לאתר לא מורשה: ${u.hostname}`);
}

/** Finds all allowed links in the plain-text and HTML parts of an email. */
export function findLinks(text = '', html = '') {
  const found = new Set();
  const urlRegex = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;

  for (const m of String(html).matchAll(hrefRegex)) found.add(decodeEntities(m[1]));
  for (const m of `${text}\n${html}`.matchAll(urlRegex)) found.add(decodeEntities(m[0]));

  const links = [];
  for (let link of found) {
    link = link.replace(/[.,;:!?]+$/, ''); // trailing punctuation from the sentence
    if (isAllowedUrl(link) && !links.includes(link)) links.push(link);
  }
  return links.slice(0, config.maxLinksPerEmail);
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
export function mediaUrlsFromHtml(html, pageUrl) {
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

  // 2. Direct file URLs in the page source / embedded JSON (e.g. cdn.leonardo.ai/...jpg).
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const fileUrl = /https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif|mp4|webm|mov|m4v)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of unescaped.matchAll(fileUrl)) {
    add(VIDEO_EXT.test(new URL(m[0]).pathname) ? videos : images, m[0]);
  }
  // A video's thumbnail is also an image on the page, so the video comes first.
  return [...videos, ...images];
}

function rankByExt(u) {
  return MEDIA_EXT.test(new URL(u).pathname) ? 0 : 1;
}

/** Renders the page in a headless browser (for pages built with JavaScript). */
async function mediaUrlsWithBrowser(pageUrl) {
  if (!config.useBrowserFallback) return [];
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return []; // Playwright is optional
  }
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
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
    const html = await page.content();
    const onPage = await page.evaluate(() => ({
      videos: [...document.querySelectorAll('video, video source')].map((v) => v.currentSrc || v.src),
      // Largest visible image first.
      images: [...document.images]
        .map((img) => ({ src: img.currentSrc || img.src, area: img.naturalWidth * img.naturalHeight }))
        .sort((a, b) => b.area - a.area)
        .map((i) => i.src),
    }));
    const fromHtml = mediaUrlsFromHtml(html, pageUrl);
    const bySize = loaded.sort((a, b) => b.size - a.size);
    const netVideos = bySize.filter((i) => i.video).map((i) => i.url);
    const netImages = bySize.filter((i) => !i.video).map((i) => i.url);
    return [...new Set([
      ...onPage.videos, ...netVideos, ...fromHtml.slice(0, 1), ...netImages.slice(0, 3), ...onPage.images,
      ...fromHtml.slice(1),
    ])].filter((u) => parseHttpUrl(u)); // skips blob: streams
  } finally {
    await browser.close();
  }
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

/**
 * Main entry: given a link someone sent, returns
 * { filename, contentType, sourceUrl, content } or { ..., tooLarge: true } for a file too big to attach.
 * Throws an Error with a (Hebrew) user-facing message if nothing could be found.
 */
export async function getMediaFromLink(link) {
  // The link might already be a direct image / video.
  const { res, finalUrl } = await safeFetch(link, 'text/html,application/xhtml+xml,video/*,image/*;q=0.9,*/*;q=0.8');
  const type = contentTypeOf(res);
  if (res.ok && isMediaType(type)) return toResult(res, finalUrl, type);

  if (LOGIN_PAGE.test(new URL(finalUrl).pathname) && !LOGIN_PAGE.test(new URL(link).pathname)) {
    res.body?.cancel().catch(() => {});
    throw new Error(PRIVATE_MESSAGE);
  }

  let candidates = [];
  if (res.ok && type.includes('html')) {
    candidates = mediaUrlsFromHtml(String(await readLimited(res, 5 * 1024 * 1024)), finalUrl);
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

  const direct = await tryCandidates(candidates.slice(0, 8));
  if (direct) return direct;

  // Page blocked us, or the file only appears after JavaScript runs.
  const fromBrowser = await mediaUrlsWithBrowser(finalUrl).catch((err) => {
    if (err.message === PRIVATE_MESSAGE) throw err;
    console.error('browser fallback failed:', err.message);
    return [];
  });
  const rendered = await tryCandidates(fromBrowser.slice(0, 8));
  if (rendered) return rendered;

  if (!res.ok) throw new Error(`האתר חסם את הגישה או שהקישור לא תקין (קוד ${res.status})`);
  throw new Error('לא נמצאו תמונה או סרטון בקישור');
}
