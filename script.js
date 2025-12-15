// Target date: 15 Feb 2026 19:00 local time
const target = new Date(2026, 1, 15, 19, 0, 0); // months are 0-based -> 1 = Feb

const countdownEl = document.getElementById('countdown');
const heartsContainer = document.getElementById('hearts');

function updateCountdown() {
  const now = new Date();
  const diff = Math.max(0, Math.floor((target - now) / 1000)); // seconds

  const days = Math.floor(diff / 86400);
  const rem = diff % 86400;
  const hrs = Math.floor(rem / 3600);
  const mins = Math.floor((rem % 3600) / 60);
  const secs = rem % 60;
  // update individual elements (days / hours / minutes / seconds)
  animateIfChanged('days', String(days));
  animateIfChanged('hours', String(hrs).padStart(2,'0'));
  animateIfChanged('minutes', String(mins).padStart(2,'0'));
  animateIfChanged('seconds', String(secs).padStart(2,'0'));
}

function animateIfChanged(id, newText){
  const el = document.getElementById(id);
  if(!el) return;
  const old = el.textContent;
  if(old !== newText){
    el.textContent = newText;
    el.classList.remove('animate');
    // force reflow to restart animation
    void el.offsetWidth;
    el.classList.add('animate');
    clearTimeout(el._animTimer);
    el._animTimer = setTimeout(()=> el.classList.remove('animate'), 300);
  }
}

function pad(n){return String(n).padStart(2,'0')}

setInterval(updateCountdown, 1000);
updateCountdown();
// reveal countdown card after initial render
document.addEventListener('DOMContentLoaded', ()=>{
  const c = document.querySelector('.countdown');
  if(c) requestAnimationFrame(()=> c.classList.add('visible'));
});

// Hearts animation
function spawnHeart(){
  const h = document.createElement('span');
  h.className = 'heart';
  const size = rand(18,80);
  const left = rand(0, 100);
  const duration = rand(4500, 10000);
  const opacity = Math.random() * 0.6 + 0.35;

  const colors = ['#ff5a82','#ff9bb3','#ffd1e0','#ff8aa6','#ff6f97'];
  const color = colors[rand(0, colors.length-1)];

  // Inline SVG heart with chosen color
  h.innerHTML = `<svg viewBox="0 0 32 29.6" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><path fill="${color}" fill-opacity="${opacity}" d="M23.6 0c-2.9 0-5.4 1.6-6.6 4C15.8 1.6 13.3 0 10.4 0 4.7 0 0 4.7 0 10.4 0 18.2 8.4 23.9 16 29.6c7.6-5.7 16-11.4 16-19.2C32 4.7 27.3 0 23.6 0z"/></svg>`;

  h.style.left = left + '%';
  heartsContainer.appendChild(h);

  // animate using Web Animations API with horizontal sway (three keyframes)
  const keyframes = [
    { transform: 'translateY(-20%) translateX(0px) rotate(0deg)', opacity: 1 },
    { transform: `translateY(45vh) translateX(${rand(-40,40)}px) rotate(${rand(-180,180)}deg)`, opacity: 0.9 },
    { transform: `translateY(120vh) translateX(${rand(-60,60)}px) rotate(${rand(-360,360)}deg)`, opacity: 0 }
  ];
  const anim = h.animate(keyframes, {duration: duration, easing: 'linear'});
  anim.onfinish = () => h.remove();
}

// Sparkle/star for divisible-by-10 days
function spawnSparkle(){
  const s = document.createElement('span');
  s.className = 'heart sparkle';
  const size = rand(18,44);
  const left = rand(6, 94);

  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><path fill="#ffd36b" d="M12 2l2.9 6.1L21 10l-5 3.8L17.8 20 12 16.7 6.2 20 8 13.8 3 10l6.1-1.9L12 2z"/></svg>`;
  s.style.left = left + '%';
  heartsContainer.appendChild(s);

  const dur = rand(2800, 5200);
  const keyframes = [
    { transform: 'translateY(-10%) scale(0.9)', opacity: 1 },
    { transform: `translateY(120vh) scale(0.6)`, opacity: 0 }
  ];
  const anim = s.animate(keyframes, {duration: dur, easing: 'cubic-bezier(.2,.8,.2,1)'});
  anim.onfinish = () => s.remove();
}

// Dramatic hearts for last 10 days
function spawnDramaticHeart(){
  const h = document.createElement('span');
  h.className = 'heart dramatic';
  const size = rand(36,120);
  const left = rand(6, 94);
  const color = ['#ff6f97','#ff9bb3','#ffd1e0'][rand(0,2)];

  h.innerHTML = `<svg viewBox="0 0 32 29.6" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><path fill="${color}" d="M23.6 0c-2.9 0-5.4 1.6-6.6 4C15.8 1.6 13.3 0 10.4 0 4.7 0 0 4.7 0 10.4 0 18.2 8.4 23.9 16 29.6c7.6-5.7 16-11.4 16-19.2C32 4.7 27.3 0 23.6 0z"/></svg>`;
  h.style.left = left + '%';
  heartsContainer.appendChild(h);

  const dur = rand(7000, 13000);
  const keyframes = [
    { transform: 'translateY(-10%) scale(0.95)', opacity: 1 },
    { transform: `translateY(120vh) scale(0.5) rotate(${rand(-180,180)}deg)`, opacity: 0 }
  ];
  const anim = h.animate(keyframes, {duration: dur, easing: 'cubic-bezier(.25,.8,.25,1)'});
  anim.onfinish = () => h.remove();
}

// Falling rings for final day
function spawnRing(){
  const r = document.createElement('span');
  r.className = 'heart ring';
  const size = rand(36,84);
  const left = rand(8,92);

  r.innerHTML = `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><g><circle cx="22" cy="30" r="12" fill="none" stroke="#ffd36b" stroke-width="4"/><circle cx="42" cy="26" r="10" fill="none" stroke="#f8e3a2" stroke-width="4" transform="rotate(-15 42 26)"/></g></svg>`;
  r.style.left = left + '%';
  heartsContainer.appendChild(r);

  const dur = rand(5000, 11000);
  const keyframes = [
    { transform: 'translateY(-20%) rotate(0deg)', opacity: 1 },
    { transform: `translateY(115vh) rotate(${rand(180,720)}deg)`, opacity: 0 }
  ];
  const anim = r.animate(keyframes, {duration: dur, easing: 'cubic-bezier(.2,.9,.25,1)'});
  anim.onfinish = () => r.remove();
  // small pop sound occasionally
  if(Math.random() < 0.2) playPop();
}

// Confetti burst (central explosion)
function confettiBurst(){
  const colors = ['#ff5a82','#ffd36b','#ff9bb3','#8be7ff','#ffd1e0','#ffffff'];
  const count = 36;
  const centerX = window.innerWidth/2;
  const centerY = window.innerHeight/2;

  for(let i=0;i<count;i++){
    const c = document.createElement('span');
    c.className = 'confetti';
    const w = rand(6,14);
    const left = centerX + rand(-40,40);
    const top = centerY + rand(-20,20);
    c.style.left = left + 'px';
    c.style.top = top + 'px';
    c.style.width = w + 'px';
    c.style.height = (w*1.6) + 'px';
    c.style.background = colors[rand(0, colors.length-1)];
    c.style.transform = `rotate(${rand(0,360)}deg)`;
    document.body.appendChild(c);

    const angle = (rand(0,360) * Math.PI)/180;
    const distance = rand(120, 420);
    const destX = Math.cos(angle) * distance;
    const destY = Math.sin(angle) * distance - rand(40,160);
    const rot = rand(-720,720);
    c.animate([
      { transform: `translate(0,0) rotate(0deg)`, opacity: 1 },
      { transform: `translate(${destX}px, ${destY}px) rotate(${rot}deg)`, opacity: 0 }
    ], { duration: rand(1000, 2200), easing: 'cubic-bezier(.2,.9,.2,1)' });
    setTimeout(()=> c.remove(), 2400);
  }
  // celebratory sound
  playFinalChime();
}

function rand(min, max){return Math.floor(Math.random()*(max-min+1))+min}

// spawn hearts regularly
// spawn particles regularly (calls different spawners depending on remaining days)
let currentState = null; // 'normal' | 'div10' | 'last10' | 'final1'
let final1Triggered = false;
function getState(days){
  if(days <= 1) return 'final1';
  if(days <= 10) return 'last10';
  if(days % 10 === 0 && days > 0) return 'div10';
  return 'normal';
}

function spawnParticle(){
  const days = parseInt(document.getElementById('days').textContent || '0', 10);
  const state = getState(days);
  if(state !== currentState){
    // entering new state
    currentState = state;
    if(state === 'final1' && !final1Triggered){
      final1Triggered = true;
      confettiBurst();
      showToast('נשאר יום אחד — מזל טוב!');
    } else if(state === 'last10'){
      showToast('10 הימים האחרונים — מתחיל המנוחה!');
    } else if(state === 'div10'){
      showToast('ספירה מיוחדת — חלוקה ב‑10');
    }
  }

  switch(state){
    case 'final1':
      // lots of rings + occasional confetti
      spawnRing();
      if(Math.random() < 0.08) confettiBurst();
      break;
    case 'last10':
      // bigger dramatic hearts
      spawnDramaticHeart();
      if(Math.random() < 0.06) spawnSparkle();
      break;
    case 'div10':
      // sparkles/stars instead of hearts
      spawnSparkle();
      break;
    default:
      spawnHeart();
  }
}

setInterval(spawnParticle, 220);

// Note: image file picker removed — background is set to black by CSS

// Re-add file controls behavior: choose image, restore default, or clear to black
const fileInput = document.getElementById('file');
const useDefaultBtn = document.getElementById('useDefault');
const clearBtn = document.getElementById('clearBg');
const bg = document.getElementById('bg');
const DEFAULT_BG = "https://i.postimg.cc/d0wzSWZ8/Whats-App-Image-5786-02-21-at-18-16-14.jpg";
const toastEl = document.getElementById('toast');
const toggleFitBtn = document.getElementById('toggleFit');
let fillMode = 'contain'; // or 'cover'
const soundToggleBtn = document.getElementById('soundToggle');
let soundEnabled = JSON.parse(localStorage.getItem('wc_sound') || 'true');

// WebAudio chime for final day
let audioCtx = null;
function ensureAudioCtx(){
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playFinalChime(){
  if(!soundEnabled) return;
  ensureAudioCtx();
  const t0 = audioCtx.currentTime;
  const freqs = [880, 660, 1100];
  freqs.forEach((f, i)=>{
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.value = 0;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0 + i*0.02);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.15, t0 + 0.02 + i*0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.9 + i*0.06);
    o.stop(t0 + 2.0 + i*0.06);
  });
}

function playPop(){
  if(!soundEnabled) return;
  ensureAudioCtx();
  const t0 = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'triangle';
  o.frequency.value = 1200;
  g.gain.value = 0;
  o.connect(g); g.connect(audioCtx.destination);
  o.start(t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.12, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
  o.stop(t0 + 0.5);
}

if (fileInput) {
  fileInput.addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    const url = URL.createObjectURL(f);
    bg.style.backgroundImage = `url('${url}')`;
    bg.style.backgroundSize = 'contain';
    bg.style.backgroundPosition = 'center center';
    console.log('Selected image:', f.name, f.type, f.size);
    showToast('התמונה הוחלפה');
    // revoke later to avoid memory leaks
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

if (useDefaultBtn) {
  useDefaultBtn.addEventListener('click', ()=>{
    bg.style.backgroundImage = `url('${DEFAULT_BG}')`;
    bg.style.backgroundSize = 'contain';
    bg.style.backgroundPosition = 'center center';
    showToast('התמונה הוחזרה לברירת המחדל');
  });
}

if (clearBtn) {
  clearBtn.addEventListener('click', ()=>{
    bg.style.backgroundImage = 'none';
    bg.style.backgroundColor = '#000';
    showToast('רקע הוחזר לשחור');
  });
}

if (toggleFitBtn) {
  toggleFitBtn.addEventListener('click', ()=>{
    fillMode = (fillMode === 'contain') ? 'cover' : 'contain';
    bg.style.backgroundSize = fillMode;
    toggleFitBtn.textContent = (fillMode === 'cover') ? 'מקורי' : 'מלא מסך';
    showToast((fillMode === 'cover') ? 'מלא מסך' : 'מקורי');
  });
}

function showToast(msg, ms = 1800){
  if(!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._hideTimer);
  toastEl._hideTimer = setTimeout(()=>{
    toastEl.classList.remove('show');
  }, ms);
}

// sound toggle handler
if(soundToggleBtn){
  function updateSoundUI(){
    soundToggleBtn.textContent = soundEnabled ? 'צליל: הפעל' : 'צליל: כבוי';
    if(!soundEnabled) soundToggleBtn.classList.add('silent'); else soundToggleBtn.classList.remove('silent');
    if(soundEnabled){
      try{ ensureAudioCtx(); audioCtx.resume && audioCtx.resume(); }catch(e){}
    }
  }
  updateSoundUI();
  soundToggleBtn.addEventListener('click', ()=>{
    soundEnabled = !soundEnabled;
    localStorage.setItem('wc_sound', JSON.stringify(soundEnabled));
    updateSoundUI();
    showToast(soundEnabled ? 'צליל מופעל' : 'צליל כבוי');
  });
}
