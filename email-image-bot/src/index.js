// Email bot: anyone who emails a link (Leonardo, Freepik, a shared ChatGPT / Gemini chat, any page...)
// gets the images / videos behind it back as attachments.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { findLinks, getMediaFromLink } from './extract.js';
import { sendReply, verifySending } from './mailer.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---- protection against loops and abuse ----

const recentBySender = new Map(); // sender -> [timestamps]

function rateLimited(sender) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const times = (recentBySender.get(sender) || []).filter((t) => t > hourAgo);
  times.push(Date.now());
  recentBySender.set(sender, times);
  return times.length > config.maxEmailsPerSenderPerHour;
}

function shouldIgnore(mail, sender) {
  if (!sender) return 'no sender';
  if (sender === config.email.toLowerCase()) return 'from myself';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(sender)) return 'system address';
  const autoSubmitted = String(mail.headers.get('auto-submitted') || 'no').toLowerCase();
  if (autoSubmitted !== 'no') return 'auto-submitted';
  if (/^(bulk|list|junk|auto_reply)$/i.test(String(mail.headers.get('precedence') || ''))) return 'bulk/list';
  if (mail.headers.get('x-autoreply') || mail.headers.get('x-autorespond')) return 'auto-reply';
  return null;
}

// ---- handling a single email ----

async function handleMessage(source) {
  const mail = await simpleParser(source);
  const replyTo = mail.replyTo?.value?.[0]?.address || mail.from?.value?.[0]?.address;
  const sender = replyTo?.toLowerCase();

  const ignoreReason = shouldIgnore(mail, sender);
  if (ignoreReason) {
    log(`skipping message from ${sender || '?'}: ${ignoreReason}`);
    return;
  }
  // No Leonardo / Freepik / Magnific link: ignore the email completely (no reply).
  const links = findLinks(mail.text, mail.html || '');
  if (links.length === 0) {
    log(`no supported link in message from ${sender}, ignoring`);
    return;
  }
  if (rateLimited(sender)) {
    log(`rate limit reached for ${sender}, skipping`);
    return;
  }
  log(`message from ${sender}: ${links.length} link(s)`);

  const attachments = [];
  const downloadLinks = []; // files too big to attach
  const failures = [];
  const screenshots = [];
  const attachedFrom = []; // source of each attachment, in case they have to be sent as links
  let totalBytes = 0;

  const results = await Promise.allSettled(links.map((link) => getMediaFromLink(link)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failures.push(`${links[i]}\n   ← ${r.reason?.message || r.reason}`);
      log(`link failed: ${links[i]} | ${r.reason?.message || r.reason}${r.reason?.diagnostics ? ` | ${r.reason.diagnostics}` : ''}`);
      // A picture of the page as the bot saw it explains most failures (blocked, login, consent...).
      if (config.debugScreenshots && r.reason?.screenshot) {
        screenshots.push({ filename: `what-the-bot-saw-${i + 1}.png`, content: r.reason.screenshot, contentType: 'image/png' });
      }
      return;
    }
    for (const file of r.value) {
      if (file.tooLarge || totalBytes + file.content.length > config.maxTotalBytes) {
        // Files read from inside a page have no address to link to.
        if (/^https?:/.test(file.sourceUrl)) downloadLinks.push(file.sourceUrl);
        else failures.push(`${links[i]}\n   ← קובץ גדול מדי למייל (${file.filename})`);
        continue;
      }
      totalBytes += file.content.length;
      let name = file.filename;
      for (let n = 2; attachments.some((a) => a.filename === name); n++) name = `${n}_${file.filename}`;
      attachments.push({ filename: name, content: file.content, contentType: file.contentType });
      if (/^https?:/.test(file.sourceUrl)) attachedFrom.push(file.sourceUrl);
    }
  });

  let text = 'שלום,\n\n';
  if (attachments.length === 1) text += 'מצורף הקובץ מהקישור ששלחת.\n';
  if (attachments.length > 1) text += `מצורפים ${attachments.length} קבצים מהקישורים ששלחת.\n`;
  if (downloadLinks.length) {
    text += `\nקבצים שגדולים מדי לצירוף למייל, אפשר להוריד אותם כאן:\n${downloadLinks.map((u) => `• ${u}`).join('\n')}\n`;
  }
  if (!attachments.length && !downloadLinks.length) text += 'לא הצלחתי להוריד תמונה או סרטון מהקישורים ששלחת.\n';
  if (failures.length) text += `\nקישורים שלא הצליחו:\n${failures.map((f) => `• ${f}`).join('\n')}\n`;
  if (screenshots.length) text += '\nמצורף צילום מסך של הדף כפי שהבוט ראה אותו.\n';

  const subject = mail.subject ? (/^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`) : 'הקובץ שלך';
  const reply = {
    to: replyTo,
    subject,
    text,
    attachments: [...attachments, ...screenshots],
    inReplyTo: mail.messageId,
    references: [...(mail.references ? [].concat(mail.references) : []), mail.messageId].filter(Boolean),
  };
  const megabytes = (reply.attachments.reduce((n, a) => n + a.content.length, 0) / 1024 / 1024).toFixed(1);
  const started = Date.now();
  try {
    await sendReply(reply);
  } catch (err) {
    log(`sending to ${sender} failed after ${((Date.now() - started) / 1000).toFixed(0)}s (${megabytes}MB): ${err.message}`);
    if (!attachments.length || !attachedFrom.length) throw err;
    // The files made the email too heavy to send: send the reply again with download links instead.
    await sendReply({
      ...reply,
      attachments: [],
      text:
        (text.replace(/^מצורפ.*\n/m, '') +
        `\nהקבצים כבדים מדי לשליחה במייל, אפשר להוריד אותם כאן:\n${attachedFrom.map((u) => `• ${u}`).join('\n')}\n`)
          .replace(/\n{3,}/g, '\n\n'),
    });
    log(`replied to ${sender} with ${attachedFrom.length} download link(s) instead of attachments`);
    return;
  }
  log(
    `replied to ${sender}: ${attachments.length} attached, ${downloadLinks.length} as link, ${failures.length} failed ` +
      `(${megabytes}MB, sent in ${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

// ---- mailbox watching ----

let client;
let checking = false;
let checkAgain = false;

async function checkInbox() {
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  try {
    do {
      checkAgain = false;
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids) {
        // Mark as read first so a crash never makes us answer the same email twice.
        await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        handleMessage(msg.source).catch((err) => log(`error handling message ${uid}: ${err.message}`));
      }
    } while (checkAgain);
  } catch (err) {
    log('error checking inbox:', err.message);
  } finally {
    checking = false;
  }
}

async function start() {
  client = new ImapFlow({
    ...config.imap,
    auth: { user: config.email, pass: config.password },
    logger: false,
    autoIdleDelay: 1000, // go back to IDLE (instant push of new mail) 1s after each command
  });
  client.on('exists', () => checkInbox()); // fires immediately when a new email arrives (IMAP IDLE)
  client.on('error', (err) => log('IMAP error:', err.message));

  log(`connecting to ${config.imap.host}:${config.imap.port} (IMAP)...`);
  await client.connect();
  await client.mailboxOpen('INBOX');
  log(`listening on ${config.email} (allowed domains: ${config.allowedDomains.join(', ')})`);
  await checkInbox();

  const poll = setInterval(() => checkInbox(), config.pollIntervalMs);
  await new Promise((resolve) => client.once('close', resolve));
  clearInterval(poll);
}

async function main() {
  log(`checking that replies can be sent (${config.sendScriptUrl ? 'Apps Script' : 'SMTP'})...`);
  const via = await verifySending().catch((err) => {
    console.error('Sending check failed:', err.message);
    if (!config.sendScriptUrl) {
      console.error('If this host blocks SMTP ports (e.g. Railway), set SEND_SCRIPT_URL - see README.');
    }
    process.exit(1);
  });
  log(`replies will be sent via ${via}`);
  for (;;) {
    try {
      await start();
      log('IMAP connection closed, reconnecting in 5s');
    } catch (err) {
      log('IMAP connection failed, retrying in 5s:', err.message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main();
