// The website: paste links, watch them being processed live, preview / download the files, and browse
// your history. Same engine as the email bot (browser, video handling, modesty filter).

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLinks } from '../extract.js';
import {
  createJob, deleteJob, detectSite, filePath, getJob, historyFor, loadStore, onJobUpdate, publicJob, setStar,
  stats, zipJob,
} from './jobs.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_LINKS_PER_REQUEST = 10;
const MAX_LINKS_PER_HOUR = Number(process.env.WEB_MAX_LINKS_PER_HOUR || 60);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Anonymous visitor id (cookie) - the history belongs to it. */
function visitorOf(req, res) {
  const match = /(?:^|;\s*)vid=([\w-]{16,})/.exec(req.headers.cookie || '');
  if (match) return match[1];
  const vid = randomBytes(16).toString('base64url');
  res.setHeader('set-cookie', `vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  return vid;
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const recent = new Map(); // ip -> timestamps
function allowed(ip, count) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const times = (recent.get(ip) || []).filter((t) => t > hourAgo);
  if (times.length + count > MAX_LINKS_PER_HOUR) return false;
  for (let i = 0; i < count; i++) times.push(Date.now());
  recent.set(ip, times);
  return true;
}

async function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'not found');
  try {
    const data = await readFile(full);
    send(res, 200, data, {
      'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
      'cache-control': file === 'index.html' ? 'no-cache' : 'public, max-age=300',
    });
  } catch {
    send(res, 404, 'not found');
  }
}

async function serveFile(req, res, found, download) {
  const { size } = await stat(found.path);
  const name = encodeURIComponent(found.file.name);
  const headers = {
    'content-type': found.poster ? 'image/jpeg' : found.file.type,
    'cache-control': 'private, max-age=3600',
    'accept-ranges': 'bytes',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
  };
  // Range requests let the browser seek in videos.
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && !found.poster) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(found.path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(found.path).pipe(res);
}

// ---------- routes ----------

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // Pages (the app reads the path itself: /r/<id> opens a shared result).
  if (method === 'GET' && (url.pathname === '/' || parts[0] === 'r' || parts[0] === 'history')) {
    visitorOf(req, res);
    return serveStatic(res, 'index.html');
  }
  if (method === 'GET' && parts[0] === 'assets') return serveStatic(res, parts.slice(1).join('/'));
  if (method === 'GET' && url.pathname === '/favicon.ico') return serveStatic(res, 'favicon.svg');
  if (url.pathname === '/health') return send(res, 200, { ok: true });

  if (parts[0] === 'api') {
    const visitor = visitorOf(req, res);

    if (method === 'GET' && parts[1] === 'stats') return send(res, 200, stats());

    // Which site a link belongs to (for the live badge while typing).
    if (method === 'GET' && parts[1] === 'detect') return send(res, 200, detectSite(url.searchParams.get('url') || ''));

    if (method === 'POST' && parts[1] === 'jobs' && !parts[2]) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'בקשה לא תקינה' });
      }
      const links = findLinks(String(body.text || ''), '', '').slice(0, MAX_LINKS_PER_REQUEST);
      if (!links.length) return send(res, 400, { error: 'לא מצאתי קישור. הדביקו כתובת שמתחילה ב-https://' });
      if (!allowed(clientIp(req), links.length)) {
        return send(res, 429, { error: 'הגעתם למגבלת השימוש לשעה. נסו שוב מעט מאוחר יותר.' });
      }
      return send(res, 200, { jobs: links.map((l) => publicJob(createJob(l, visitor))) });
    }

    if (method === 'GET' && parts[1] === 'history') return send(res, 200, { jobs: historyFor(visitor) });

    if (parts[1] === 'jobs' && parts[2]) {
      const job = getJob(parts[2]);
      if (!job || job.deleted) return send(res, 404, { error: 'לא נמצא' });
      const mine = job.visitor === visitor;

      if (method === 'GET' && !parts[3]) return send(res, 200, publicJob(job));

      // Live updates (Server-Sent Events).
      if (method === 'GET' && parts[3] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const push = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
        push(publicJob(job));
        const off = onJobUpdate(job.id, push);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          off();
          clearInterval(ping);
        });
        return;
      }

      if (method === 'GET' && parts[3] === 'zip') {
        const zip = await zipJob(job);
        return send(res, 200, zip, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="files-${job.id}.zip"`,
        });
      }

      if (method === 'POST' && parts[3] === 'star' && mine) {
        const body = await readJson(req).catch(() => ({}));
        setStar(job, body.starred);
        return send(res, 200, publicJob(job));
      }
      if (method === 'DELETE' && !parts[3] && mine) {
        await deleteJob(job);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'לא נמצא' });
    }
    return send(res, 404, { error: 'לא נמצא' });
  }

  // Files: /files/<job>/<file>[/poster]  (?download=1 to save instead of view)
  if (method === 'GET' && parts[0] === 'files' && parts[1] && parts[2]) {
    const job = getJob(parts[1]);
    const poster = parts[3] === 'poster';
    const found = job && (await filePath(job, parts[2], { poster }));
    if (!found) return send(res, 404, 'not found');
    return serveFile(req, res, { ...found, poster }, url.searchParams.has('download'));
  }

  send(res, 404, 'not found');
}

export async function startWebServer() {
  await loadStore();
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('website error:', err.message);
      if (!res.headersSent) send(res, 500, { error: 'שגיאה בשרת' });
      else res.end();
    });
  });
  await new Promise((resolve) => server.listen(port, resolve));
  log(`website on port ${port}`);
  return server;
}
