// Turns a link someone emailed (Leonardo, Freepik, a shared ChatGPT / Gemini chat, any page...)
// into the actual image / video files.

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { report } from './progress.js';
import { hasFfmpeg, shrinkVideoFile, streamToMp4, withTempDir } from './video.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|mp4|webm|mov|m4v|m3u8)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|m3u8)$/i;
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
// Streamed video: an HLS playlist pointing at many small pieces.
const isStream = (type, url = '') => /mpegurl/i.test(type) || /\.m3u8($|\?)/i.test(url);
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

// Invisible direction marks that Gmail and Outlook put around Hebrew text.
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Where the quoted earlier messages start in the plain-text part of a reply (Gmail / Apple / Outlook,
// English and Hebrew). A header may be wrapped over several lines when the sender's name is long.
const TEXT_QUOTE_STARTS = [
  /^On\s[\s\S]{0,400}?\swrote:[ \t]*$/m, // Gmail / Apple: "On Mon, ... Name <a@b> wrote:"
  /^בתאריך\s[\s\S]{0,400}?:[ \t]*$/m, // Gmail in Hebrew: "בתאריך יום ה׳, ... מאת Name <a@b>:"
  /^-{2,}\s*(Original Message|הודעה מקורית)\s*-{2,}/im,
  /^_{10,}[ \t]*$/m, // Outlook separator line
  /^(From|מאת):[^\n]*\n(?:[^\n]*\n){0,3}?(Sent|Date|נשלח|תאריך):/m, // Outlook header block
];
const TEXT_FORWARD_STARTS = [
  /^-{3,}\s*(Forwarded message|הודעה שהועברה)\s*-{3,}/im,
  /^Begin forwarded message:/im,
];

// Where the quoted earlier messages start in the HTML part.
const HTML_QUOTE_STARTS = [
  /<div[^>]*class=["'][^"']*gmail_quote/i, // Gmail (also wraps forwarded messages)
  /<blockquote/i, // Apple Mail, Thunderbird, most others
  /<div[^>]*id=["'](divRplyFwdMsg|appendonsend)/i, // Outlook
  /<hr[^>]*id=["']stopSpelling/i, // Outlook.com
  /<div[^>]*class=["'][^"']*(moz-cite-prefix|yahoo_quoted|OutlookMessageHeader)/i, // Thunderbird / Yahoo / Outlook
  /<div[^>]*style=["'][^"']*border-top:\s*solid\s*#E1E1E1/i, // Outlook desktop header block
];

/** Everything before the earliest of the given markers. */
function cutAtFirst(content, markers) {
  let cut = content.length;
  for (const marker of markers) {
    const m = marker.exec(content);
    if (m && m.index < cut) cut = m.index;
  }
  return content.slice(0, cut);
}

/** Removes the quoted earlier messages from a reply, so links from old emails are not re-sent. */
export function stripQuotedText(text) {
  const clean = String(text).replace(BIDI_MARKS, '');
  return cutAtFirst(clean, [...TEXT_QUOTE_STARTS, ...TEXT_FORWARD_STARTS])
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
}

function stripQuotedHtml(html) {
  return cutAtFirst(String(html), HTML_QUOTE_STARTS);
}

/** Is this email a forward (where the forwarded message itself is what the sender wants processed)? */
function isForward(text, subject) {
  return /^(fwd?|fw|הועבר)\s*:/i.test(String(subject).trim()) ||
    TEXT_FORWARD_STARTS.some((m) => m.test(String(text).replace(BIDI_MARKS, '')));
}

/** Finds the links in the new (non-quoted) part of an email. */
export function findLinks(text = '', html = '', subject = '') {
  // A reply's subject ("Re: ...") repeats an earlier subject, so its links are not new.
  const freshSubject = /^(re|תגובה)\s*:/i.test(subject.trim())
    ? ''
    : subject.trim().replace(/^(fwd?|fw|הועבר)\s*:\s*/i, '');
  const own = collectLinks(`${freshSubject}\n${stripQuotedText(text)}`, stripQuotedHtml(html));
  // A forward with nothing added: the links are in the forwarded message itself.
  if (!own.length && isForward(text, subject)) return collectLinks(String(text).replace(BIDI_MARKS, ''), html);
  return own;
}

// People often paste the link into the subject line and leave the body empty, so the caller passes it.
function collectLinks(ownText, ownHtml) {
  const found = new Set();
  const urlRegex = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;

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
async function safeFetch(url, accept, anyPublicHost = false, timeoutMs = config.fetchTimeoutMs) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(current, anyPublicHost);
    const res = await fetch(current, {
      redirect: 'manual',
      // Covers reading the body too, so file downloads get a longer limit.
      signal: AbortSignal.timeout(timeoutMs),
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
  const fileUrl = /https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif|mp4|webm|mov|m4v|m3u8)(?:\?[^\s"'<>\\)]*)?/gi;
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
  report('browser');
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
      if (isStream(type, response.url())) return loaded.push({ url: response.url(), size: Infinity, video: true });
      if (!isMediaType(type)) return;
      // Pieces of a stream are not whole videos.
      if (/mp2t|iso\.segment/.test(type) || /\.(ts|m4s)($|\?)/i.test(response.url())) return;
      const total = Number(/\/(\d+)$/.exec(headers['content-range'] || '')?.[1] || headers['content-length'] || 0);
      const size = total || (await response.body().then((b) => b.length).catch(() => 0));
      loaded.push({ url: response.url(), size, video: type.startsWith('video/') });
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.fetchTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (LOGIN_PAGE.test(new URL(page.url()).pathname) && !LOGIN_PAGE.test(new URL(pageUrl).pathname)) {
      throw new Error(PRIVATE_MESSAGE);
    }
    // Google's cookie-consent screen (shown to visitors without cookies): accept and continue.
    if (/^consent\./.test(new URL(page.url()).hostname)) {
      const button = page.locator('button, input[type=submit]').filter({
        hasText: /reject all|accept all|דחיית הכול|דחה הכול|אישור הכול|קבל הכול/i,
      });
      if (await button.count()) {
        await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), button.first().click()]);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }
    }
    if (/\/sorry\//.test(new URL(page.url()).pathname) ||
        /just a moment|attention required|verify you are human|unusual traffic/i.test(await page.title())) {
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
  } catch (err) {
    // What the bot saw, for the reply email and the log.
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      err.screenshot ??= await page.screenshot({ timeout: 10000 }).catch(() => null);
      err.diagnostics ??= await describePage(page).catch(() => '');
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function describePage(page) {
  const info = await page.evaluate(() => ({
    title: document.title,
    images: document.images.length,
    bigImages: [...document.images].filter((i) => i.naturalWidth >= 256 && i.naturalHeight >= 256).length,
    videos: [...document.querySelectorAll('video')].map((v) => (v.currentSrc || v.src || '(no src)').slice(0, 120)),
  }));
  return `page=${page.url().slice(0, 150)} title="${info.title.slice(0, 80)}" images=${info.images} ` +
    `big=${info.bigImages} videos=${JSON.stringify(info.videos.slice(0, 5))}`;
}

/** Some pages show a video only as a poster with a play button until it is clicked. */
async function startVideos(page) {
  const played = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) =>
      /(^|\b)(play|הפעל|הפעלה)/i.test(b.getAttribute('aria-label') || b.title || ''),
    );
    buttons.slice(0, 10).forEach((b) => b.click());
    document.querySelectorAll('video').forEach((v) => {
      v.muted = true;
      v.play?.().catch(() => {});
    });
    return buttons.length + document.querySelectorAll('video').length;
  });
  if (played) await page.waitForTimeout(2000);
}

/**
 * Candidate URLs for the page's main image / video, found by rendering it, best first:
 * files whose address contains the link's id, then the page's declared main media, then what is
 * shown biggest on the opening screen (the main picture, not thumbnails further down).
 */
async function mainMediaWithBrowser(pageUrl, ids, { videoOnly, tried }) {
  return withBrowserPage(pageUrl, async (page, loaded) => {
    if (videoOnly) await startVideos(page);
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
        // A prominent player whose source is a blob: stream (the file is then found in the network log).
        blobVideo: [...document.querySelectorAll('video')].some(
          (v) => /^blob:/.test(v.currentSrc || v.src) && visibleArea(v) > 0,
        ),
        all: [...document.querySelectorAll('img, video, video source')].map((el) => el.currentSrc || el.src),
      };
    });
    const everything = [...mediaUrlsFromHtml(html, pageUrl), ...onScreen.all, ...loaded.map((i) => i.url)];
    // Videos the page loaded in the background (often the real file behind a blob: player), biggest first.
    const netVideos = loaded.filter((i) => i.video).sort((a, b) => b.size - a.size).map((i) => i.url);
    const candidates = [...new Set([
      ...everything.filter((u) => matchesId(u, ids)),
      ...metaMediaUrls(html, pageUrl),
      ...onScreen.videos,
      ...(videoOnly || onScreen.videos.length || onScreen.blobVideo ? netVideos.slice(0, 3) : []),
      ...(videoOnly ? [] : onScreen.images.slice(0, 2)),
    ])].filter((u) => parseHttpUrl(u) && !tried.has(u)); // skips blob: streams
    for (const url of candidates.slice(0, 10)) {
      tried.add(url);
      const media =
        (await downloadMedia(url).catch(() => null)) ||
        // Files some sites (e.g. Google) only serve to the browser session that opened the page.
        (await downloadWithBrowser(page, url).catch(() => null));
      if (media && (!videoOnly || media.contentType.startsWith('video/'))) return media;
    }
    return null;
  });
}

/**
 * For shared AI chats: every generated image / video in the conversation, in order.
 * Small pictures (avatars, icons) are skipped.
 */
async function allMediaWithBrowser(pageUrl) {
  return withBrowserPage(pageUrl, async (page, loaded) => {
    await startVideos(page);
    // Every generated image / video in the chat, also inside shadow DOM. Each gets a marker so it can be
    // found again (to read a blob: from the page, or export the decoded picture at full resolution).
    const found = await page.evaluate(() => {
      const deepAll = (root, selector, out = []) => {
        out.push(...root.querySelectorAll(selector));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
        return out;
      };
      // Pictures the user uploaded into the chat are not what they want back.
      const userMessage =
        '[data-message-author-role="user"], user-query, .user-query, [data-testid="user-message"], .font-user-message';
      const out = [];
      for (const el of deepAll(document, 'img, video')) {
        if (el.closest(userMessage)) continue;
        const video = el.tagName === 'VIDEO';
        const src = video ? el.currentSrc || el.src || el.querySelector('source')?.src : el.currentSrc || el.src;
        if (!src || (!video && (el.naturalWidth < 256 || el.naturalHeight < 256))) continue;
        el.setAttribute('data-bot-idx', String(out.length));
        out.push({ idx: out.length, src, video });
      }
      return out;
    });
    const items = [...found];
    // A player fed by a blob: stream: its real file / playlist is in the network log.
    if (found.some((f) => f.video && /^blob:/.test(f.src))) {
      for (const i of loaded.filter((x) => x.video).sort((a, b) => b.size - a.size)) items.push({ src: i.url, video: true });
    }
    const results = [];
    const seen = new Set();
    const problems = [];
    const attempt = (fn, label) =>
      fn().catch((err) => {
        problems.push(`${label.slice(0, 100)}: ${err.message}`);
        return null;
      });
    for (const item of items) {
      if (results.length >= config.maxFilesPerLink) break;
      if (seen.has(item.src)) continue;
      seen.add(item.src);
      let media = null;
      if (parseHttpUrl(item.src)) {
        media =
          (await attempt(() => downloadMedia(fullSizeUrl(item.src)), item.src)) ||
          (await attempt(() => downloadMedia(item.src), item.src)) ||
          // Some chat sites only serve the file to the browser session that opened the chat.
          (await attempt(() => downloadWithBrowser(page, item.src), item.src));
      } else if (/^(blob|data):/.test(item.src) && item.idx !== undefined) {
        // The file only exists inside the page (e.g. Gemini shows generated images as blob:).
        media = await attempt(() => readFromPage(page, item), item.src);
      }
      // The page may have already freed the blob: (common right after showing it). The picture itself is still
      // decoded in the page, so export it at its original resolution, pixel for pixel (not a screenshot).
      if (!media && !item.video && item.idx !== undefined) {
        media = await attempt(() => exportFullImage(page, item.idx), `export #${item.idx}`);
      }
      if (media && !results.some((m) => m.sourceUrl === media.sourceUrl)) results.push(media);
    }
    if (!results.length) {
      const err = new Error('לא נמצאו תמונות או סרטונים שאפשר להוריד בשיחה');
      err.diagnostics = `${await describePage(page)} candidates=${items.length} failures=${JSON.stringify(problems.slice(0, 6))}`;
      throw err;
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

/** Reads a blob: / data: image or video straight out of the page that shows it. */
async function readFromPage(page, item) {
  const data = await page.evaluate(async (idx) => {
    const find = (root) => {
      const hit = root.querySelector(`[data-bot-idx="${idx}"]`);
      if (hit) return hit;
      for (const e of root.querySelectorAll('*')) {
        const inner = e.shadowRoot && find(e.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const el = find(document);
    const blob = await (await fetch(el.currentSrc || el.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { type: blob.type, base64: btoa(binary) };
  }, item.idx);
  const type = (data.type || (item.video ? 'video/mp4' : 'image/png')).toLowerCase();
  if (!isMediaType(type)) throw new Error(`not a file (${type})`);
  const name = `${item.video ? 'video' : 'image'}-${item.idx + 1}`;
  const base = { contentType: type, filename: filenameFor(`https://x/${name}`, type), sourceUrl: `page:${name}` };
  return fitInEmail(base, Buffer.from(data.base64, 'base64'));
}

/** A downloaded file as a result; a video too big for an email is compressed to fit. */
async function fitInEmail(base, content) {
  if (content.length <= config.maxFileBytes) return { ...base, content };
  if (base.contentType.startsWith('video/')) {
    const small = await withTempDir(async (dir) => {
      const file = path.join(dir, 'original');
      await writeFile(file, content);
      return shrinkVideoFile(file);
    });
    if (small) return { ...base, contentType: 'video/mp4', filename: base.filename.replace(/\.\w+$/, '.mp4'), content: small };
  }
  return { ...base, tooLarge: true };
}

/**
 * The picture at its original resolution (naturalWidth x naturalHeight), losslessly as PNG, taken from the
 * decoded image in the page. Only works for pictures the page itself owns (blob: / data: / same site).
 */
async function exportFullImage(page, idx) {
  const data = await page.evaluate(async (i) => {
    const find = (root) => {
      const hit = root.querySelector(`[data-bot-idx="${i}"]`);
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        const inner = el.shadowRoot && find(el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const img = find(document);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let k = 0; k < bytes.length; k += 0x8000) binary += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return { base64: btoa(binary), width: img.naturalWidth, height: img.naturalHeight };
  }, idx);
  return {
    contentType: 'image/png',
    filename: `image-${idx + 1}.png`,
    sourceUrl: `page:image-${idx + 1}`,
    content: Buffer.from(data.base64, 'base64'),
  };
}

async function downloadWithBrowser(page, url) {
  report('download', url);
  // Redirects are followed one hop at a time so every hop gets the internal-network check
  // (Google's download links redirect to the actual file).
  let current = url;
  let res;
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(current, true);
    res = await page.context().request.get(current, { timeout: config.downloadTimeoutMs, maxRedirects: 0 });
    const location = res.headers().location;
    if (res.status() < 300 || res.status() >= 400 || !location) break;
    current = new URL(location, current).toString();
  }
  const type = (res.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!res.ok()) throw new Error(`browser download: HTTP ${res.status()}`);
  if (isStream(type, current)) return streamResult(current);
  if (!isMediaType(type)) throw new Error(`browser download: not a file (${type || 'no type'})`);
  return fitInEmail({ contentType: type, filename: filenameFor(current, type), sourceUrl: current }, await res.body());
}

async function downloadMedia(url) {
  report('download', url);
  const { res, finalUrl } = await safeFetch(
    url, 'video/*,image/avif,image/webp,image/*,*/*;q=0.8', true, config.downloadTimeoutMs,
  );
  if (!res.ok) throw new Error(`השרת החזיר שגיאה ${res.status}`);
  const type = contentTypeOf(res);
  if (isStream(type, finalUrl)) {
    res.body?.cancel().catch(() => {});
    return streamResult(finalUrl);
  }
  if (!isMediaType(type)) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  return toResult(res, finalUrl, type);
}

/** Reads the file. A video too big for an email is compressed to fit; anything else too big is sent as a link. */
async function toResult(res, finalUrl, type) {
  const base = { contentType: type, filename: filenameFor(finalUrl, type), sourceUrl: finalUrl };
  try {
    return { ...base, content: await readLimited(res, config.maxFileBytes) };
  } catch (err) {
    if (!(err instanceof TooLargeError)) throw err;
    if (type.startsWith('video/')) {
      const small = await shrinkVideoUrl(finalUrl).catch((e) => console.error('video shrink failed:', e.message));
      if (small) return { ...base, contentType: 'video/mp4', filename: filenameFor(finalUrl, 'video/mp4'), content: small };
    }
    return { ...base, tooLarge: true };
  }
}

const MAX_VIDEO_DOWNLOAD = 500 * 1024 * 1024;

/** Downloads a video too big for an email to a temporary file and compresses it to fit. */
async function shrinkVideoUrl(url) {
  if (!(await hasFfmpeg())) return null;
  return withTempDir(async (dir) => {
    const { res } = await safeFetch(url, 'video/*,*/*;q=0.8', true, config.downloadTimeoutMs);
    if (!res.ok) return null;
    let size = 0;
    const limit = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        done(size > MAX_VIDEO_DOWNLOAD ? new Error('video larger than 500MB') : null, chunk);
      },
    });
    const file = path.join(dir, 'original');
    await pipeline(Readable.fromWeb(res.body), limit, createWriteStream(file));
    return shrinkVideoFile(file);
  });
}

/** A streamed (HLS) video saved as one MP4 file. */
async function streamResult(url) {
  const saved = await streamToMp4(url);
  const base = { contentType: 'video/mp4', filename: filenameFor(url, 'video/mp4'), sourceUrl: url };
  return saved ? { ...base, content: saved.content } : null;
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
// Sites whose terms forbid downloading their videos: the bot says so instead of trying.
const NO_DOWNLOAD_SITES = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

export async function getMediaFromLink(link) {
  if (hostIn(new URL(link).hostname.toLowerCase(), NO_DOWNLOAD_SITES)) {
    throw new Error('הבוט לא מוריד סרטונים מיוטיוב: תנאי השימוש של יוטיוב אוסרים הורדה, והתוכן לרוב מוגן בזכויות יוצרים');
  }
  // The API is at a fixed public address; the file address it returns is checked like any other.
  const viaApi = await pixabayFile(link);
  if (viaApi) return [await getMainMedia(viaApi)];
  await checkUrl(link, false);
  if (isChatShare(link)) {
    const all = await allMediaWithBrowser(link);
    if (all === null) throw new Error('צריך דפדפן כדי לפתוח שיחות משותפות, והוא לא מותקן בשרת');
    return all;
  }
  const one = await getMainMedia(directDownloadUrl(link));
  return [one];
}

/**
 * Pixabay blocks automated browsers (Cloudflare), but has an official free API that gives the file itself.
 * Needs PIXABAY_API_KEY (from https://pixabay.com/api/docs/ after signing in). Returns null when it does not apply.
 */
async function pixabayFile(link) {
  const u = new URL(link);
  if (!/(^|\.)pixabay\.com$/i.test(u.hostname)) return null;
  const m = /^\/(?:[a-z]{2}\/)?(videos|photos|illustrations|vectors|gifs)\/(?:[^/]*-)?(\d+)\/?$/i.exec(u.pathname);
  if (!m) return null;
  const key = process.env.PIXABAY_API_KEY;
  if (!key) throw new Error('פיקסביי חוסם הורדה אוטומטית מהדף. צריך להגדיר בשרת מפתח (PIXABAY_API_KEY) של פיקסביי');
  const video = m[1].toLowerCase() === 'videos';
  report('fetch', 'Pixabay API');
  const api = `https://pixabay.com/api/${video ? 'videos/' : ''}?key=${encodeURIComponent(key)}&id=${m[2]}`;
  const res = await fetch(api, { signal: AbortSignal.timeout(config.fetchTimeoutMs) });
  if (!res.ok) throw new Error(`פיקסביי לא החזיר את הקובץ (${res.status})`);
  const hit = (await res.json()).hits?.[0];
  if (!hit) throw new Error('הקובץ לא נמצא בפיקסביי');
  if (!video) return hit.fullHDURL || hit.largeImageURL || hit.webformatURL;
  // The biggest version that fits in an email; a bigger one would only be compressed down anyway.
  const sizes = ['large', 'medium', 'small', 'tiny'].map((k) => hit.videos?.[k]).filter((v) => v?.url);
  return (sizes.find((v) => v.size && v.size <= config.maxFileBytes) || sizes[sizes.length - 1])?.url || null;
}

/** The main image / video behind a link (direct file, page meta tags, or the rendered page). */
async function getMainMedia(link) {
  report('fetch', link);
  // The link might already be a direct image / video.
  const { res, finalUrl } = await safeFetch(
    link, 'text/html,application/xhtml+xml,video/*,image/*;q=0.9,*/*;q=0.8', false, config.downloadTimeoutMs,
  );
  const type = contentTypeOf(res);
  if (res.ok && isMediaType(type)) {
    report('download', finalUrl);
    return toResult(res, finalUrl, type);
  }
  if (res.ok && isStream(type, finalUrl)) {
    res.body?.cancel().catch(() => {});
    const stream = await streamResult(finalUrl);
    if (stream) return stream;
    throw new Error('לא הצלחתי לשמור את הסרטון המוזרם (stream)');
  }

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

  // A link to a video page must give the video, never its thumbnail image.
  const videoOnly = /\/(videos?|clips?|reels?|watch|shorts)(\/|$)/i.test(new URL(link).pathname);
  const tried = new Set();
  const tryCandidates = async (list) => {
    for (const url of list) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const media = await downloadMedia(url);
        if (media && (!videoOnly || media.contentType.startsWith('video/'))) return media;
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
  const rendered = await mainMediaWithBrowser(finalUrl, ids, { videoOnly, tried }).catch((err) => {
    if (browserErrors.has(err.message)) throw err;
    console.error('browser fallback failed:', err.message);
    return null;
  });
  if (rendered) return rendered;

  // 4. Last resort (no browser available): any other image / video named in the page source.
  const other = await tryCandidates(fromSource.slice(0, 8));
  if (other) return other;

  if (!res.ok) throw new Error(`האתר חסם את הגישה או שהקישור לא תקין (קוד ${res.status})`);
  throw new Error(videoOnly ? 'לא נמצא סרטון שאפשר להוריד בקישור' : 'לא נמצאו תמונה או סרטון בקישור');
}
