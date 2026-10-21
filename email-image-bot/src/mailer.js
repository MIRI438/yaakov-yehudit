// Sends the reply email, either over SMTP or, where SMTP ports are blocked (e.g. Railway),
// over HTTPS through a small Google Apps Script running in the bot's Gmail account
// (deploy/gmail-send-relay.gs).

import nodemailer from 'nodemailer';
import { config } from './config.js';
import { dropStash, stashFile } from './stash.js';

// A relay that sends over Gmail SMTP (deploy/vercel-mail-relay): about 500 emails a day instead of 100.
const RELAY_URL = process.env.MAIL_RELAY_URL || '';
const RELAY_SECRET = process.env.MAIL_RELAY_SECRET || '';
// Vercel takes at most 4.5MB per request; bigger attachments go as links the relay downloads.
const RELAY_INLINE_BYTES = 3 * 1024 * 1024;

let transporter;

function smtp() {
  transporter ??= nodemailer.createTransport({
    ...config.smtp,
    auth: { user: config.email, pass: config.password },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
  return transporter;
}

/** Checks at startup that replies can be sent; throws with a readable message if not. */
export async function verifySending() {
  if (RELAY_URL) {
    const res = await callRelay({ action: 'ping' }, 30000);
    if (!res.ok) throw new Error(`mail relay: ${res.error || 'unknown error'}`);
    if (!process.env.PUBLIC_URL) console.warn('PUBLIC_URL is not set: attachments over 3MB cannot go through the mail relay');
    return `mail relay (${res.email || 'ok'})`;
  }
  if (config.sendScriptUrl) {
    const res = await callScript({ action: 'ping' }, 30000);
    if (!res.ok) throw new Error(`Apps Script: ${res.error || 'unknown error'}`);
    return `Apps Script (${res.email || 'ok'})`;
  }
  await smtp().verify();
  return `SMTP ${config.smtp.host}`;
}

/**
 * @param {{to: string, subject: string, text: string, inReplyTo?: string, references?: string[],
 *          attachments: {filename: string, content: Buffer, contentType: string}[]}} msg
 */
export async function sendReply(msg) {
  if (RELAY_URL) return sendThroughRelay(msg);
  if (config.sendScriptUrl) {
    const res = await callScript({
      action: 'send',
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      inReplyTo: msg.inReplyTo,
      attachments: msg.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content.toString('base64'),
      })),
    });
    if (!res.ok) throw new Error(`Apps Script: ${res.error || 'unknown error'}`);
    return;
  }
  await smtp().sendMail({
    from: config.email,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    attachments: msg.attachments,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    headers: { 'Auto-Submitted': 'auto-replied' },
  });
}

// Google stops a script after 6 minutes, so waiting longer than that is pointless.
const SCRIPT_SEND_TIMEOUT_MS = Number(process.env.SEND_SCRIPT_TIMEOUT_SECONDS || 390) * 1000;

async function callScript(payload, timeoutMs = SCRIPT_SEND_TIMEOUT_MS) {
  // Apps Script answers a POST with a redirect to the result, which fetch follows.
  const res = await fetch(config.sendScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: config.sendScriptSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    // An HTML page here usually means the web app is not deployed with access "Anyone".
    throw new Error(`Apps Script returned HTTP ${res.status} instead of JSON (check the deployment access)`);
  }
}

async function callRelay(payload, timeoutMs = 120000) {
  const res = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: RELAY_SECRET }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`mail relay returned HTTP ${res.status} instead of JSON`);
  }
}

async function sendThroughRelay(msg) {
  const total = msg.attachments.reduce((n, a) => n + a.content.length, 0);
  const tokens = [];
  try {
    const attachments = [];
    for (const a of msg.attachments) {
      const link = total > RELAY_INLINE_BYTES ? await stashFile(a.content, a.filename) : null;
      if (link) tokens.push(link.token);
      attachments.push(
        link
          ? { filename: a.filename, contentType: a.contentType, url: link.url }
          : { filename: a.filename, contentType: a.contentType, content: a.content.toString('base64') },
      );
    }
    const res = await callRelay({
      action: 'send',
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      attachments,
    });
    if (!res.ok) throw new Error(`mail relay: ${res.error || 'unknown error'}`);
  } finally {
    for (const t of tokens) await dropStash(t).catch(() => {});
  }
}
