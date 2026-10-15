// Website jobs: one job = one link. Jobs run in a small queue, report live progress, keep their files on
// disk for a while (for previews, downloads, ZIP and the history list) and feed the site-wide counters.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMediaFromLink } from '../extract.js';
import { checkModesty } from '../moderation.js';
import { withProgress } from '../progress.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// A Railway volume mounted at /data keeps history across deploys; otherwise a temp folder.
export const DATA_DIR = process.env.DATA_DIR || (existsSync('/data') ? '/data/link-studio' : path.join(os.tmpdir(), 'link-studio'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FILE_TTL_MS = Number(process.env.FILE_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
const MAX_PARALLEL = 2;

// ---------- known sites (badge, colour, and the name shown in the timeline) ----------

const SITES = [
  { key: 'gemini', name: 'Gemini', color: '#4f8bff', hosts: ['gemini.google.com', 'gemini.google', 'g.co', 'bard.google.com'] },
  { key: 'chatgpt', name: 'ChatGPT', color: '#10a37f', hosts: ['chatgpt.com', 'chat.openai.com', 'sora.com', 'sora.chatgpt.com'] },
  { key: 'claude', name: 'Claude', color: '#d97757', hosts: ['claude.ai'] },
  { key: 'flow', name: 'Google Flow', color: '#a142f4', hosts: ['flow.google.com', 'labs.google'] },
  { key: 'leonardo', name: 'Leonardo', color: '#f5b544', hosts: ['leonardo.ai'] },
  { key: 'freepik', name: 'Freepik', color: '#1273eb', hosts: ['freepik.com', 'freepik.es', 'b2bpic.net'] },
  { key: 'magnific', name: 'Magnific', color: '#ff4fa3', hosts: ['magnific.com', 'magnific.ai'] },
  { key: 'midjourney', name: 'Midjourney', color: '#e8e8f0', hosts: ['midjourney.com'] },
  { key: 'copilot', name: 'Copilot', color: '#2fb7ff', hosts: ['copilot.microsoft.com'] },
  { key: 'grok', name: 'Grok', color: '#f2f2f2', hosts: ['grok.com', 'x.ai'] },
  { key: 'drive', name: 'Google Drive', color: '#34a853', hosts: ['drive.google.com', 'drive.usercontent.google.com'] },
  { key: 'dropbox', name: 'Dropbox', color: '#0061ff', hosts: ['dropbox.com'] },
];

export function detectSite(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* not a URL */
  }
  const site = SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h)));
  return site
    ? { key: site.key, name: site.name, color: site.color }
    : { key: 'web', name: host.replace(/^www\./, '') || 'קישור', color: '#9aa4ff' };
}

// ---------- storage ----------

let db = { jobs: {}, stats: { links: 0, files: 0, bytes: 0, blocked: 0, bySite: {}, startedAt: Date.now() } };
let saveTimer;

export async function loadStore() {
  await mkdir(FILES_DIR, { recursive: true });
  try {
    db = JSON.parse(await readFile(DB_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  // Jobs interrupted by a restart cannot resume.
  for (const job of Object.values(db.jobs)) {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.error = 'השרת הופעל מחדש באמצע העבודה. נסו שוב.';
    }
  }
  setInterval(cleanup, 60 * 60 * 1000).unref();
  cleanup();
  log(`website data in ${DATA_DIR} (${Object.keys(db.jobs).length} jobs)`);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(db));
    await rename(tmp, DB_FILE);
  }, 300);
}

async function cleanup() {
  const now = Date.now();
  for (const job of Object.values(db.jobs)) {
    if (!job.expired && job.finishedAt && now - job.finishedAt > FILE_TTL_MS) {
      await rm(path.join(FILES_DIR, job.id), { recursive: true, force: true });
      job.expired = true;
    }
  }
  save();
}

/** Counts for the site-wide counters (website and email both count). */
export function recordStats({ site, files = [], blocked = 0 }) {
  const s = db.stats;
  s.links++;
  s.files += files.length;
  s.bytes += files.reduce((n, f) => n + (f.size || f.content?.length || 0), 0);
  s.blocked += blocked;
  if (site) s.bySite[site] = (s.bySite[site] || 0) + 1;
  save();
}

export const stats = () => db.stats;

/** The shared store (accounts and quota live next to the jobs). */
export const store = () => db;
export const saveStore = () => save();

// ---------- jobs ----------

const events = new EventEmitter();
events.setMaxListeners(0);
const queue = [];
let running = 0;

const newId = () => randomBytes(9).toString('base64url');

/** The public view of a job (what the browser sees). */
export function publicJob(job) {
  if (!job) return null;
  const { visitor, owner, ...rest } = job;
  return rest;
}

export const getJob = (id) => db.jobs[id];
export const onJobUpdate = (id, fn) => {
  events.on(id, fn);
  return () => events.off(id, fn);
};

/** Called once for every job that ended with files. */
export const onJobDone = (fn) => events.on('finished', fn);

function update(job) {
  save();
  events.emit(job.id, publicJob(job));
}

/** owner: who pays for it (quota key). */
export function createJob(url, visitor, owner = '') {
  const job = {
    id: newId(),
    visitor,
    owner,
    url,
    site: detectSite(url),
    status: 'queued',
    steps: [{ key: 'queued', at: Date.now() }],
    files: [],
    blocked: 0,
    starred: false,
    createdAt: Date.now(),
  };
  db.jobs[job.id] = job;
  queue.push(job);
  update(job);
  pump();
  return job;
}

export function historyFor(visitor, limit = 200) {
  return Object.values(db.jobs)
    .filter((j) => j.visitor === visitor && !j.deleted)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(publicJob);
}

export function setStar(job, starred) {
  job.starred = Boolean(starred);
  update(job);
}

export async function deleteJob(job) {
  job.deleted = true;
  await rm(path.join(FILES_DIR, job.id), { recursive: true, force: true });
  update(job);
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

function step(job, key, detail = '') {
  const last = job.steps[job.steps.length - 1];
  if (last?.key === key) {
    last.count = (last.count || 1) + 1;
    return update(job);
  }
  job.steps.push({ key, at: Date.now(), detail: String(detail).slice(0, 120) });
  update(job);
}

async function runJob(job) {
  job.status = 'running';
  step(job, 'detect', job.site.name);
  const started = Date.now();
  try {
    const found = await withProgress((key, detail) => step(job, key, detail), () => getMediaFromLink(job.url));
    const dir = path.join(FILES_DIR, job.id);
    await mkdir(dir, { recursive: true });
    for (const file of found) {
      if (!file.content) {
        job.blocked++; // too large to download and check
        continue;
      }
      const verdict = await withProgress((key, detail) => step(job, key, detail), () => checkModesty(file));
      if (!verdict.allowed) {
        job.blocked++;
        log(`website: blocked ${file.filename} from ${job.url}: ${verdict.reason}`);
        continue;
      }
      const id = String(job.files.length + 1);
      const name = file.filename.replace(/[^\w.\-]+/g, '_');
      await writeFile(path.join(dir, `${id}-${name}`), file.content);
      const entry = { id, name, type: file.contentType, size: file.content.length };
      if (file.contentType.startsWith('video/')) entry.poster = await makePoster(dir, `${id}-${name}`, id);
      job.files.push(entry);
      update(job);
    }
    job.status = job.files.length ? 'done' : 'failed';
    if (!job.files.length) {
      job.error = job.blocked ? 'הקבצים לא עברו את סינון הצניעות' : 'לא נמצאו קבצים בקישור';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || String(err);
  }
  job.finishedAt = Date.now();
  job.durationMs = job.finishedAt - started;
  if (job.status === 'done') events.emit('finished', job);
  step(job, job.status === 'done' ? 'done' : 'failed');
  recordStats({ site: job.site.key, files: job.files, blocked: job.blocked });
  log(`website: ${job.status} ${job.url} (${job.files.length} files, ${job.blocked} blocked, ${job.durationMs}ms)`);
}

/** A still frame for the video's preview card. */
function makePoster(dir, fileName, id) {
  const poster = `${id}-poster.jpg`;
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-y', '-ss', '0.5', '-i', path.join(dir, fileName), '-frames:v', '1', '-vf', 'scale=640:-2', path.join(dir, poster)],
      { timeout: 30000 },
      (err) => resolve(err ? null : poster),
    );
  });
}

/** Path of a stored file (or poster), or null. */
export async function filePath(job, fileId, { poster = false } = {}) {
  const file = job.files.find((f) => f.id === fileId);
  if (!file || job.expired || job.deleted) return null;
  const p = path.join(FILES_DIR, job.id, poster ? file.poster || '' : `${file.id}-${file.name}`);
  try {
    await stat(p);
    return { path: p, file };
  } catch {
    return null;
  }
}

// ---------- ZIP (stored, no compression: images and videos are already compressed) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export async function zipJob(job) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of job.files) {
    const found = await filePath(job, f.id);
    if (!found) continue;
    const data = await readFile(found.path);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
