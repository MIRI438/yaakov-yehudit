// Video helpers built on ffmpeg (installed in the Docker image):
// - streamed videos (HLS .m3u8 playlists) are saved as one MP4 file;
// - videos too big for an email are re-encoded to fit (from a file the caller downloaded).
// Everything here returns null when ffmpeg is missing or fails, so callers fall back gracefully.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { report } from './progress.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
// Only network protocols for playlists and their segments; no local files.
const PROTOCOLS = 'http,https,tcp,tls,crypto';

let available;
export async function hasFfmpeg() {
  available ??= run('ffmpeg', ['-version']).then(
    () => true,
    () => false,
  );
  return available;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-500))) : resolve(stdout),
    );
  });
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-video-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const inputArgs = (url) => ['-protocol_whitelist', PROTOCOLS, '-user_agent', USER_AGENT, '-i', url];

async function durationSeconds(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const seconds = Number(String(out).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Re-encodes `input` (a file) to an MP4 that fits in `maxBytes`. */
async function shrink(input, dir, maxBytes) {
  const seconds = await durationSeconds(input);
  if (!seconds) return null;
  const audioKbps = 96;
  // 90% of the budget, leaving room for the MP4 container.
  const videoKbps = Math.floor((maxBytes * 8 * 0.9) / seconds / 1000 - audioKbps);
  if (videoKbps < 150) return null; // too long to fit at a watchable quality
  const out = path.join(dir, 'small.mp4');
  await run('ffmpeg', [
    '-y', '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`,
    '-bufsize', `${videoKbps * 2}k`,
    // Lower resolution only when the bitrate is low; keep even dimensions for H.264.
    '-vf', `scale='min(${videoKbps < 1500 ? 1280 : 1920},iw)':-2`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', out,
  ]);
  const { size } = await stat(out);
  return size <= maxBytes ? readFile(out) : null;
}

/**
 * Saves a streamed video (HLS playlist URL) as one MP4. Returns
 * { content } when it fits in the email, or null.
 */
export async function streamToMp4(url) {
  report('video');
  if (!(await hasFfmpeg())) return null;
  return withTempDir(async (dir) => {
    const full = path.join(dir, 'full.mp4');
    try {
      // Copy the streams as they are (fast, no quality loss); cap the size at ~300MB.
      await run('ffmpeg', [
        '-y', ...inputArgs(url), '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-fs', String(300 * 1024 * 1024),
        '-movflags', '+faststart', full,
      ]);
      const { size } = await stat(full);
      if (size <= config.maxFileBytes) return { content: await readFile(full) };
      const small = await shrink(full, dir, config.maxFileBytes);
      return small ? { content: small } : null;
    } catch (err) {
      console.error('stream download failed:', err.message);
      return null;
    }
  });
}

/** Re-encodes a downloaded video file to fit in an email. Returns a Buffer or null. */
export async function shrinkVideoFile(file) {
  report('video');
  if (!(await hasFfmpeg())) return null;
  return withTempDir(async (dir) => {
    try {
      return await shrink(file, dir, config.maxFileBytes);
    } catch (err) {
      console.error('video shrink failed:', err.message);
      return null;
    }
  });
}
