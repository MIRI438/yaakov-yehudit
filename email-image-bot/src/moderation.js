// Modesty filter: every image / video is checked before it is sent; anything immodest is not sent.
//
// Two layers:
//  1. Built-in (free, always on unless MODERATION=off): the NSFWJS image model, run on the server.
//     Catches nudity and revealing content.
//  2. Strict (when ANTHROPIC_API_KEY is set): Claude looks at the image / video frames and judges them by a
//     religious standard of modesty (tzniut), which is stricter than "not explicit".
// A file is sent only if every layer that runs allows it. Anything that cannot be checked is not sent.

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { report } from './progress.js';
import { withTempDir } from './video.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

const MODEL_SIZE = 224; // NSFWJS MobileNetV2Mid input size
const VIDEO_FRAMES = 8; // frames checked per video, spread over its whole length

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-300))) : resolve(stdout),
    );
  });
}

// ---------- frames ----------

/** Frames to check: the image itself, or VIDEO_FRAMES frames spread across a video. */
async function extractFrames(file, isVideo, dir) {
  let filter = '';
  if (isVideo) {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const seconds = Number(String(out).trim()) || 1;
    filter = `fps=${(VIDEO_FRAMES / seconds).toFixed(4)},`;
  }
  const count = isVideo ? VIDEO_FRAMES : 1;
  // Small raw RGB frames for the built-in model.
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', file, '-vf', `${filter}scale=${MODEL_SIZE}:${MODEL_SIZE}`,
    '-frames:v', String(count), '-f', 'image2', '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', path.join(dir, 'raw-%02d.rgb'),
  ]);
  // Larger JPEG frames for Claude (only needed for the strict layer).
  if (strictEnabled()) {
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', file, '-vf', `${filter}scale='min(1024,iw)':-2`,
      '-frames:v', String(count), '-q:v', '4', path.join(dir, 'jpg-%02d.jpg'),
    ]);
  }
  const names = (await readdir(dir)).sort();
  const raw = await Promise.all(names.filter((n) => n.startsWith('raw-')).map((n) => readFile(path.join(dir, n))));
  const jpg = await Promise.all(names.filter((n) => n.startsWith('jpg-')).map((n) => readFile(path.join(dir, n))));
  if (!raw.length) throw new Error('no frames could be read');
  return { raw, jpg };
}

// ---------- layer 1: built-in model ----------

let modelPromise;
async function nsfwModel() {
  modelPromise ??= (async () => {
    const tf = await import('@tensorflow/tfjs');
    const nsfwjs = await import('nsfwjs');
    // WebAssembly runs the model ~10x faster than plain JavaScript; its .wasm files ship in the package.
    try {
      const wasm = await import('@tensorflow/tfjs-backend-wasm');
      const dir = path.dirname(createRequire(import.meta.url).resolve('@tensorflow/tfjs-backend-wasm/package.json'));
      wasm.setWasmPaths(`${path.join(dir, 'dist')}${path.sep}`);
      await tf.setBackend('wasm');
    } catch (err) {
      log(`modesty filter: WebAssembly unavailable, using the slower JavaScript engine (${err.message})`);
    }
    await tf.ready();
    return { tf, model: await nsfwjs.load('MobileNetV2Mid') };
  })();
  return modelPromise;
}

// Strict thresholds: the "Sexy" class covers revealing clothing, not only explicit content.
const BLOCK_THRESHOLDS = { Porn: 0.15, Hentai: 0.2, Sexy: 0.2 };

async function builtInCheck(rawFrames) {
  const { tf, model } = await nsfwModel();
  for (const [i, frame] of rawFrames.entries()) {
    const image = tf.tensor3d(new Int32Array(frame), [MODEL_SIZE, MODEL_SIZE, 3], 'int32');
    let predictions;
    try {
      predictions = await model.classify(image);
    } finally {
      image.dispose();
    }
    for (const { className, probability } of predictions) {
      const limit = BLOCK_THRESHOLDS[className];
      if (limit !== undefined && probability >= limit) {
        return { allowed: false, reason: `built-in: ${className} ${probability.toFixed(2)} (frame ${i + 1})` };
      }
    }
  }
  return { allowed: true };
}

// ---------- layer 2: Claude ----------

const strictEnabled = () => config.moderation !== 'off' && Boolean(process.env.ANTHROPIC_API_KEY);

let client;
const anthropic = () => (client ??= new Anthropic());

const SYSTEM_PROMPT = `You review images before an automated service sends them to people in a religious community that follows a strict standard of modesty (tzniut). Decide whether the content may be sent.

Mark it NOT modest if any of these appear, for any person (real, drawn, or AI-generated), even partially:
- Nudity, underwear, swimwear, or see-through or skin-tight revealing clothing.
- A woman or girl (past early childhood) whose clothing exposes the shoulders, upper arms above the elbow, cleavage or a low neckline, the midriff, or legs above the knee, or a skirt/dress that is short or slit above the knee.
- Sexual or suggestive content, poses, or gestures; romantic or physical intimacy such as kissing or embracing between a man and a woman.

Content without people (landscapes, objects, animals, food, text, patterns, buildings) and people dressed modestly by this standard are modest.
When you cannot tell whether clothing meets the standard (for example the image is too small or blurry to see), treat it as NOT modest.
Several images in one request are frames of one video: if any frame is not modest, the whole video is not modest.`;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    modest: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['modest', 'reason'],
  additionalProperties: false,
};

async function claudeCheck(jpgFrames, isVideo) {
  const response = await anthropic().beta.messages.create({
    model: config.moderationModel,
    max_tokens: 4000,
    // If the model declines (safety classifier), let Anthropic retry on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          ...jpgFrames.map((frame) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') },
          })),
          {
            type: 'text',
            text: isVideo
              ? `These are ${jpgFrames.length} frames from one video. Is the video modest?`
              : 'Is this image modest?',
          },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return { allowed: false, reason: 'claude: declined to review' };
  const text = response.content.find((block) => block.type === 'text')?.text;
  const verdict = JSON.parse(text);
  return verdict.modest ? { allowed: true } : { allowed: false, reason: `claude: ${verdict.reason}` };
}

// ---------- entry point ----------

export function moderationDescription() {
  if (config.moderation === 'off') return 'off';
  return strictEnabled() ? `built-in + strict (${config.moderationModel})` : 'built-in only (no ANTHROPIC_API_KEY)';
}

/**
 * Checks one file before it is sent. Returns { allowed: true } or { allowed: false, reason }.
 * Fails closed: if the file cannot be checked, it is not allowed.
 */
export async function checkModesty(file) {
  if (config.moderation === 'off') return { allowed: true };
  report('moderation', file.filename);
  const isVideo = file.contentType.startsWith('video/');
  try {
    return await withTempDir(async (dir) => {
      const input = path.join(dir, 'input');
      await writeFile(input, file.content);
      const frames = await extractFrames(input, isVideo, dir);
      const builtIn = await builtInCheck(frames.raw);
      if (!builtIn.allowed) return builtIn;
      if (strictEnabled()) return await claudeCheck(frames.jpg, isVideo);
      return { allowed: true };
    });
  } catch (err) {
    log(`modesty check failed for ${file.filename}: ${err.message}`);
    return { allowed: false, reason: `could not be checked: ${err.message}` };
  }
}

/**
 * Startup check: loads the built-in model and, when the strict layer is on, sends Claude one harmless test
 * image, so a problem (bad key, no credit, rejected request) shows up in the log right away. Because the
 * filter fails closed, such a problem would otherwise block every file.
 */
export async function warmUpModeration() {
  if (config.moderation === 'off') return 'off';
  const started = Date.now();
  await withTempDir(async (dir) => {
    const sample = path.join(dir, 'sample.jpg');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', sample]);
    const frames = await extractFrames(sample, false, dir);
    await builtInCheck(frames.raw);
    if (strictEnabled()) {
      const verdict = await claudeCheck(frames.jpg, false);
      if (!verdict.allowed) throw new Error(`strict filter rejected the harmless test image (${verdict.reason})`);
    }
  });
  return `ready in ${((Date.now() - started) / 1000).toFixed(1)}s`;
}
