// Turns a Leonardo / Freepik / Magnific link into the actual image file.

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

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

async function readLimited(res, limit) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('התמונה גדולה מדי');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new Error('התמונה גדולה מדי');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Pulls candidate image URLs out of a page's HTML, best candidates first. */
export function imageUrlsFromHtml(html, pageUrl) {
  const candidates = [];
  const add = (u) => {
    if (!u) return;
    try {
      const abs = new URL(decodeEntities(u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/')), pageUrl).toString();
      if (parseHttpUrl(abs) && !candidates.includes(abs)) candidates.push(abs);
    } catch {
      /* ignore malformed */
    }
  };

  // 1. Social-preview meta tags: this is the main image of the page.
  const metaNames = ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (metaNames.includes(key)) add(/content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
  }
  candidates.sort((a, b) => rankMeta(a) - rankMeta(b));

  // 2. Direct image URLs in the page source / embedded JSON (e.g. cdn.leonardo.ai/...jpg).
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  for (const m of unescaped.matchAll(/https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi)) {
    add(m[0]);
  }
  return candidates;
}

// Prefer real image files over generic site banners.
function rankMeta(u) {
  return IMAGE_EXT.test(new URL(u).pathname) ? 0 : 1;
}

/** Renders the page in a headless browser (for pages built with JavaScript). */
async function imageUrlsWithBrowser(pageUrl) {
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
    // Every image the page downloads, with its size: the generated image is usually the biggest.
    const loaded = [];
    page.on('response', async (response) => {
      const type = response.headers()['content-type'] || '';
      if (!type.startsWith('image/') || type.includes('svg')) return;
      const size = await response.body().then((b) => b.length).catch(() => 0);
      loaded.push({ url: response.url(), size });
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.fetchTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const html = await page.content();
    // Largest visible image on the page.
    const biggest = await page.evaluate(() =>
      [...document.images]
        .map((img) => ({ src: img.currentSrc || img.src, area: img.naturalWidth * img.naturalHeight }))
        .sort((a, b) => b.area - a.area)
        .map((i) => i.src),
    );
    const fromHtml = imageUrlsFromHtml(html, pageUrl);
    const fromNetwork = loaded.sort((a, b) => b.size - a.size).map((i) => i.url);
    return [...new Set([...fromHtml.slice(0, 1), ...fromNetwork.slice(0, 3), ...biggest, ...fromHtml.slice(1)])]
      .filter((u) => parseHttpUrl(u));
  } finally {
    await browser.close();
  }
}

async function downloadImage(url) {
  const { res, finalUrl } = await safeFetch(url, 'image/avif,image/webp,image/*,*/*;q=0.8', true);
  if (!res.ok) throw new Error(`השרת החזיר שגיאה ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return null;
  const content = await readLimited(res, config.maxImageBytes);
  return { content, contentType: type, filename: filenameFor(finalUrl, type), sourceUrl: finalUrl };
}

function filenameFor(url, type) {
  let base = path.basename(new URL(url).pathname) || 'image';
  base = base.replace(/[^\w.\-]+/g, '_').slice(-80).replace(IMAGE_EXT, '') || 'image';
  return base + (CONTENT_TYPE_EXT[type] || '.jpg');
}

/**
 * Main entry: given a link someone sent, returns { filename, content, contentType, sourceUrl }.
 * Throws an Error with a (Hebrew) user-facing message if no image could be found.
 */
export async function getImageFromLink(link) {
  // The link might already be a direct image.
  const { res, finalUrl } = await safeFetch(link, 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

  if (res.ok && type.startsWith('image/')) {
    const content = await readLimited(res, config.maxImageBytes);
    return { content, contentType: type, filename: filenameFor(finalUrl, type), sourceUrl: finalUrl };
  }

  let candidates = [];
  if (res.ok && type.includes('html')) {
    candidates = imageUrlsFromHtml(await readLimited(res, 5 * 1024 * 1024).then(String), finalUrl);
  } else {
    res.body?.cancel().catch(() => {});
  }

  const tried = new Set();
  const tryCandidates = async (list) => {
    for (const url of list) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const img = await downloadImage(url);
        if (img) return img;
      } catch {
        /* try the next one */
      }
    }
    return null;
  };

  const direct = await tryCandidates(candidates.slice(0, 8));
  if (direct) return direct;

  // Page blocked us, or the image only appears after JavaScript runs.
  const rendered = await tryCandidates((await imageUrlsWithBrowser(finalUrl).catch(() => [])).slice(0, 8));
  if (rendered) return rendered;

  if (!res.ok) throw new Error(`האתר חסם את הגישה או שהקישור לא תקין (קוד ${res.status})`);
  throw new Error('לא נמצאה תמונה בקישור');
}
