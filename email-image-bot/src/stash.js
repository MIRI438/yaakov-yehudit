// Short-lived download links for email attachments, for a mail relay that cannot receive big requests
// (Vercel: 4.5MB). The relay downloads the file from the bot's website and attaches it to the email.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || (existsSync('/data') ? '/data/link-studio' : path.join(os.tmpdir(), 'link-studio'));
export const STASH_DIR = path.join(DATA_DIR, 'mail-files');
const KEEP_MS = 2 * 60 * 60 * 1000;

/** Saves the file and returns its public link (or null when the site has no public address). */
export async function stashFile(content, filename) {
  const site = process.env.PUBLIC_URL;
  if (!site) return null;
  const token = randomBytes(18).toString('base64url');
  const name = filename.replace(/[^\w.\-]+/g, '_') || 'file';
  await mkdir(path.join(STASH_DIR, token), { recursive: true });
  await writeFile(path.join(STASH_DIR, token, name), content);
  return { url: `${site.replace(/\/$/, '')}/mail-files/${token}/${name}`, token };
}

export const dropStash = (token) => rm(path.join(STASH_DIR, token), { recursive: true, force: true });

/** The path of a stashed file for the website to serve, or null. */
export async function stashedPath(token, name) {
  if (!/^[\w-]{20,}$/.test(token) || !/^[\w.\-]+$/.test(name)) return null;
  const p = path.join(STASH_DIR, token, name);
  try {
    const s = await stat(p);
    return Date.now() - s.mtimeMs < KEEP_MS ? p : null;
  } catch {
    return null;
  }
}

// Links that were never used (a crash mid-send) are removed after two hours.
setInterval(async () => {
  for (const token of await readdir(STASH_DIR).catch(() => [])) {
    const s = await stat(path.join(STASH_DIR, token)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > KEEP_MS) await dropStash(token);
  }
}, 30 * 60 * 1000).unref();
