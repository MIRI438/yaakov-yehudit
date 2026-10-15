// Linkra front end: paste a link, watch it work, use the files (studio), find past ones (drawer).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PREVIEW = Boolean(window.__LINKRA_PREVIEW__);

// ---------- sites ----------

const SITES = [
  ['Gemini', '#4f8bff', ['gemini.google.com', 'gemini.google', 'g.co', 'bard.google.com']],
  ['ChatGPT', '#10a37f', ['chatgpt.com', 'chat.openai.com', 'sora.com']],
  ['Claude', '#d97757', ['claude.ai']],
  ['Google Flow', '#a142f4', ['flow.google.com', 'labs.google']],
  ['Leonardo', '#f5b544', ['leonardo.ai']],
  ['Freepik', '#1273eb', ['freepik.com', 'freepik.es', 'b2bpic.net']],
  ['Magnific', '#ff4fa3', ['magnific.com', 'magnific.ai']],
  ['Midjourney', '#e8e8f0', ['midjourney.com']],
  ['Copilot', '#2fb7ff', ['copilot.microsoft.com']],
  ['Grok', '#f2f2f2', ['grok.com']],
  ['Google Drive', '#34a853', ['drive.google.com']],
  ['Dropbox', '#0061ff', ['dropbox.com']],
];

function detectSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const s = SITES.find(([, , hosts]) => hosts.some((h) => host === h || host.endsWith('.' + h)));
    return s ? { name: s[0], color: s[1] } : { name: host.replace(/^www\./, ''), color: '#9aa4ff' };
  } catch {
    return { name: 'קישור', color: '#9aa4ff' };
  }
}

const findUrls = (text) => [...new Set((text.match(/https?:\/\/[^\s<>"'()]+/gi) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];

function chip(site) {
  const el = document.createElement('span');
  el.className = 'site-chip';
  el.style.setProperty('--c', site.color);
  el.innerHTML = '<i class="dot"></i><b></b>';
  el.querySelector('b').textContent = site.name;
  return el;
}

(function buildMarquee() {
  const track = $('#marquee');
  const items = [...SITES.map(([name, color]) => ({ name, color })), { name: '+ כל אתר', color: '#b6ff5c' }];
  for (let i = 0; i < 2; i++) items.forEach((s) => track.appendChild(chip(s)));
})();

// ---------- small helpers ----------

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function copy(text, done = 'הועתק ✓') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'ok');
  } catch {
    toast(text);
  }
}

function saveBlob(blob, name) {
  if (PREVIEW) return toast('בתצוגה המקדימה אין הורדה. באתר הקובץ יורד מיד.');
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('נשמר ✓', 'ok');
}

const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1e3))}KB`);
const fileUrl = (job, f) => f.url || `/files/${job.id}/${f.id}`;
const posterUrl = (job, f) => f.posterUrl || `/files/${job.id}/${f.id}/poster`;
const resultUrl = (job) => (PREVIEW ? location.href : `${location.origin}/r/${job.id}`);

// ---------- confetti ----------

const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
let particles = [];
function confetti(x = innerWidth / 2, y = innerHeight / 3) {
  if (reducedMotion) return;
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  const colors = ['#ff4fa3', '#8b5cf6', '#22d3ee', '#b6ff5c', '#ffb547'];
  const start = !particles.length;
  for (let i = 0; i < 110; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, r: 3 + Math.random() * 5, c: colors[i % colors.length], life: 1, spin: Math.random() * 6 });
  }
  if (start) requestAnimationFrame(tick);
}
function tick() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.life -= 0.012; p.spin += 0.2;
    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.fillStyle = p.c;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.spin); ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
  }
  if (particles.length) requestAnimationFrame(tick);
  else ctx.clearRect(0, 0, innerWidth, innerHeight);
}

// ---------- stats ----------

function countUp(el, to) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (reducedMotion || from === to) return (el.textContent = to.toLocaleString('he-IL'));
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / 1200, 1);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 4))).toLocaleString('he-IL');
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
async function loadStats() {
  try {
    countUp($('#stat-files'), (await (await fetch('/api/stats')).json()).files);
  } catch {
    /* decoration only */
  }
}

// ---------- composer: paste = go ----------

const input = $('#links');
const form = $('#composer');
const siteChip = $('#site-chip');
const countBadge = $('#count-badge');

function refreshComposer() {
  const urls = findUrls(input.value);
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  if (urls.length) {
    const site = detectSite(urls[0]);
    const changed = siteChip.hidden || siteChip.querySelector('b').textContent !== site.name;
    siteChip.hidden = false;
    siteChip.style.setProperty('--c', site.color);
    siteChip.querySelector('b').textContent = site.name;
    if (changed) { siteChip.classList.remove('pop'); void siteChip.offsetWidth; siteChip.classList.add('pop'); }
  } else siteChip.hidden = true;
  countBadge.hidden = urls.length < 2;
  countBadge.textContent = `×${urls.length}`;
}
input.addEventListener('input', refreshComposer);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
// Pasting a link starts right away.
input.addEventListener('paste', () => setTimeout(() => {
  refreshComposer();
  if (findUrls(input.value).length) form.requestSubmit();
}, 30));

['dragenter', 'dragover'].forEach((t) => form.addEventListener(t, (e) => { e.preventDefault(); form.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => form.addEventListener(t, () => form.classList.remove('dragging')));
form.addEventListener('drop', (e) => {
  e.preventDefault();
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) { input.value = text; refreshComposer(); form.requestSubmit(); }
});

let askedNotify = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!findUrls(text).length) {
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    toast('צריך קישור שמתחיל ב-https://', 'err');
    return;
  }
  if (!askedNotify && 'Notification' in window && Notification.permission === 'default') {
    askedNotify = true;
    Notification.requestPermission().catch(() => {});
  }
  const btn = $('#submit-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'משהו השתבש');
    input.value = '';
    refreshComposer();
    let first;
    body.jobs.slice().reverse().forEach((job) => { first = showJob(job, { live: true }); });
    first?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    loadHistory();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---------- job cards ----------

const STEPS = [
  { key: 'detect', label: 'זיהוי' },
  { key: 'fetch', label: 'הדף', optional: true },
  { key: 'browser', label: 'דפדפן', optional: true },
  { key: 'download', label: 'הורדה' },
  { key: 'video', label: 'וידאו', optional: true },
  { key: 'moderation', label: 'צניעות', optional: true },
  { key: 'done', label: 'מוכן' },
];
const openJobs = new Map();

function showJob(job, { live = false } = {}) {
  let entry = openJobs.get(job.id);
  if (!entry) {
    const el = $('#job-template').content.firstElementChild.cloneNode(true);
    const tl = $('.timeline', el);
    for (const s of STEPS) {
      const li = document.createElement('li');
      li.dataset.key = s.key;
      li.innerHTML = '<span class="beam"></span><span class="step-label"></span><span class="step-time"></span>';
      $('.step-label', li).textContent = s.label;
      tl.appendChild(li);
    }
    entry = { el, job };
    $('.share-btn', el).addEventListener('click', () => copy(resultUrl(entry.job), 'הקישור לתוצאה הועתק ✓'));
    $('.qr-btn', el).addEventListener('click', () => openStudio(entry.job, null, 'phone'));
    $('#jobs').prepend(el);
    openJobs.set(job.id, entry);
    if (live && job.status !== 'done' && job.status !== 'failed') follow(job.id);
  } else {
    $('#jobs').prepend(entry.el);
  }
  renderJob(entry, job);
  return entry.el;
}

function follow(id) {
  const entry = openJobs.get(id);
  const source = new EventSource(`/api/jobs/${id}/events`);
  entry.timer = setInterval(() => tickTime(entry), 100);
  source.onmessage = (e) => {
    const job = JSON.parse(e.data);
    const wasDone = entry.job.status === 'done';
    renderJob(entry, job);
    if (job.status !== 'done' && job.status !== 'failed') return;
    source.close();
    clearInterval(entry.timer);
    tickTime(entry);
    if (job.status === 'done' && !wasDone) {
      const r = entry.el.getBoundingClientRect();
      confetti(r.left + r.width / 2, Math.max(r.top + 60, 80));
      toast(job.files.length === 1 ? 'מוכן ✦' : `${job.files.length} קבצים מוכנים ✦`, 'ok');
      notify(job);
    } else if (job.status === 'failed') toast('לא הצלחנו לחלץ', 'err');
    loadHistory();
    loadStats();
  };
}

function notify(job) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('Linkra: מוכן ✦', { body: `${job.files.length} קבצים מ-${job.site?.name || 'הקישור'}`, icon: '/assets/favicon.svg' });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

function tickTime(entry) {
  const j = entry.job;
  $('.job-time', entry.el).textContent = `${(((j.finishedAt || Date.now()) - j.createdAt) / 1000).toFixed(1)}s`;
}

function renderJob(entry, job) {
  entry.job = job;
  const el = entry.el;
  const site = job.site || detectSite(job.url);
  $('.site-chip', el).style.setProperty('--c', site.color);
  $('.site-name', el).textContent = site.name;
  const link = $('.job-url', el);
  link.href = job.url;
  link.textContent = job.url.replace(/^https?:\/\//, '');
  tickTime(entry);

  const reached = new Map(job.steps.map((s) => [s.key, s]));
  const finished = job.status === 'done' || job.status === 'failed';
  const lastKey = job.steps[job.steps.length - 1]?.key;
  for (const li of $$('.timeline li', el)) {
    const key = li.dataset.key;
    const s = STEPS.find((x) => x.key === key);
    const hit = reached.get(key);
    li.className = '';
    $('.step-label', li).textContent = s.label;
    if (key === 'done' && job.status === 'failed') {
      li.classList.add('failed');
      $('.step-label', li).textContent = 'נכשל';
    } else if (hit) li.classList.add(!finished && key === lastKey ? 'active' : 'done');
    else if (finished && s.optional) li.classList.add('skipped');
    $('.step-time', li).textContent = hit ? `${((hit.at - job.createdAt) / 1000).toFixed(1)}s` : '';
  }

  const msg = $('.job-msg', el);
  msg.hidden = true;
  if (job.status === 'failed') {
    Object.assign(msg, { hidden: false, className: 'job-msg', textContent: job.error || 'משהו השתבש' });
  } else if (job.expired) {
    Object.assign(msg, { hidden: false, className: 'job-msg info', textContent: 'הקבצים נמחקו (עברו 7 ימים). אפשר לשלוח שוב.' });
  } else if (job.blocked && finished) {
    Object.assign(msg, { hidden: false, className: 'job-msg info', textContent: `${job.blocked} לא עברו סינון צניעות` });
  }

  const results = $('.results', el);
  const shown = new Set($$('.media-card', results).map((c) => c.dataset.id));
  $$('.skeleton', results).forEach((s) => s.remove());
  if (!job.expired) for (const f of job.files) if (!shown.has(f.id)) results.appendChild(mediaCard(job, f));
  if (!finished && !job.files.length) for (let i = 0; i < 3; i++) results.insertAdjacentHTML('beforeend', '<div class="skeleton"></div>');

  $('.job-actions', el).hidden = !(job.status === 'done' && job.files.length && !job.expired);
  $('.zip-btn', el).href = `/api/jobs/${job.id}/zip`;
  $('.zip-btn', el).hidden = job.files.length < 2;
}

function mediaCard(job, f) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = f.id;
  const src = fileUrl(job, f);
  const isVideo = f.type.startsWith('video/');
  const media = document.createElement(isVideo ? 'video' : 'img');
  media.src = src;
  if (isVideo) {
    Object.assign(media, { muted: true, loop: true, playsInline: true, preload: 'metadata' });
    if (f.poster) media.poster = posterUrl(job, f);
    card.addEventListener('mouseenter', () => media.play().catch(() => {}));
    card.addEventListener('mouseleave', () => media.pause());
  } else {
    media.alt = f.name;
  }
  card.appendChild(media);
  const open = document.createElement('button');
  open.className = 'open';
  open.type = 'button';
  open.setAttribute('aria-label', 'הגדלה');
  open.addEventListener('click', () => lightbox(src, isVideo));
  card.appendChild(open);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<span class="type"></span><span class="size"></span>';
  $('.type', meta).textContent = (f.name.split('.').pop() || '').slice(0, 4);
  $('.size', meta).textContent = fmtSize(f.size);
  const studio = document.createElement('button');
  studio.className = 'card-btn first';
  studio.type = 'button';
  studio.title = 'סטודיו';
  studio.setAttribute('aria-label', 'סטודיו');
  studio.textContent = '✨';
  studio.addEventListener('click', () => openStudio(job, f));
  const dl = document.createElement('a');
  dl.className = 'card-btn dl';
  dl.title = 'הורדה';
  dl.setAttribute('aria-label', 'הורדה');
  dl.textContent = '↓';
  dl.href = `${src}?download=1`;
  meta.append(studio, dl);
  card.appendChild(meta);
  return card;
}

function lightbox(src, isVideo) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const media = document.createElement(isVideo ? 'video' : 'img');
  media.src = src;
  if (isVideo) Object.assign(media, { controls: true, autoplay: true, playsInline: true });
  box.appendChild(media);
  const close = () => { box.remove(); removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  addEventListener('keydown', esc);
  document.body.appendChild(box);
}

// ---------- history: small rail + drawer ----------

let history = [];
let filter = 'all';

async function loadHistory() {
  try {
    history = (await (await fetch('/api/history')).json()).jobs || [];
  } catch {
    history = [];
  }
  renderRecents();
  renderDrawer();
}

function thumbButton(j) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'recent';
  b.title = j.site?.name || '';
  b.style.setProperty('--c', (j.site || detectSite(j.url)).color);
  const first = j.files[0];
  if (j.status === 'failed') { b.classList.add('failed'); b.textContent = '✕'; }
  else if (j.status !== 'done') b.classList.add('pending');
  else if (j.expired) b.textContent = '⌛';
  else if (first) {
    const isVideo = first.type.startsWith('video/');
    const img = isVideo ? (first.poster ? posterUrl(j, first) : '') : fileUrl(j, first);
    if (img) b.style.backgroundImage = `url("${img}")`;
    else b.textContent = '▶';
  }
  b.insertAdjacentHTML('beforeend', '<i class="badge"></i>');
  b.addEventListener('click', () => {
    closeDrawer();
    const el = showJob(j, { live: j.status !== 'done' && j.status !== 'failed' });
    el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  });
  return b;
}

function renderRecents() {
  const track = $('#recents-track');
  track.textContent = '';
  history.slice(0, 14).forEach((j) => track.appendChild(thumbButton(j)));
  $('#recents').hidden = !history.length;
  const count = $('#history-count');
  count.hidden = !history.length;
  count.textContent = history.length > 99 ? '99+' : history.length;
}

function renderDrawer() {
  const q = $('#search').value.trim().toLowerCase();
  const list = history.filter((j) => {
    if (q && !`${j.url} ${j.site?.name}`.toLowerCase().includes(q)) return false;
    if (filter === 'image') return j.files.some((f) => f.type.startsWith('image/'));
    if (filter === 'video') return j.files.some((f) => f.type.startsWith('video/'));
    if (filter === 'starred') return j.starred;
    return true;
  });
  const box = $('#history-list');
  box.textContent = '';
  $('#history-empty').hidden = list.length > 0;
  for (const j of list) {
    const row = document.createElement('div');
    row.className = 'h-row';
    row.appendChild(thumbButton(j));
    const info = document.createElement('div');
    info.className = 'h-info';
    info.innerHTML = '<div class="site"></div><div class="when"></div>';
    $('.site', info).textContent = (j.site || detectSite(j.url)).name;
    $('.when', info).textContent = `${new Date(j.createdAt).toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${j.files.length > 1 ? ` · ${j.files.length} קבצים` : ''}`;
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'h-actions';
    const star = iconButton(j.starred ? '★' : '☆', 'מועדף', async () => {
      const res = await fetch(`/api/jobs/${j.id}/star`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: !j.starred }) });
      if (res.ok) { j.starred = !j.starred; renderDrawer(); }
    });
    if (j.starred) star.classList.add('on');
    actions.append(
      star,
      iconButton('↻', 'שוב', () => { closeDrawer(); input.value = j.url; refreshComposer(); form.requestSubmit(); }),
      iconButton('🗑', 'מחיקה', async () => {
        const res = await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
        if (res.ok) { history = history.filter((x) => x.id !== j.id); renderRecents(); renderDrawer(); toast('נמחק'); }
      }),
    );
    row.appendChild(actions);
    box.appendChild(row);
  }
}

function iconButton(text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function openDrawer() {
  $('#drawer-backdrop').hidden = false;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#search').focus(), 300);
}
function closeDrawer() {
  $('#drawer-backdrop').hidden = true;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}
$('#open-history').addEventListener('click', openDrawer);
$('#recents-all').addEventListener('click', openDrawer);
$('#close-history').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#search').addEventListener('input', renderDrawer);
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('active', c === b));
  filter = b.dataset.filter;
  renderDrawer();
});

// ---------- studio ----------

const modal = $('#studio-modal');
const sImg = $('#studio-img');
const sVideo = $('#studio-video');
const sBody = $('#studio-body');
let studio = null; // { job, file, frame }

const IMAGE_TABS = [['crop', '✂️', 'חיתוך'], ['convert', '⇄', 'המרה'], ['colors', '🎨', 'צבעים'], ['phone', '📱', 'לטלפון']];
const VIDEO_TABS = [['frame', '🖼️', 'פריים'], ['phone', '📱', 'לטלפון']];

function openStudio(job, file, tab) {
  file ||= job.files[0];
  if (!file) return;
  studio = { job, file };
  const isVideo = file.type.startsWith('video/');
  sImg.hidden = isVideo;
  sVideo.hidden = !isVideo;
  if (isVideo) { sVideo.src = fileUrl(job, file); sVideo.poster = file.poster ? posterUrl(job, file) : ''; }
  else { sImg.crossOrigin = 'anonymous'; sImg.src = fileUrl(job, file); }
  const tabs = $('#studio-tabs');
  tabs.textContent = '';
  for (const [key, icon, label] of isVideo ? VIDEO_TABS : IMAGE_TABS) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'tab';
    t.dataset.tab = key;
    t.innerHTML = `<b>${icon}</b><span></span>`;
    $('span', t).textContent = label;
    t.addEventListener('click', () => showTab(key));
    tabs.appendChild(t);
  }
  modal.hidden = false;
  showTab(tab || (isVideo ? 'frame' : 'crop'));
}
function closeStudio() {
  modal.hidden = true;
  sVideo.pause();
  $('.crop-frame', modal)?.remove();
  studio = null;
}
$('#studio-close').addEventListener('click', closeStudio);
modal.addEventListener('click', (e) => { if (e.target === modal) closeStudio(); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) closeStudio();
  else closeDrawer();
});

function showTab(key) {
  $$('.tab', modal).forEach((t) => t.classList.toggle('active', t.dataset.tab === key));
  $('.crop-frame', modal)?.remove();
  sBody.textContent = '';
  ({ crop: tabCrop, convert: tabConvert, colors: tabColors, phone: tabPhone, frame: tabFrame })[key]();
}

const imageReady = () => (sImg.complete && sImg.naturalWidth ? Promise.resolve() : new Promise((r) => sImg.addEventListener('load', r, { once: true })));
const baseName = () => studio.file.name.replace(/\.\w+$/, '');
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

// ✂️ crop for social formats
const RATIOS = [['1:1', 1, 1, 'ריבוע'], ['4:5', 4, 5, 'פוסט'], ['9:16', 9, 16, 'סטורי'], ['16:9', 16, 9, 'באנר']];
function cropRect(w, h, rw, rh) {
  const target = rw / rh;
  return w / h > target ? { cw: Math.round(h * target), ch: h } : { cw: w, ch: Math.round(w / target) };
}
async function tabCrop() {
  await imageReady();
  const grid = document.createElement('div');
  grid.className = 'option-grid';
  let chosen = RATIOS[0];
  const frame = document.createElement('div');
  frame.className = 'crop-frame';
  $('.studio-preview', modal).appendChild(frame);
  const place = () => {
    const box = sImg.getBoundingClientRect();
    const host = $('.studio-preview', modal).getBoundingClientRect();
    const { cw, ch } = cropRect(box.width, box.height, chosen[1], chosen[2]);
    Object.assign(frame.style, { width: `${cw}px`, height: `${ch}px`, left: `${box.left - host.left + (box.width - cw) / 2}px`, top: `${box.top - host.top + (box.height - ch) / 2}px` });
  };
  for (const r of RATIOS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option';
    const s = 22 / Math.max(r[1], r[2]);
    b.innerHTML = `<i class="ratio" style="width:${r[1] * s}px;height:${r[2] * s}px"></i><span>${r[3]}<small>${r[0]}</small></span>`;
    b.addEventListener('click', () => { chosen = r; $$('.option', grid).forEach((o) => o.classList.toggle('active', o === b)); place(); });
    if (r === chosen) b.classList.add('active');
    grid.appendChild(b);
  }
  const save = document.createElement('button');
  save.className = 'big-btn';
  save.type = 'button';
  save.textContent = 'שמירה ↓';
  save.addEventListener('click', async () => {
    const w = sImg.naturalWidth, h = sImg.naturalHeight;
    const { cw, ch } = cropRect(w, h, chosen[1], chosen[2]);
    const c = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    c.getContext('2d').drawImage(sImg, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
    saveBlob(await toBlob(c, 'image/jpeg', 0.93), `${baseName()}-${chosen[0].replace(':', 'x')}.jpg`);
  });
  sBody.append(grid, save);
  requestAnimationFrame(place);
}

// ⇄ convert & compress
async function tabConvert() {
  await imageReady();
  const formats = [['image/png', 'PNG'], ['image/jpeg', 'JPG'], ['image/webp', 'WEBP']];
  let type = 'image/webp';
  let quality = 0.82;
  const grid = document.createElement('div');
  grid.className = 'option-grid';
  grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  const range = document.createElement('label');
  range.className = 'range-row';
  range.innerHTML = '<span>איכות</span><input type="range" id="studio-quality" min="30" max="100" value="82"><b>82</b>';
  const note = document.createElement('div');
  note.className = 'size-note';
  const save = document.createElement('button');
  save.className = 'big-btn';
  save.type = 'button';
  save.textContent = 'שמירה ↓';
  const c = Object.assign(document.createElement('canvas'), { width: sImg.naturalWidth, height: sImg.naturalHeight });
  c.getContext('2d').drawImage(sImg, 0, 0);
  let last;
  let timer;
  const measure = () => {
    clearTimeout(timer);
    note.textContent = '…';
    timer = setTimeout(async () => {
      last = await toBlob(c, type, quality);
      const pct = Math.round((1 - last.size / studio.file.size) * 100);
      note.innerHTML = `${fmtSize(studio.file.size)} → <b>${fmtSize(last.size)}</b>${pct > 0 ? ` (−${pct}%)` : ''}`;
    }, 120);
  };
  for (const [t, label] of formats) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option';
    b.style.justifyContent = 'center';
    b.textContent = label;
    if (t === type) b.classList.add('active');
    b.addEventListener('click', () => { type = t; $$('.option', grid).forEach((o) => o.classList.toggle('active', o === b)); range.hidden = t === 'image/png'; measure(); });
    grid.appendChild(b);
  }
  $('input', range).addEventListener('input', (e) => { quality = e.target.value / 100; $('b', range).textContent = e.target.value; measure(); });
  save.addEventListener('click', async () => saveBlob(last || (await toBlob(c, type, quality)), `${baseName()}.${type.split('/')[1].replace('jpeg', 'jpg')}`));
  sBody.append(grid, range, note, save);
  measure();
}

// 🎨 colour palette
async function tabColors() {
  await imageReady();
  const size = 72;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(sImg, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    buckets.set(key, b);
  }
  const picked = [];
  for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    const col = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round);
    if (picked.every((p) => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 48)) picked.push(col);
    if (picked.length === 6) break;
  }
  const grid = document.createElement('div');
  grid.className = 'swatches';
  for (const col of picked) {
    const hex = `#${col.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.innerHTML = `<i style="background:${hex}"></i><span>${hex}</span>`;
    b.addEventListener('click', () => copy(hex, `${hex} הועתק ✓`));
    grid.appendChild(b);
  }
  sBody.appendChild(grid);
}

// 📱 open on the phone: QR + native share
let qrLib;
function loadQr() {
  qrLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return qrLib;
}
async function tabPhone() {
  const url = resultUrl(studio.job);
  const box = document.createElement('div');
  box.className = 'qr-box';
  box.innerHTML = '<div class="qr-slot"></div><span>סורקים עם המצלמה</span>';
  sBody.appendChild(box);
  try {
    const qrcode = await loadQr();
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const img = new Image();
    img.alt = 'QR';
    img.src = qr.createDataURL(8, 2);
    $('.qr-slot', box).appendChild(img);
  } catch {
    $('.qr-slot', box).textContent = url;
  }
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'pill-btn';
  copyBtn.textContent = '🔗 העתקת קישור';
  copyBtn.addEventListener('click', () => copy(url));
  sBody.appendChild(copyBtn);
  if (navigator.share && !PREVIEW) {
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'big-btn';
    shareBtn.textContent = 'שיתוף…';
    shareBtn.addEventListener('click', async () => {
      try {
        const blob = await (await fetch(fileUrl(studio.job, studio.file))).blob();
        const file = new File([blob], studio.file.name, { type: studio.file.type });
        await navigator.share(navigator.canShare?.({ files: [file] }) ? { files: [file] } : { url });
      } catch {
        /* cancelled */
      }
    });
    sBody.appendChild(shareBtn);
  }
}

// 🖼️ save a frame from a video
function tabFrame() {
  const note = document.createElement('div');
  note.className = 'size-note';
  note.textContent = 'עוצרים ברגע הנכון ושומרים';
  const save = document.createElement('button');
  save.className = 'big-btn';
  save.type = 'button';
  save.textContent = 'שמירת הפריים ↓';
  save.addEventListener('click', async () => {
    sVideo.pause();
    const c = Object.assign(document.createElement('canvas'), { width: sVideo.videoWidth, height: sVideo.videoHeight });
    c.getContext('2d').drawImage(sVideo, 0, 0);
    saveBlob(await toBlob(c, 'image/png'), `${baseName()}-${sVideo.currentTime.toFixed(1)}s.png`);
  });
  sBody.append(note, save);
}

// ---------- bookmarklet: send any page to Linkra in one click ----------

(function bookmarklet() {
  const a = $('#bookmarklet');
  a.href = `javascript:location.href='${location.origin}/?u='+encodeURIComponent(location.href)`;
  a.addEventListener('click', (e) => { e.preventDefault(); toast('גררו את הכפתור לסרגל הסימניות'); });
})();

// ---------- boot ----------

loadStats();
loadHistory();
setInterval(loadStats, 30000);

const params = new URLSearchParams(location.search);
if (params.get('u')) {
  input.value = params.get('u');
  refreshComposer();
  window.history.replaceState?.(null, '', '/');
  form.requestSubmit();
}

const shared = /^\/r\/([\w-]+)/.exec(location.pathname);
if (shared) {
  fetch(`/api/jobs/${shared[1]}`).then((r) => (r.ok ? r.json() : null)).then((job) => {
    if (!job) return toast('התוצאה לא נמצאה', 'err');
    showJob(job, { live: job.status !== 'done' && job.status !== 'failed' });
  });
}
