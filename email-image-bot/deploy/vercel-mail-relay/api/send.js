// Sends the bot's replies from its Gmail account over SMTP (port 465), for hosts that block SMTP (Railway).
// Gmail allows about 500 emails a day this way, against about 100 through Apps Script.
//
// Vercel environment variables: GMAIL_USER, GMAIL_APP_PASSWORD, RELAY_SECRET.
// Vercel accepts at most 4.5MB per request, so big attachments come as https links the relay downloads.

import nodemailer from 'nodemailer';

let transporter;
const smtp = () =>
  (transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', // only for testing; Gmail by default
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') },
  }));

export default async function handler(req, res) {
  const reply = (status, body) => res.status(status).json(body);
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const msg = req.body || {};
  if (!process.env.RELAY_SECRET || msg.secret !== process.env.RELAY_SECRET) return reply(401, { ok: false, error: 'bad secret' });

  try {
    if (msg.action === 'ping') {
      await smtp().verify();
      return reply(200, { ok: true, email: process.env.GMAIL_USER });
    }
    if (msg.action !== 'send') return reply(400, { ok: false, error: 'unknown action' });

    const attachments = (msg.attachments || []).map((a) => {
      if (a.url) {
        if (!/^https?:\/\//.test(a.url)) throw new Error('attachment links must be web links');
        return { filename: a.filename, contentType: a.contentType, path: a.url };
      }
      return { filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content || '', 'base64') };
    });
    await smtp().sendMail({
      from: process.env.GMAIL_USER,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      attachments,
      inReplyTo: msg.inReplyTo || undefined,
      references: msg.references?.length ? msg.references : undefined,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    return reply(200, { ok: true });
  } catch (err) {
    return reply(200, { ok: false, error: String(err?.message || err) });
  }
}
