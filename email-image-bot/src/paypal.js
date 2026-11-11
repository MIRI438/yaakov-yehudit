// PayPal: monthly packages as PayPal subscriptions that renew by themselves, and one-time extra packs.
// The bot puts PayPal's own payment links in its emails (PayPal is reachable where the bot's website may be
// filtered), then checks PayPal every few minutes: a new subscription, a renewal or a paid extra pack opens
// the images for that email address; a cancelled subscription simply is not renewed.
// The keys are given by the owner in an email command and kept only in the server's data (never in the code).

import { allMembers, grantExtra, grantPlan, paypalSettings, savePaypal } from './subscriptions.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

export const PACKAGES = { 50: 5, 100: 8 }; // images a month -> shekels
const API = () => (process.env.PAYPAL_API || (paypalSettings().sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'));

let token = null;
let tokenUntil = 0;

export const paypalReady = () => Boolean(paypalSettings().id && paypalSettings().secret && paypalSettings().plans?.[50]);

async function api(method, path, body) {
  const pp = paypalSettings();
  if (!token || Date.now() > tokenUntil) {
    const res = await fetch(`${API()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${pp.id}:${pp.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PayPal login failed (${res.status}): ${data.error_description || data.error || 'unknown'}`);
    token = data.access_token;
    tokenUntil = Date.now() + (data.expires_in - 120) * 1000;
  }
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal ${method} ${path.split('?')[0]} (${res.status}): ${data.message || data.name || 'error'}`);
  return data;
}

/** After the owner gives the keys: checks them and creates the product and the two monthly plans once. */
export async function setupPaypal() {
  token = null;
  const pp = paypalSettings();
  pp.plans ||= {};
  if (!pp.product) {
    const product = await api('POST', '/v1/catalogs/products', { name: 'Linkra – תמונות במייל', type: 'SERVICE', category: 'SOFTWARE' });
    pp.product = product.id;
  }
  for (const [images, price] of Object.entries(PACKAGES)) {
    if (pp.plans[images]) continue;
    const plan = await api('POST', '/v1/billing/plans', {
      product_id: pp.product,
      name: `${images} תמונות בחודש`,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: String(price), currency_code: 'ILS' } },
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
    });
    pp.plans[images] = plan.id;
  }
  savePaypal();
  return `PayPal מחובר ✓ (חבילות: ${Object.entries(PACKAGES).map(([i, p]) => `${i} תמונות ב-₪${p}`).join(', ')})`;
}

const site = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const context = (action) => ({
  brand_name: 'Linkra',
  locale: 'he-IL',
  shipping_preference: 'NO_SHIPPING',
  user_action: action,
  ...(site() ? { return_url: `${site()}/paid`, cancel_url: `${site()}/paid?cancel=1` } : {}),
});

/** A PayPal link for a monthly package that renews by itself. */
async function subscribeLink(email, images) {
  const sub = await api('POST', '/v1/billing/subscriptions', {
    plan_id: paypalSettings().plans[images],
    custom_id: email,
    application_context: context('SUBSCRIBE_NOW'),
  });
  paypalSettings().pending.push({ kind: 'sub', id: sub.id, email, images: Number(images), at: Date.now() });
  savePaypal();
  return sub.links.find((l) => l.rel === 'approve').href;
}

/** A PayPal link for a one-time extra pack. */
async function extraLink(email, images) {
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: email,
      description: `תוספת ${images} תמונות`,
      amount: { currency_code: 'ILS', value: PACKAGES[images].toFixed(2) },
    }],
    application_context: context('PAY_NOW'),
  });
  paypalSettings().pending.push({ kind: 'order', id: order.id, email, images: Number(images), at: Date.now() });
  savePaypal();
  return order.links.find((l) => l.rel === 'approve').href;
}

/** The payment part of a reply: PayPal links for a package ('subscribe') or an extra pack ('extra'). */
export async function paymentText(email, kind) {
  if (!paypalReady()) return null;
  try {
    const lines = [];
    for (const [images, price] of Object.entries(PACKAGES)) {
      const link = kind === 'extra' ? await extraLink(email, images) : await subscribeLink(email, images);
      lines.push(kind === 'extra'
        ? `• עוד ${images} תמונות – ₪${price}:\n${link}`
        : `• ${images} תמונות בחודש – ₪${price} לחודש (מתחדש לבד, אפשר לבטל מתי שרוצים ב-PayPal):\n${link}`);
    }
    return `${lines.join('\n\n')}\n\nאחרי התשלום החבילה נפתחת תוך כמה דקות, ותגיע הודעת אישור.\nהקישורים בתוקף לכמה שעות. אם עבר זמן, שלחו שוב קישור ויישלחו קישורים חדשים.`;
  } catch (err) {
    log('PayPal link failed:', err.message);
    return null;
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** Checks PayPal for new payments. `notify(email, text)` sends the customer a confirmation. */
export async function checkPayments(notify) {
  if (!paypalReady()) return;
  const pp = paypalSettings();
  // Links that were paid (or are still waiting to be paid).
  for (const p of [...pp.pending]) {
    try {
      if (p.kind === 'sub') {
        const sub = await api('GET', `/v1/billing/subscriptions/${p.id}`);
        if (sub.status === 'ACTIVE') {
          const member = grantPlan(p.email, p.images, 30, { autoRenew: true, subId: p.id, paidAt: sub.billing_info?.last_payment?.time || new Date().toISOString() });
          drop(p);
          log(`PayPal: subscription ${p.id} active for ${p.email} (${p.images} images)`);
          await notify(p.email, `✓ התשלום התקבל. יש לך ${p.images} תמונות לחודש, עד ${new Date(member.until).toLocaleDateString('he-IL')}.\nהמנוי מתחדש לבד כל חודש. אפשר לבטל אותו מתי שרוצים בחשבון ה-PayPal.\nעכשיו אפשר לשלוח קישורים.`);
          continue;
        }
      } else {
        let order = await api('GET', `/v2/checkout/orders/${p.id}`);
        if (order.status === 'APPROVED') order = await api('POST', `/v2/checkout/orders/${p.id}/capture`, {});
        if (order.status === 'COMPLETED') {
          const member = grantExtra(p.email, p.images);
          drop(p);
          log(`PayPal: extra pack ${p.id} paid by ${p.email} (${p.images} images)`);
          await notify(p.email, member
            ? `✓ התשלום התקבל. נוספו לך ${p.images} תמונות. אפשר להמשיך לשלוח קישורים.`
            : `✓ התשלום התקבל, אבל לא מצאתי מנוי פעיל לכתובת הזו. כתבו לנו ונסדר את זה.`);
          continue;
        }
      }
    } catch (err) {
      log(`PayPal check of ${p.id} failed: ${err.message}`);
    }
    if (Date.now() - p.at > 3 * DAY) drop(p); // a link nobody paid
  }
  // Renewals and cancellations of running subscriptions (a few times a day is enough).
  if (Date.now() - (pp.renewalsCheckedAt || 0) > 4 * 60 * 60 * 1000) {
    pp.renewalsCheckedAt = Date.now();
    for (const [email, member] of subscribers()) {
      try {
        const sub = await api('GET', `/v1/billing/subscriptions/${member.subId}`);
        const paidAt = sub.billing_info?.last_payment?.time;
        if (sub.status === 'ACTIVE' && paidAt && paidAt !== member.paidAt) {
          grantPlan(email, member.plan, 30, { autoRenew: true, subId: member.subId, paidAt });
          log(`PayPal: renewal for ${email}`);
        } else if (['CANCELLED', 'SUSPENDED', 'EXPIRED'].includes(sub.status) && member.autoRenew) {
          member.autoRenew = false; // the month already paid for still runs out normally
          log(`PayPal: subscription of ${email} is ${sub.status}`);
        }
      } catch (err) {
        log(`PayPal renewal check for ${email} failed: ${err.message}`);
      }
    }
    savePaypal();
  }
}

function drop(p) {
  const pp = paypalSettings();
  pp.pending = pp.pending.filter((x) => x !== p);
  savePaypal();
}

function subscribers() {
  return Object.entries(allMembers()).filter(([, m]) => m.subId && m.until > Date.now() - 7 * DAY);
}
