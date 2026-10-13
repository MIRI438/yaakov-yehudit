// Sends the reply email, either over SMTP or, where SMTP ports are blocked (e.g. Railway),
// over HTTPS through a small Google Apps Script running in the bot's Gmail account
// (deploy/gmail-send-relay.gs).

import nodemailer from 'nodemailer';
import { config } from './config.js';

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
