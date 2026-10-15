// Who is using the service and how much they have left today.
//
// The account is a phone number, verified once with a voice call (many kosher phones have no SMS).
// An email address can be linked to it, so the email bot and the website share one quota and one balance.
// Free downloads every day, then paid packs that do not expire.
// A "download" is one link that came back with files; failed links are free.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { onJobDone, saveStore, store } from './jobs.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

export const PRICING = {
  freePerDay: Number(process.env.FREE_PER_DAY || 8),
  // An email address that is not linked to a phone gets this many free downloads once, then has to link one.
  emailTrial: Number(process.env.EMAIL_TRIAL || 8),
  packSize: Number(process.env.PACK_SIZE || 10),
  packPrice: Number(process.env.PACK_PRICE || 2), // shekels
};
const quotaOn = () => process.env.QUOTA !== 'off';
// Free downloads also follow the device, so switching phones on the same device does not add more:
// the browser (cookie) gets freePerDay a day in total, and a device signature (survives clearing cookies)
// can give free downloads to at most this many phone numbers a day.
const PHONES_PER_DEVICE = Number(process.env.FREE_PHONES_PER_DEVICE || 2);

// twilio = real calls (Twilio Verify), demo = the code is written to the log (testing only),
// off = no phone needed (the quota then follows the browser cookie, which is easy to reset).
export const VERIFY = process.env.PHONE_VERIFY || (process.env.TWILIO_VERIFY_SID ? 'twilio' : 'off');
const VERIFY_PER_PHONE_PER_HOUR = 3;
const VERIFY_PER_VISITOR_PER_HOUR = 5;
const VERIFY_PER_DAY = Number(process.env.VERIFY_MAX_PER_DAY || 300); // every call costs money

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

function db() {
  const d = store();
  d.accounts ||= {}; // phone -> { phone, emails, credits, createdAt }
  d.sessions ||= {}; // token -> phone
  d.credits ||= {}; // quota key -> credits (for keys that are not accounts)
  if (d.usage?.day !== today()) d.usage = { day: today(), counts: {}, verifications: 0 };
  d.usage.counts ||= {}; // key -> downloads today; d:<browser> -> free downloads today
  d.usage.devices ||= {}; // device signature -> keys that got free downloads today
  d.trials ||= {}; // email -> free downloads used before linking a phone
  return d;
}

// ---------- phone numbers ----------

/** Israeli mobile or landline (kosher phones are often landlines) -> +972... ; null if not valid. */
export function normalizePhone(input) {
  let digits = String(input || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+972')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  if (!/^0(5\d{8}|[23489]\d{7}|7\d{8})$/.test(digits)) return null;
  return `+972${digits.slice(1)}`;
}

export const maskPhone = (phone) => {
  const local = `0${phone.slice(4)}`;
  return `${local.slice(0, 3)}-•••-${local.slice(-4)}`;
};

// ---------- verification calls ----------

const attempts = new Map(); // key -> [timestamps]
function tooMany(key, max) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const times = (attempts.get(key) || []).filter((t) => t > hourAgo);
  if (times.length >= max) return true;
  times.push(Date.now());
  attempts.set(key, times);
  return false;
}

const demoCodes = new Map(); // phone -> code (demo mode)

async function twilio(path, params) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SID}/${path}`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message || 'error'}`);
  return body;
}

/** Calls the number (or texts it) with a 6-digit code. */
export async function startVerification(rawPhone, channel, visitor) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: 'מספר טלפון לא תקין' };
  if (tooMany(`p:${phone}`, VERIFY_PER_PHONE_PER_HOUR) || tooMany(`v:${visitor}`, VERIFY_PER_VISITOR_PER_HOUR)) {
    return { error: 'יותר מדי ניסיונות. נסו שוב בעוד שעה.' };
  }
  const d = db();
  if (d.usage.verifications >= VERIFY_PER_DAY) return { error: 'האימות עמוס כרגע. נסו שוב מחר.' };
  d.usage.verifications++;
  saveStore();
  if (VERIFY === 'twilio') {
    const params = { To: phone, Channel: channel === 'sms' ? 'sms' : 'call' };
    // Hebrew if Twilio can speak it; otherwise it picks the language from the number.
    await twilio('Verifications', { ...params, Locale: 'he' }).catch(() => twilio('Verifications', params));
  } else {
    const code = String(randomInt(100000, 1000000));
    demoCodes.set(phone, code);
    log(`verification code for ${maskPhone(phone)}: ${code} (demo, no call made)`);
  }
  return { ok: true, phone: maskPhone(phone) };
}

/** Checks the code; on success returns a session token for the cookie. */
export async function checkVerification(rawPhone, code, visitor) {
  const phone = normalizePhone(rawPhone);
  code = String(code || '').replace(/\D/g, '');
  if (!phone || code.length < 4) return { error: 'קוד שגוי' };
  if (tooMany(`c:${phone}`, 8)) return { error: 'יותר מדי ניסיונות. נסו שוב בעוד שעה.' };
  let ok;
  if (VERIFY === 'twilio') ok = (await twilio('VerificationCheck', { To: phone, Code: code })).status === 'approved';
  else {
    const expected = demoCodes.get(phone) || '';
    ok = expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code));
    if (ok) demoCodes.delete(phone);
  }
  if (!ok) return { error: 'קוד שגוי' };

  const d = db();
  const account = (d.accounts[phone] ||= { phone, emails: [], credits: 0, createdAt: Date.now() });
  // Downloads bought before verifying (on this browser) move to the account.
  const before = d.credits[`v:${visitor}`] || 0;
  if (before) {
    account.credits += before;
    delete d.credits[`v:${visitor}`];
  }
  const token = randomBytes(24).toString('base64url');
  d.sessions[token] = phone;
  saveStore();
  log(`phone verified: ${maskPhone(phone)}`);
  return { ok: true, token, phone };
}

export function signOut(token) {
  delete db().sessions[token];
  saveStore();
}

// ---------- linking an email address ----------

const emailCodes = new Map(); // phone -> { email, code, exp, tries }
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200;

export async function startEmailLink(phone, rawEmail, sendMail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!validEmail(email)) return { error: 'כתובת מייל לא תקינה' };
  if (tooMany(`e:${phone}`, 5)) return { error: 'יותר מדי ניסיונות. נסו שוב בעוד שעה.' };
  const owner = accountByEmail(email);
  if (owner && owner.phone !== phone) return { error: 'המייל הזה כבר מחובר למספר אחר' };
  const code = String(randomInt(100000, 1000000));
  emailCodes.set(phone, { email, code, exp: Date.now() + 15 * 60 * 1000, tries: 0 });
  await sendMail({
    to: email,
    subject: `קוד האימות שלך: ${code}`,
    text: `שלום,\n\nקוד האימות לחיבור המייל ל-Linkra: ${code}\n\nאם לא ביקשת את זה, אפשר להתעלם מההודעה.\n`,
    attachments: [],
  });
  return { ok: true };
}

export function checkEmailLink(phone, code) {
  const pending = emailCodes.get(phone);
  if (!pending || pending.exp < Date.now() || ++pending.tries > 5) return { error: 'הקוד פג. שלחו שוב.' };
  if (pending.code !== String(code || '').replace(/\D/g, '')) return { error: 'קוד שגוי' };
  emailCodes.delete(phone);
  const account = db().accounts[phone];
  if (!account.emails.includes(pending.email)) account.emails.push(pending.email);
  saveStore();
  return { ok: true };
}

export function unlinkEmail(phone, email) {
  const account = db().accounts[phone];
  account.emails = account.emails.filter((e) => e !== email);
  saveStore();
}

export const accountByEmail = (email) =>
  Object.values(db().accounts).find((a) => a.emails.includes(String(email).toLowerCase())) || null;

// ---------- who is asking ----------

/**
 * The quota key for a website request: the verified phone, or (without phone verification) the browser.
 * needsPhone: verification is on and this browser has not verified yet.
 */
export function whoIs(sessionToken, visitor) {
  const d = db();
  const phone = sessionToken && d.sessions[sessionToken];
  const account = phone ? d.accounts[phone] : null;
  if (account) return { key: `p:${phone}`, account };
  return { key: `v:${visitor}`, account: null, needsPhone: VERIFY !== 'off' };
}

/** The quota key for an email sender: the account it is linked to, or the address itself. */
export function whoIsEmail(sender) {
  const account = accountByEmail(sender);
  return account ? { key: `p:${account.phone}`, account } : { key: `e:${sender.toLowerCase()}`, account: null };
}

function creditsOf(key) {
  const d = db();
  return key.startsWith('p:') ? d.accounts[key.slice(2)]?.credits || 0 : d.credits[key] || 0;
}

function freeLeftFor(key, { browser, device } = {}) {
  const d = db();
  // Without phone checks there is nothing to link, so an address simply gets the daily amount.
  if (key.startsWith('e:') && VERIFY !== 'off') return Math.max(0, PRICING.emailTrial - (d.trials[key.slice(2)] || 0));
  let left = PRICING.freePerDay - (d.usage.counts[key] || 0);
  if (browser) left = Math.min(left, PRICING.freePerDay - (d.usage.counts[`d:${browser}`] || 0));
  const others = (d.usage.devices[device] || []).filter((k) => k !== key);
  if (device && others.length >= PHONES_PER_DEVICE) left = 0;
  return Math.max(0, left);
}

/**
 * pending: links of this key that are still being processed (they will use the quota).
 * where: { browser, device } of the request (website only).
 */
export function quotaFor(key, pending = 0, where = {}) {
  const used = db().usage.counts[key] || 0;
  const freeLeft = freeLeftFor(key, where);
  const credits = creditsOf(key);
  return {
    on: quotaOn(),
    usedToday: used,
    freeLeft: quotaOn() ? freeLeft : null,
    credits,
    // The phone still has free downloads, but this device already used today's.
    byDevice: freeLeft < freeLeftFor(key),
    available: quotaOn() ? Math.max(0, freeLeft + credits - pending) : null,
    ...PRICING,
  };
}

/** One successful link: a free download if any are left, otherwise a paid one. */
export function consume(key, where = {}) {
  if (!quotaOn() || !key) return;
  const d = db();
  if (freeLeftFor(key, where) > 0) {
    if (key.startsWith('e:') && VERIFY !== 'off') d.trials[key.slice(2)] = (d.trials[key.slice(2)] || 0) + 1;
    if (where.browser) d.usage.counts[`d:${where.browser}`] = (d.usage.counts[`d:${where.browser}`] || 0) + 1;
    if (where.device) {
      const keys = (d.usage.devices[where.device] ||= []);
      if (!keys.includes(key)) keys.push(key);
    }
  } else if (key.startsWith('p:') && d.accounts[key.slice(2)]?.credits > 0) d.accounts[key.slice(2)].credits--;
  else if (d.credits[key] > 0) d.credits[key]--;
  d.usage.counts[key] = (d.usage.counts[key] || 0) + 1;
  saveStore();
}

/** After a successful payment: add packs of downloads (they do not expire). */
export function addCredits(key, packs = 1, payment = {}) {
  const d = db();
  const amount = packs * PRICING.packSize;
  if (key.startsWith('p:') && d.accounts[key.slice(2)]) d.accounts[key.slice(2)].credits += amount;
  else d.credits[key] = (d.credits[key] || 0) + amount;
  (d.payments ||= []).push({ key, packs, amount: packs * PRICING.packPrice, at: Date.now(), ...payment });
  saveStore();
  log(`credits: +${amount} (${payment.provider || 'unknown'})`);
}

export const publicAccount = (account) =>
  account && { phone: maskPhone(account.phone), emails: account.emails, credits: account.credits };

/** The email bot links the address after the phone answered with the right code. */
export function linkEmail(phone, email) {
  email = email.toLowerCase();
  const owner = accountByEmail(email);
  if (owner && owner.phone !== phone) return { error: 'המייל הזה כבר מחובר למספר אחר' };
  const d = db();
  const account = (d.accounts[phone] ||= { phone, emails: [], credits: 0, createdAt: Date.now() });
  if (!account.emails.includes(email)) account.emails.push(email);
  saveStore();
  return { ok: true };
}

/** Email-only activation (no website needed): asked for a phone -> called it -> got the code. */
export const activationOf = (email) => db().activations?.[email.toLowerCase()] || null;
export function setActivation(email, state) {
  const d = db();
  d.activations ||= {};
  if (state) d.activations[email.toLowerCase()] = { ...state, at: Date.now() };
  else delete d.activations[email.toLowerCase()];
  saveStore();
}

onJobDone((job) => consume(job.owner, job.where));
