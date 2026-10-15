// Linkra front end: composer, live job timeline (SSE), results, history, and the small delights.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- sites (badge colours; mirrors the server's list) ----------

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
    return null;
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

// ---------- marquee ----------

(function buildMarquee() {
  const track = $('#marquee');
  const items = [...SITES.map(([name, color]) => ({ name, color })), { name: 'וכל אתר אחר', color: '#b6ff5c' }];
  for (let i = 0; i < 2; i++) items.forEach((s) => track.appendChild(chip(s)));
})();

// ---------- toasts & confetti ----------

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
let particles = [];
function confetti(x = innerWidth / 2, y = innerHeight / 3) {
  if (reducedMotion) return;
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  const colors = ['#ff4fa3', '#8b5cf6', '#22d3ee', '#b6ff5c', '#ffb547'];
  for (let i = 0; i < 120; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, r: 3 + Math.random() * 5, c: colors[i % colors.length], life: 1, spin: Math.random() * 6 });
  }
  if (particles.length === 120) requestAnimationFrame(tick);
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

function countUp(el, to, format = (n) => n.toLocaleString('he-IL')) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (reducedMotion || from === to) return (el.textContent = format(to));
  const start = performance.now();
  const dur = 1200;
  const step = (now) => {
    const t = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 4);
    el.textContent = format(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const formatBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : b >= 1e6 ? `${Math.round(b / 1e6)}MB` : `${Math.round(b / 1e3)}KB`);

async function loadStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    countUp($('#stat-files'), s.files);
    countUp($('#s-files'), s.files);
    countUp($('#s-links'), s.links);
    countUp($('#s-gb'), s.bytes, formatBytes);
    countUp($('#s-sites'), Object.keys(s.bySite || {}).length);
  } catch {
    /* stats are decoration */
  }
}

// ---------- composer ----------

const input = $('#links');
const form = $('#composer');
const siteChip = $('#site-chip');
const countBadge = $('#count-badge');

function refreshComposer() {
  const urls = findUrls(input.value);
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  if (urls.length) {
    const site = detectSite(urls[0]);
    const changed = siteChip.hidden || siteChip.querySelector('b').textContent !== site.name;
    siteChip.hidden = false;
    siteChip.style.setProperty('--c', site.color);
    siteChip.querySelector('b').textContent = site.name;
    if (changed) { siteChip.classList.remove('pop'); void siteChip.offsetWidth; siteChip.classList.add('pop'); }
    $('#hint').hidden = true;
  } else {
    siteChip.hidden = true;
    $('#hint').hidden = false;
  }
  countBadge.hidden = urls.length < 2;
  countBadge.textContent = `${urls.length} קישורים`;
}
input.addEventListener('input', refreshComposer);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

$('#paste-btn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    input.value = input.value ? `${input.value.trim()}\n${text}` : text;
    refreshComposer();
    input.focus();
  } catch {
    toast('הדפדפן לא איפשר לקרוא מהלוח. הדביקו עם Ctrl+V', 'err');
  }
});

// drag & drop a link onto the composer
['dragenter', 'dragover'].forEach((t) => form.addEventListener(t, (e) => { e.preventDefault(); form.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => form.addEventListener(t, () => form.classList.remove('dragging')));
form.addEventListener('drop', (e) => {
  e.preventDefault();
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) { input.value = text; refreshComposer(); form.requestSubmit(); }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!findUrls(text).length) {
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    toast('הדביקו קישור שמתחיל ב-https://', 'err');
    return;
  }
  const btn = $('#submit-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'משהו השתבש');
    input.value = '';
    refreshComposer();
    body.jobs.slice().reverse().forEach((job) => showJob(job, { live: true }));
    $('#jobs').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---------- job cards ----------

const STEPS = [
  { key: 'detect', label: 'זיהוי' },
  { key: 'fetch', label: 'פתיחת הדף', optional: true },
  { key: 'browser', label: 'דפדפן חכם', optional: true },
  { key: 'download', label: 'הורדה' },
  { key: 'video', label: 'עיבוד וידאו', optional: true },
  { key: 'moderation', label: 'סינון צניעות', optional: true },
  { key: 'done', label: 'מוכן' },
];
const openJobs = new Map(); // id -> {el, job, source}

function showJob(job, { live = false, prepend = true } = {}) {
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
    $('.share-btn', el).addEventListener('click', () => {
      navigator.clipboard.writeText(`${location.origin}/r/${job.id}`).then(() => toast('הקישור לתוצאה הועתק ✓', 'ok'));
    });
    const jobs = $('#jobs');
    prepend ? jobs.prepend(el) : jobs.appendChild(el);
    entry = { el, job };
    openJobs.set(job.id, entry);
    if (live && job.status !== 'done' && job.status !== 'failed') follow(job.id);
  }
  renderJob(entry, job);
  return entry.el;
}

function follow(id) {
  const source = new EventSource(`/api/jobs/${id}/events`);
  const entry = openJobs.get(id);
  entry.source = source;
  entry.timer = setInterval(() => tickTime(entry), 100);
  source.onmessage = (e) => {
    const job = JSON.parse(e.data);
    const wasDone = entry.job.status === 'done';
    renderJob(entry, job);
    if (job.status === 'done' || job.status === 'failed') {
      source.close();
      clearInterval(entry.timer);
      tickTime(entry);
      if (job.status === 'done' && !wasDone) {
        const r = entry.el.getBoundingClientRect();
        confetti(r.left + r.width / 2, Math.max(r.top + 60, 80));
        toast(`${job.files.length === 1 ? 'הקובץ מוכן' : `${job.files.length} קבצים מוכנים`} ✦`, 'ok');
      } else if (job.status === 'failed') {
        toast('לא הצלחנו לחלץ מהקישור הזה', 'err');
      }
      loadHistory();
      loadStats();
    }
  };
  source.onerror = () => { /* the browser reconnects by itself */ };
}

function tickTime(entry) {
  const j = entry.job;
  const end = j.finishedAt || Date.now();
  $('.job-time', entry.el).textContent = `${((end - j.createdAt) / 1000).toFixed(1)} שנ׳`;
}

function renderJob(entry, job) {
  entry.job = job;
  const el = entry.el;
  const site = job.site || detectSite(job.url);
  const chipEl = $('.site-chip', el);
  chipEl.style.setProperty('--c', site.color);
  $('.site-name', el).textContent = site.name;
  const link = $('.job-url', el);
  link.href = job.url;
  link.textContent = job.url.replace(/^https?:\/\//, '');
  tickTime(entry);

  // timeline
  const reached = new Map(job.steps.map((s) => [s.key, s]));
  const finished = job.status === 'done' || job.status === 'failed';
  const lastKey = job.steps[job.steps.length - 1]?.key;
  for (const li of $$('.timeline li', el)) {
    const key = li.dataset.key;
    const s = STEPS.find((x) => x.key === key);
    const hit = reached.get(key);
    li.className = '';
    if (key === 'done' && job.status === 'failed') {
      li.classList.add('failed');
      $('.step-label', li).textContent = 'נכשל';
    } else if (hit) {
      li.classList.add(!finished && key === lastKey ? 'active' : 'done');
    } else if (finished && s.optional) {
      li.classList.add('skipped');
    }
    $('.step-time', li).textContent = hit ? `${((hit.at - job.createdAt) / 1000).toFixed(1)}s` : '';
  }

  // messages
  const msg = $('.job-msg', el);
  if (job.status === 'failed') {
    msg.hidden = false;
    msg.className = 'job-msg';
    msg.textContent = job.error || 'משהו השתבש';
  } else if (job.blocked && finished) {
    msg.hidden = false;
    msg.className = 'job-msg info';
    msg.textContent = `${job.blocked === 1 ? 'קובץ אחד לא הוצג' : `${job.blocked} קבצים לא הוצגו`} כי לא עבר${job.blocked === 1 ? '' : 'ו'} את סינון הצניעות.`;
  } else msg.hidden = true;

  // results
  const results = $('.results', el);
  const shown = new Set($$('.media-card', results).map((c) => c.dataset.id));
  $$('.skeleton', results).forEach((s) => s.remove());
  for (const f of job.files) if (!shown.has(f.id)) results.appendChild(mediaCard(job, f));
  if (!finished && !job.files.length) for (let i = 0; i < 3; i++) results.insertAdjacentHTML('beforeend', '<div class="skeleton"></div>');
  if (job.expired) {
    msg.hidden = false;
    msg.className = 'job-msg info';
    msg.textContent = 'הקבצים של החילוץ הזה כבר נמחקו (נשמרים 7 ימים). אפשר לשלוח את הקישור שוב.';
  }

  const actions = $('.job-actions', el);
  actions.hidden = !(job.status === 'done' && job.files.length && !job.expired);
  $('.zip-btn', el).href = `/api/jobs/${job.id}/zip`;
  $('.zip-btn', el).hidden = job.files.length < 2;
}

function mediaCard(job, f) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = f.id;
  const src = `/files/${job.id}/${f.id}`;
  const isVideo = f.type.startsWith('video/');
  const media = document.createElement(isVideo ? 'video' : 'img');
  media.src = src;
  if (isVideo) {
    Object.assign(media, { muted: true, loop: true, playsInline: true, preload: 'metadata' });
    if (f.poster) media.poster = `${src}/poster`;
    card.addEventListener('mouseenter', () => media.play().catch(() => {}));
    card.addEventListener('mouseleave', () => media.pause());
  } else {
    media.alt = f.name;
    media.loading = 'lazy';
  }
  card.appendChild(media);
  const open = document.createElement('button');
  open.className = 'open';
  open.setAttribute('aria-label', 'הגדלה');
  open.style.cssText = 'background:none;border:0;cursor:zoom-in';
  open.addEventListener('click', () => lightbox(src, isVideo));
  card.appendChild(open);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="type"></span><span class="size"></span><a class="dl" title="הורדה" aria-label="הורדה">↓</a>`;
  $('.type', meta).textContent = (f.name.split('.').pop() || f.type.split('/')[1]).slice(0, 4);
  $('.size', meta).textContent = f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)}MB` : `${Math.round(f.size / 1e3)}KB`;
  $('.dl', meta).href = `${src}?download=1`;
  card.appendChild(meta);
  tilt(card);
  return card;
}

function lightbox(src, isVideo) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const media = document.createElement(isVideo ? 'video' : 'img');
  media.src = src;
  if (isVideo) Object.assign(media, { controls: true, autoplay: true, playsInline: true });
  box.appendChild(media);
  const close = () => box.remove();
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', esc); } });
  document.body.appendChild(box);
}

function tilt(el) {
  if (reducedMotion || matchMedia('(hover: none)').matches) return;
  el.addEventListener('mousemove', (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(700px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) scale(1.02)`;
  });
  el.addEventListener('mouseleave', () => { el.style.transform = ''; });
}

// ---------- history ----------

let history = [];
let filter = 'all';

async function loadHistory() {
  try {
    history = (await (await fetch('/api/history')).json()).jobs || [];
  } catch {
    history = [];
  }
  renderHistory();
}

function renderHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const list = history.filter((j) => {
    if (q && !`${j.url} ${j.site?.name}`.toLowerCase().includes(q)) return false;
    if (filter === 'image') return j.files.some((f) => f.type.startsWith('image/'));
    if (filter === 'video') return j.files.some((f) => f.type.startsWith('video/'));
    if (filter === 'starred') return j.starred;
    if (filter === 'failed') return j.status === 'failed';
    return true;
  });
  const grid = $('#history-grid');
  grid.textContent = '';
  $('#history-empty').hidden = history.length > 0;
  for (const j of list) grid.appendChild(historyCard(j));
}

function historyCard(j) {
  const card = document.createElement('article');
  card.className = 'h-card';
  const first = j.files[0];
  const thumb = document.createElement('button');
  thumb.className = 'h-thumb';
  thumb.style.border = '0';
  thumb.style.cursor = 'pointer';
  thumb.setAttribute('aria-label', 'פתיחת התוצאה');
  if (j.status === 'failed') { thumb.classList.add('failed'); thumb.textContent = '✕'; }
  else if (j.status !== 'done') thumb.classList.add('pending');
  else if (first && !j.expired) {
    const isVideo = first.type.startsWith('video/');
    const img = isVideo ? (first.poster ? `/files/${j.id}/${first.id}/poster` : '') : `/files/${j.id}/${first.id}`;
    if (img) thumb.style.backgroundImage = `url("${img}")`;
    if (isVideo) thumb.insertAdjacentHTML('beforeend', '<span class="play">▶</span>');
    if (j.files.length > 1) thumb.insertAdjacentHTML('beforeend', `<span class="count">${j.files.length} files</span>`);
  } else if (j.expired) { thumb.classList.add('failed'); thumb.style.color = 'var(--faint)'; thumb.textContent = '⌛'; }
  thumb.addEventListener('click', () => {
    const el = showJob(j, { live: j.status !== 'done' && j.status !== 'failed' });
    el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  });
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'h-body';
  const row = document.createElement('div');
  row.className = 'h-row';
  row.appendChild(chip(j.site || detectSite(j.url)));
  const date = document.createElement('span');
  date.className = 'h-date';
  date.textContent = new Date(j.createdAt).toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  row.appendChild(date);
  body.appendChild(row);
  const url = document.createElement('a');
  url.className = 'h-url';
  url.href = j.url;
  url.target = '_blank';
  url.rel = 'noopener noreferrer';
  url.textContent = j.url.replace(/^https?:\/\//, '');
  body.appendChild(url);

  const actions = document.createElement('div');
  actions.className = 'h-actions';
  const star = button(j.starred ? '★' : '☆', 'מועדף', async () => {
    const res = await fetch(`/api/jobs/${j.id}/star`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: !j.starred }) });
    if (res.ok) { j.starred = !j.starred; renderHistory(); }
  });
  star.classList.add('star');
  if (j.starred) star.classList.add('on');
  actions.appendChild(star);
  actions.appendChild(button('↻', 'לחלץ שוב', () => { input.value = j.url; refreshComposer(); form.requestSubmit(); }));
  actions.appendChild(button('🔗', 'העתקת קישור לתוצאה', () => navigator.clipboard.writeText(`${location.origin}/r/${j.id}`).then(() => toast('הקישור הועתק ✓', 'ok'))));
  if (j.files.length > 1 && !j.expired) {
    const zip = document.createElement('a');
    zip.className = 'icon-btn';
    zip.href = `/api/jobs/${j.id}/zip`;
    zip.title = 'הורדת הכל (ZIP)';
    zip.textContent = '⬇';
    actions.appendChild(zip);
  }
  actions.appendChild(button('🗑', 'מחיקה', async () => {
    if (!confirm('למחוק את הפריט הזה מההיסטוריה?')) return;
    const res = await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
    if (res.ok) { history = history.filter((x) => x.id !== j.id); renderHistory(); toast('נמחק'); }
  }));
  body.appendChild(actions);
  card.appendChild(body);

  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  return card;
}

function button(text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

$('#search').addEventListener('input', renderHistory);
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('active', c === b));
  filter = b.dataset.filter;
  renderHistory();
});

// ---------- reveal on scroll ----------

const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
$$('.reveal').forEach((el) => io.observe(el));

// ---------- boot ----------

loadStats();
loadHistory();
setInterval(loadStats, 30000);

// /r/<id>: open a shared result
const shared = /^\/r\/([\w-]+)/.exec(location.pathname);
if (shared) {
  fetch(`/api/jobs/${shared[1]}`).then((r) => (r.ok ? r.json() : null)).then((job) => {
    if (!job) return toast('התוצאה לא נמצאה', 'err');
    const el = showJob(job, { live: job.status !== 'done' && job.status !== 'failed' });
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  });
}
