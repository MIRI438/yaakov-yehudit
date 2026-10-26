// The website sends the files by email instead of showing them: images on the page itself are often
// blocked or unwanted, and the email arrives where people already get the bot's replies.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { sendReply } from '../mailer.js';
import { access, usedTrial } from '../subscriptions.js';
import { filePath, onJobEnded, touchJob } from './jobs.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// One recipient cannot be flooded by someone typing their address on the site.
const MAX_PER_RECIPIENT_PER_HOUR = Number(process.env.WEB_MAX_EMAILS_PER_ADDRESS_PER_HOUR || 30);
const recent = new Map(); // email -> timestamps
const RETRY_MS = Number(process.env.SEND_QUOTA_RETRY_MINUTES || 30) * 60 * 1000;

export function canEmail(email, count = 1) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const times = (recent.get(email) || []).filter((t) => t > hourAgo);
  if (times.length + count > MAX_PER_RECIPIENT_PER_HOUR) return false;
  for (let i = 0; i < count; i++) times.push(Date.now());
  recent.set(email, times);
  return true;
}

export const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200;

async function deliver(job) {
  if (!job.email) return;
  job.mail = 'sending';
  touchJob(job);
  const site = process.env.PUBLIC_URL || '';
  const attachments = [];
  const links = [];
  let total = 0;
  for (const f of job.files) {
    const found = await filePath(job, f.id);
    if (!found) continue;
    if (total + f.size <= config.maxTotalBytes) {
      attachments.push({ filename: f.name, content: await readFile(found.path), contentType: f.type });
      total += f.size;
    } else if (site) links.push(`${site}/files/${job.id}/${f.id}?download=1`);
  }

  let text = 'שלום,\n\n';
  if (job.status !== 'done') text += `לא הצלחתי להוריד מהקישור:\n${job.url}\n${job.error ? `← ${job.error}\n` : ''}`;
  else {
    text += attachments.length === 1 ? 'מצורף הקובץ מהקישור:\n' : attachments.length ? `מצורפים ${attachments.length} קבצים מהקישור:\n` : '';
    text += `${job.url}\n`;
    if (links.length) text += `\nקבצים גדולים מדי למייל, אפשר להוריד אותם כאן (7 ימים):\n${links.map((l) => `• ${l}`).join('\n')}\n`;
    if (job.blocked) text += `\n${job.blocked === 1 ? 'קובץ אחד לא נשלח' : `${job.blocked} קבצים לא נשלחו`} כי לא עבר${job.blocked === 1 ? '' : 'ו'} את סינון הצניעות.\n`;
  }
  text += `\n${site ? `נשלח מ-Linkra (${site}) לבקשה שהוזנה באתר.` : 'נשלח מ-Linkra לבקשה שהוזנה באתר.'}\n`;

  try {
    await sendReply({
      to: job.email,
      subject: job.status === 'done' ? `הקובץ שלך מ-${job.site?.name || 'הקישור'} ✦` : 'לא הצלחתי להוריד מהקישור',
      text,
      attachments,
    });
    job.mail = 'sent';
    if (attachments.length && access(job.email).why === 'trial') usedTrial(job.email);
    log(`website: emailed ${attachments.length} file(s) for ${job.url}`);
  } catch (err) {
    if (/too many times|limit exceeded|quota/i.test(err.message) && (job.mailTries = (job.mailTries || 0) + 1) < 6) {
      // Gmail's daily sending limit: try again later instead of giving up.
      job.mail = 'waiting';
      setTimeout(() => deliver(job).catch(() => {}), RETRY_MS).unref();
      log(`website: daily sending limit, email for ${job.url} will be retried`);
    } else {
      job.mail = 'failed';
      log(`website: email for ${job.url} failed: ${err.message}`);
    }
  }
  touchJob(job);
}

onJobEnded((job) => {
  deliver(job).catch((err) => log('delivery error:', err.message));
});
