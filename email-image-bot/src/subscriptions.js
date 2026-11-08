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
    const left = imagesLeft(member);
    if (left !== null && left <= 0) {
      return {
        ok: false,
        text: `נגמרו התמונות בחבילה שלך החודש (${member.plan} תמונות, מתחדשת ב-${fmtDate(member.until)}).\n` +
          `אפשר להוסיף עוד חבילה כבר עכשיו:\n${payLines(s)}`,
      };
    }
    const daysLeft = Math.ceil((member.until - Date.now()) / DAY);
    const notes = [];
    // The note goes with this reply, after its image is counted.
    const after = left === null ? null : left - 1;
    if (after !== null && after <= 10) {
      notes.push(after <= 0 ? 'זו הייתה התמונה האחרונה בחבילה החודש.' : after === 1 ? 'נשארה לך תמונה אחת בחבילה החודש.' : `נשארו לך ${after} תמונות בחבילה החודש.`);
    }
    if (daysLeft <= 3 && !member.autoRenew) notes.push(`המנוי שלך מסתיים ב-${fmtDate(member.until)}.`);
    const note = notes.length ? `${notes.join(' ')}\n${payLines(s)}` : '';
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

/** Images left this period (plan + extra packs), or null for an unlimited subscription. */
function imagesLeft(member) {
  if (!member.plan) return null;
  return member.plan - (member.used || 0) + (member.extra || 0);
}

/**
 * After files were actually sent: a trial counts one download per link (the caller calls once per email);
 * a package counts every file, first from the month's images, then from extra packs.
 */
export function recordUse(email, files) {
  const s = subs();
  email = norm(email);
  const member = s.members[email];
  if (s.on && member && member.until > Date.now() && member.plan) {
    const fromPlan = Math.min(files, Math.max(0, member.plan - (member.used || 0)));
    member.used = (member.used || 0) + fromPlan;
    member.extra = Math.max(0, (member.extra || 0) - (files - fromPlan));
  } else if (s.on && !member && email !== s.owner) {
    s.trials[email] = (s.trials[email] || 0) + 1;
  }
  saveStore();
}

/** A paid month of a package (from the owner's command now, from PayPal later). */
export function grantPlan(email, plan, days = 30, extra = {}) {
  const s = subs();
  email = norm(email);
  const member = (s.members[email] ||= { since: Date.now(), until: Date.now() });
  member.until = Math.max(member.until, Date.now()) + days * DAY;
  member.plan = plan;
  member.used = 0;
  Object.assign(member, extra);
  saveStore();
  return member;
}

/** An extra pack of images on top of the month's package (they last until used). */
export function grantExtra(email, images) {
  const s = subs();
  email = norm(email);
  const member = s.members[email];
  if (!member || member.until <= Date.now()) return null;
  member.extra = (member.extra || 0) + images;
  saveStore();
  return member;
}

export const ownerEmail = () => subs().owner;

const HELP = `פקודות (שולחים מייל לבוט עם המילה הסודית ועם הפקודה, כל פקודה בשורה משלה):

חבילה user@gmail.com 50     חבילה של 50 תמונות לחודש (או 100), החל מהיום
תוספת user@gmail.com 50     עוד 50 תמונות לחודש הנוכחי (למי שגמר את החבילה)
הוסף user@gmail.com 30      מנוי בלי הגבלת תמונות ל-30 יום (או הארכה)
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
  // "תשלום:" can span several lines: it takes the lines after it until one that is another command.
  const COMMAND = /^\s*(?:הוסף|add|חבילה|plan|תוספת|extra|הסר|מחק|remove|רשימה|מנויים|list|הפעל מנויים|כבה מנויים|subscriptions|מחיר|price|ניסיון|trial|עזרה|help|יומן|log)(?:\s|$)/i;
  const lines = fresh.split('\n');
  const payAt = lines.findIndex((l) => /^\s*(?:תשלום|pay)\s*:/i.test(l));
  if (payAt >= 0) {
    let end = payAt + 1;
    while (end < lines.length && !COMMAND.test(lines[end])) end++;
    const text = [lines[payAt].replace(/^\s*(?:תשלום|pay)\s*:\s*/i, ''), ...lines.slice(payAt + 1, end)].join('\n');
    s.payText = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
    lines.splice(payAt, end - payAt);
    fresh = lines.join('\n');
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
    } else if ((m = /^(?:חבילה|plan)\s+(\S+@\S+?)\s+(\d{1,5})\s*$/i.exec(line))) {
      const member = grantPlan(m[1], Number(m[2]));
      out.push(`✓ ${norm(m[1])}: חבילה של ${m[2]} תמונות לחודש, עד ${fmtDate(member.until)}`);
    } else if ((m = /^(?:תוספת|extra)\s+(\S+@\S+?)\s+(\d{1,5})\s*$/i.exec(line))) {
      const member = grantExtra(m[1], Number(m[2]));
      out.push(member ? `✓ ${norm(m[1])}: עוד ${m[2]} תמונות (יש לו עכשיו ${imagesLeft(member) ?? 'ללא הגבלה'})` : `${norm(m[1])} אינו מנוי פעיל. קודם: חבילה ${norm(m[1])} 50`);
    } else if ((m = /^(?:הסר|מחק|remove)\s+(\S+@\S+?)\s*$/i.exec(line))) {
      const email = norm(m[1]);
      out.push(s.members[email] ? `✓ ${email} הוסר` : `${email} לא היה ברשימה`);
      delete s.members[email];
    } else if (/^(?:רשימה|מנויים|list)$/i.test(line)) {
      const rows = Object.entries(s.members)
        .sort((a, b) => a[1].until - b[1].until)
        .map(([email, mem]) => {
          const pkg = mem.plan ? ` · חבילת ${mem.plan}: נוצלו ${mem.used || 0}${mem.extra ? ` (+${mem.extra} תוספת)` : ''}` : '';
          return `${mem.until > Date.now() ? '✓' : '✗'} ${email} – עד ${fmtDate(mem.until)}${pkg}`;
        });
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
