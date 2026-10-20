// Email bot: anyone who emails a link (Leonardo, Freepik, a shared ChatGPT / Gemini chat, any page...)
// gets the images / videos behind it back as attachments.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { findLinks, getMediaFromLink, stripQuotedText } from './extract.js';
import { sendReply, verifySending } from './mailer.js';
import { checkModesty, moderationDescription, warmUpModeration } from './moderation.js';
import {
  activationOf, checkVerification, consume, linkEmail, maskPhone, normalizePhone, PRICING, quotaFor, setActivation, signOut,
  startVerification, VERIFY, whoIsEmail,
} from './web/accounts.js';
import { detectSite, loadStore, recordStats } from './web/jobs.js';
import { startWebServer } from './web/server.js';

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
  // The subject of a reply ("Re: ...") repeats an earlier subject, so only a fresh subject counts.
  // A reply's subject ("Re: ...") repeats an earlier subject, so its links are not new.
  const incomingSubject = String(mail.subject || '').trim();
  let links = findLinks(mail.text, mail.html || '', incomingSubject);

  // A sender that was asked to link a phone may be answering with the number or the code.
  if (!whoIsEmail(sender).account && activationOf(sender)) {
    const fresh = `${incomingSubject}\n${stripQuotedText(mail.text || '')}`.replace(/https?:\/\/\S+/g, ' ');
    const answer = await activationStep(sender, fresh);
    if (answer && (answer.done ? !links.length : true)) {
      await sendReply(plainReply(mail, replyTo, answer.text));
      log(`activation for ${sender}: ${answer.log}`);
      return;
    }
  }

  if (links.length === 0) {
    log(`no supported link in message from ${sender}, ignoring`);
    return;
  }
  if (rateLimited(sender)) {
    log(`rate limit reached for ${sender}, skipping`);
    return;
  }
  log(`message from ${sender}: ${links.length} link(s)`);

  // Same daily quota as the website (shared when the address is linked to a phone there).
  const who = whoIsEmail(sender);
  const quota = quotaFor(who.key);
  let overQuota = 0;
  if (quota.on && quota.available < links.length) {
    overQuota = links.length - quota.available;
    links = links.slice(0, quota.available);
  }
  if (!links.length) {
    log(`quota used up for ${sender}`);
    if (!who.account && VERIFY !== 'off') {
      // The free trial of an email address is over: from now on it needs a phone (one per person).
      setActivation(sender, { asked: true });
      await sendReply(plainReply(mail, replyTo, ACTIVATION_TEXT));
      return;
    }
    await sendReply(plainReply(mail, replyTo, quotaText(overQuota, who)));
    return;
  }

  const attachments = [];
  const downloadLinks = []; // files too big to attach
  const failures = [];
  const screenshots = [];
  const attachedFrom = []; // source of each attachment, in case they have to be sent as links
  let totalBytes = 0;

  const results = await Promise.allSettled(links.map((link) => getMediaFromLink(link)));
  // Modesty filter: nothing is sent before it is checked.
  let blocked = 0;
  for (const [i, r] of results.entries()) {
    if (r.status !== 'fulfilled') {
      recordStats({ site: detectSite(links[i]).key });
      continue;
    }
    const blockedBefore = blocked;
    const kept = [];
    for (const file of r.value) {
      if (config.moderation !== 'off' && (file.tooLarge || !file.content)) {
        // Too big to download, so it cannot be checked: not sent.
        blocked++;
        log(`not sent (too large to check): ${file.sourceUrl}`);
        continue;
      }
      const verdict = await checkModesty(file);
      if (verdict.allowed) kept.push(file);
      else {
        blocked++;
        log(`blocked ${file.filename} from ${links[i]}: ${verdict.reason}`);
      }
    }
    r.value = kept;
    if (kept.length) consume(who.key);
    recordStats({ site: detectSite(links[i]).key, files: kept, blocked: blocked - blockedBefore });
  }
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failures.push(`${links[i]}\n   ← ${r.reason?.message || r.reason}`);
      log(`link failed: ${links[i]} | ${r.reason?.message || r.reason}${r.reason?.diagnostics ? ` | ${r.reason.diagnostics}` : ''}`);
      // A picture of the page as the bot saw it explains most failures (blocked, login, consent...).
      if (config.debugScreenshots && config.moderation === 'off' && r.reason?.screenshot) {
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
  if (blocked) {
    text += `\n${blocked === 1 ? 'קובץ אחד לא נשלח' : `${blocked} קבצים לא נשלחו`} כי לא עבר${blocked === 1 ? '' : 'ו'} את סינון הצניעות.\n`;
  }
  if (!attachments.length && !downloadLinks.length && !blocked) {
    text += 'לא הצלחתי להוריד תמונה או סרטון מהקישורים ששלחת.\n';
  }
  if (overQuota) text += `\n${quotaText(overQuota, who)}\n`;
  if (failures.length) text += `\nקישורים שלא הצליחו:\n${failures.map((f) => `• ${f}`).join('\n')}\n`;
  if (screenshots.length) text += '\nמצורף צילום מסך של הדף כפי שהבוט ראה אותו.\n';

  text = text.replace(/\n{3,}/g, '\n\n');
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

function quotaText(skipped, who) {
  const site = process.env.PUBLIC_URL;
  let text = `${skipped === 1 ? 'קישור אחד לא טופל' : `${skipped} קישורים לא טופלו`} כי נגמרו ${PRICING.freePerDay} ההורדות החינמיות של היום. ` +
    `מחר יהיו שוב ${PRICING.freePerDay}.`;
  if (site) {
    text += `\nאפשר להוסיף ${PRICING.packSize} הורדות ב-${PRICING.packPrice} ₪ באתר: ${site}`;
    if (!who.account) text += '\n(באתר מחברים את המייל הזה למספר הטלפון, וההורדות שנקנו עובדות גם כאן.)';
  }
  return text;
}

const ACTIVATION_TEXT =
  `נגמרו ${PRICING.emailTrial} ההורדות לניסיון של כתובת המייל הזו.\n` +
  `כדי להמשיך לקבל ${PRICING.freePerDay} הורדות חינם כל יום, צריך לחבר מספר טלפון (פעם אחת בלבד):\n` +
  'השיבו למייל הזה עם מספר הטלפון שלכם (גם טלפון כשר או קו נייח), ותקבלו שיחה עם קוד של 6 ספרות.';

/** Email-only phone linking. Returns { text, log, done } for a reply, or null when there is nothing to answer. */
async function activationStep(sender, fresh) {
  const state = activationOf(sender);
  const phoneText = /(?:\+?972|0)[\d\s-]{8,13}\d/.exec(fresh)?.[0];
  const phone = phoneText && normalizePhone(phoneText);
  if (phone) {
    const r = await startVerification(phone, 'call', `e:${sender}`).catch((err) => ({ error: err.message }));
    if (r.error) return { text: `לא הצלחתי להתקשר: ${r.error}`, log: r.error };
    setActivation(sender, { phone });
    return { text: `מתקשרים עכשיו ל-${maskPhone(phone)} 📞\nהשיבו למייל הזה עם הקוד (6 ספרות) שיוקרא בשיחה.`, log: 'calling' };
  }
  const code = /(?<!\d)\d{6}(?!\d)/.exec(fresh)?.[0];
  if (state.phone && code) {
    const r = await checkVerification(state.phone, code, `e:${sender}`).catch((err) => ({ error: err.message }));
    if (r.error) return { text: `${r.error}. נסו שוב, או שלחו שוב את מספר הטלפון כדי לקבל שיחה חדשה.`, log: r.error };
    signOut(r.token); // email does not need a website session
    const linked = linkEmail(r.phone, sender);
    if (linked.error) return { text: linked.error, log: linked.error };
    setActivation(sender, null);
    return {
      text: `✓ המייל מחובר למספר ${maskPhone(r.phone)}.\nעכשיו יש ${PRICING.freePerDay} הורדות חינם כל יום. שלחו שוב את הקישור.`,
      log: 'linked',
      done: true,
    };
  }
  return { text: ACTIVATION_TEXT, log: 'asked again' };
}

function plainReply(mail, to, body) {
  return {
    to,
    subject: mail.subject ? (/^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`) : 'הקובץ שלך',
    text: `שלום,\n\n${body}\n`,
    attachments: [],
    inReplyTo: mail.messageId,
    references: [...(mail.references ? [].concat(mail.references) : []), mail.messageId].filter(Boolean),
  };
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
  // The website runs alongside the email bot (Railway passes PORT).
  if (process.env.WEB !== 'off') {
    await startWebServer().catch((err) => log('website failed to start:', err.message));
  } else await loadStore(); // the email quota is kept there too
  log(`checking that replies can be sent (${config.sendScriptUrl ? 'Apps Script' : 'SMTP'})...`);
  const via = await verifySending().catch((err) => {
    console.error('Sending check failed:', err.message);
    if (!config.sendScriptUrl) {
      console.error('If this host blocks SMTP ports (e.g. Railway), set SEND_SCRIPT_URL - see README.');
    }
    return null;
  });
  if (!via) {
    // Keep the website running even when email cannot work; retry email in 5 minutes via restart policy.
    log('email bot disabled until sending works (website still running)');
    return;
  }
  log(`replies will be sent via ${via}`);
  log(`modesty filter: ${moderationDescription()}`);
  await warmUpModeration().then(
    (status) => log(`modesty filter ${status}`),
    // Fails closed: until this is fixed, files that need this check are not sent.
    (err) => log(`MODESTY FILTER PROBLEM - files will not be sent until it is fixed: ${err.message}`),
  );
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
