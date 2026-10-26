// Monthly subscriptions: only subscribers (and a few trial downloads for new people) get files back.
// The owner manages everything by email, which works even where websites are filtered: an email that
// contains LOGS_KEY and a command, e.g. "הוסף dana@gmail.com 30". The first address to send a command
// becomes the owner (always served, gets the reports).

import { saveStore, store } from './web/jobs.js';

const DAY = 24 * 60 * 60 * 1000;
const fmtDate = (t) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

function subs() {
  const d = store();
  d.subs ||= {
    on: false, // off until the owner turns it on, so nobody is blocked by surprise
    price: '',
    payText: '',
    trial: 3, // free downloads for someone who never subscribed, so they see that it works
    owner: '',
    members: {}, // email -> { until, since }
    trials: {}, // email -> downloads used
  };
  return d.subs;
}

const norm = (email) => String(email || '').trim().toLowerCase().replace(/^mailto:/, '');

/**
 * Can this address get files now? { ok, why, note } — `note` is a line to add to the reply
 * (trial downloads left, subscription about to end); when not ok, `text` is the reply to send instead.
 */
export function access(email) {
  const s = subs();
  email = norm(email);
  if (!s.on) return { ok: true, why: 'off' };
  if (email && email === s.owner) return { ok: true, why: 'owner' };
  const member = s.members[email];
  if (member && member.until > Date.now()) {
    const daysLeft = Math.ceil((member.until - Date.now()) / DAY);
    const note = daysLeft <= 3 ? `המנוי שלך מסתיים ב-${fmtDate(member.until)}. כדי להמשיך בלי הפסקה:\n${payLines(s)}` : '';
    return { ok: true, why: 'member', note };
  }
  const used = s.trials[email] || 0;
  if (!member && used < s.trial) {
    const left = s.trial - used - 1;
    const note = left > 0
      ? `זו הורדה לניסיון (נשארו עוד ${left}). אחר כך השירות למנויים בלבד:\n${payLines(s)}`
      : `זו הייתה ההורדה האחרונה לניסיון. מעכשיו השירות למנויים בלבד:\n${payLines(s)}`;
    return { ok: true, why: 'trial', note };
  }
  const head = member ? `המנוי שלך הסתיים ב-${fmtDate(member.until)}.` : 'השירות הזה פתוח למנויים בלבד.';
  return { ok: false, text: `${head}\n\n${payLines(s)}` };
}

function payLines(s) {
  const lines = [];
  if (s.price) lines.push(`מחיר: ${s.price}`);
  lines.push(s.payText || 'לפרטים על המנוי אפשר להשיב למייל הזה.');
  return lines.join('\n');
}

/** Counts a trial download (call only when files were actually sent). */
export function usedTrial(email) {
  const s = subs();
  email = norm(email);
  s.trials[email] = (s.trials[email] || 0) + 1;
  saveStore();
}

export const ownerEmail = () => subs().owner;

const HELP = `פקודות (שולחים מייל לבוט עם המילה הסודית ועם הפקודה, כל פקודה בשורה משלה):

הוסף user@gmail.com 30      מוסיף מנוי ל-30 יום (או מאריך מנוי קיים ב-30 יום)
הסר user@gmail.com           מבטל מנוי
רשימה                         כל המנויים ועד מתי
הפעל מנויים / כבה מנויים     האם השירות למנויים בלבד
מחיר 20 ש"ח לחודש             המחיר שמופיע במייל למי שאינו מנוי
תשלום: ...                    הוראות התשלום (כל מה שאחרי הנקודתיים, גם כמה שורות)
ניסיון 3                      כמה הורדות חינם מקבל מי שעוד לא נרשם (0 = בלי ניסיון)
יומן                          היומן של הבוט כקובץ מצורף`;

/**
 * Owner commands. Returns { text, log } for the reply, or null when the email has no command
 * (then the caller sends the log, as before).
 */
export function adminCommand(sender, fresh) {
  const s = subs();
  const out = [];
  let wantsLog = false;
  // "תשלום:" takes the rest of the email, so it is read first and removed.
  const pay = /(?:^|\n)\s*(?:תשלום|pay)\s*:\s*([\s\S]+)$/i.exec(fresh);
  if (pay) {
    s.payText = pay[1].replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
    fresh = fresh.slice(0, pay.index);
    out.push('הוראות התשלום עודכנו.');
  }
  for (const raw of fresh.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = /^(?:הוסף|add)\s+(\S+@\S+?)(?:\s+(\d{1,4}))?\s*$/i.exec(line))) {
      const email = norm(m[1]);
      const days = Number(m[2] || 30);
      const member = (s.members[email] ||= { since: Date.now(), until: Date.now() });
      member.until = Math.max(member.until, Date.now()) + days * DAY;
      out.push(`✓ ${email}: מנוי עד ${fmtDate(member.until)}`);
    } else if ((m = /^(?:הסר|מחק|remove)\s+(\S+@\S+?)\s*$/i.exec(line))) {
      const email = norm(m[1]);
      out.push(s.members[email] ? `✓ ${email} הוסר` : `${email} לא היה ברשימה`);
      delete s.members[email];
    } else if (/^(?:רשימה|מנויים|list)$/i.test(line)) {
      const rows = Object.entries(s.members)
        .sort((a, b) => a[1].until - b[1].until)
        .map(([email, mem]) => `${mem.until > Date.now() ? '✓' : '✗'} ${email} – עד ${fmtDate(mem.until)}`);
      out.push(rows.length ? `מנויים (${rows.length}):\n${rows.join('\n')}` : 'אין עדיין מנויים.');
    } else if (/^(?:הפעל מנויים|subscriptions on)$/i.test(line)) {
      s.on = true;
      out.push('✓ השירות פתוח עכשיו למנויים בלבד' + (s.payText ? '.' : '. שימי לב: עוד לא הוגדרו הוראות תשלום (תשלום: ...).'));
    } else if (/^(?:כבה מנויים|subscriptions off)$/i.test(line)) {
      s.on = false;
      out.push('✓ השירות פתוח עכשיו לכולם, בלי בדיקת מנוי.');
    } else if ((m = /^(?:מחיר|price)\s+(.+)$/i.exec(line))) {
      s.price = m[1].trim().slice(0, 100);
      out.push(`✓ המחיר: ${s.price}`);
    } else if ((m = /^(?:ניסיון|trial)\s+(\d{1,3})$/i.exec(line))) {
      s.trial = Number(m[1]);
      out.push(`✓ הורדות ניסיון למי שעוד לא נרשם: ${s.trial}`);
    } else if (/^(?:עזרה|help)$/i.test(line)) {
      out.push(HELP);
    } else if (/^(?:יומן|log)$/i.test(line)) {
      wantsLog = true;
    }
  }
  if (!out.length && !wantsLog) return null;
  if (!s.owner) s.owner = norm(sender);
  saveStore();
  const state = `\n\nמצב: ${s.on ? 'למנויים בלבד' : 'פתוח לכולם'} · מנויים פעילים: ${
    Object.values(s.members).filter((m) => m.until > Date.now()).length
  } · ניסיון: ${s.trial}`;
  return { text: out.join('\n\n') + state, wantsLog, log: out.join(' | ').slice(0, 200) };
}
