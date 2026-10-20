// The website sends the files by email instead of showing them: images on the page itself are often
// blocked or unwanted, and the email arrives where people already get the bot's replies.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { sendReply } from '../mailer.js';
import { packImagesAsPdf } from '../pdf.js';
import { filePath, onJobEnded, touchJob } from './jobs.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// One recipient cannot be flooded by someone typing their address on the site.
const MAX_PER_RECIPIENT_PER_HOUR = Number(process.env.WEB_MAX_EMAILS_PER_ADDRESS_PER_HOUR || 30);
const recent = new Map(); // email -> timestamps

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
  const files = [];
  for (const f of job.files) {
    const found = await filePath(job, f.id);
    if (found) files.push({ ...f, filename: f.name, contentType: f.type, content: await readFile(found.path) });
  }
  // The images as one PDF; videos as they are.
  const { files: toSend, pdf } = await packImagesAsPdf(files, config.maxTotalBytes);
  for (const f of toSend) {
    if (total + f.content.length <= config.maxTotalBytes) {
      attachments.push({ filename: f.filename, content: f.content, contentType: f.contentType });
      total += f.content.length;
    } else if (site && f.id) links.push(`${site}/files/${job.id}/${f.id}?download=1`);
  }

  let text = 'שלום,\n\n';
  if (job.status !== 'done') text += `לא הצלחתי להוריד מהקישור:\n${job.url}\n${job.error ? `← ${job.error}\n` : ''}`;
  else {
    if (pdf) text += `מצורף קובץ PDF עם ${pdf.pages === 1 ? 'התמונה' : `${pdf.pages} התמונות`}${pdf.pages > 1 ? ' (תמונה בכל עמוד)' : ''} מהקישור:\n`;
    else text += attachments.length === 1 ? 'מצורף הקובץ מהקישור:\n' : attachments.length ? `מצורפים ${attachments.length} קבצים מהקישור:\n` : '';
    if (pdf && attachments.length > 1) text += `ועוד ${attachments.length - 1 === 1 ? 'קובץ' : `${attachments.length - 1} קבצים`} מצורפים.\n`;
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
    log(`website: emailed ${attachments.length} file(s) for ${job.url}`);
  } catch (err) {
    job.mail = 'failed';
    log(`website: email for ${job.url} failed: ${err.message}`);
  }
  touchJob(job);
}

onJobEnded((job) => {
  deliver(job).catch((err) => log('delivery error:', err.message));
});
