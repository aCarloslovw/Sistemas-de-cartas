/**
 * Slowmail — frontend (JS puro).
 * Todo texto vindo do servidor é inserido com textContent (sem risco de XSS).
 */
const $ = (s) => document.querySelector(s);

let token = localStorage.getItem('slowmail_token');
let me = localStorage.getItem('slowmail_user');
let tick = null;          // intervalo da contagem regressiva
let writeAnyway = false;  // deixa escrever mesmo com carta chegando

// ───────── Helpers ─────────
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Sessão expirada.'); }
  if (!res.ok) throw new Error(data.error || 'Algo deu errado.');
  return data;
}

// Cria elemento com texto seguro
function el(tag, { cls, text, attrs } = {}, ...children) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  children.forEach((c) => c && e.append(c));
  return e;
}

const fmtDate = (iso, long = true) =>
  new Date(iso).toLocaleString('pt-BR', long
    ? { dateStyle: 'full', timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' });

function fmtRemaining(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (d ? `${d}d ` : '') + `${p(h)}h ${p(m)}min ${p(sec)}s`;
}

// ───────── Login / Logout ─────────
function showLogin() {
  clearInterval(tick);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

function logout() {
  token = me = null;
  localStorage.removeItem('slowmail_token');
  localStorage.removeItem('slowmail_user');
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const user = new FormData(e.target).get('user');
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ user, password: $('#password').value }),
    });
    token = data.token; me = data.user;
    localStorage.setItem('slowmail_token', token);
    localStorage.setItem('slowmail_user', me);
    $('#password').value = '';
    startApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', logout);

// ───────── App ─────────
function startApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#hello').textContent = `Olá, ${me} ✉️`;
  refresh();
}

async function refresh() {
  clearInterval(tick);
  try {
    const status = await api('/status');
    renderStage(status);
    loadChest();
  } catch (err) {
    if (token) $('#stage').replaceChildren(el('p', { cls: 'error', text: err.message }));
  }
}

function renderStage(st) {
  const stage = $('#stage');
  stage.replaceChildren();

  if (st.state === 'ready' && !writeAnyway) return renderReady(stage, st);
  if (st.state === 'transit' && !writeAnyway) return renderTransit(stage, st);
  renderCompose(stage, st);
}

// ── Carta em trânsito: contagem regressiva ──
function renderTransit(stage, st) {
  const offset = new Date(st.serverNow) - Date.now(); // corrige relógio do aparelho
  const target = new Date(st.transit.deliver_at);
  const countdown = el('div', { cls: 'countdown' });

  const writeBtn = el('button', { cls: 'btn ghost', text: 'Escrever uma carta enquanto espero' });
  writeBtn.onclick = () => { writeAnyway = true; renderStage(st); };

  stage.append(el('div', { cls: 'wait' },
    el('div', { cls: 'flyer', text: '💌' }),
    el('h2', { text: `Sua carta de ${st.transit.sender} está a caminho!` }),
    el('p', { cls: 'note', text: 'Boas cartas atravessam o tempo devagar.' }),
    countdown,
    el('p', { cls: 'eta', text: `Chegada estimada: ${fmtDate(st.transit.deliver_at)}` }),
    writeBtn
  ));

  const update = () => {
    const left = target - (Date.now() + offset);
    if (left <= 0) { clearInterval(tick); refresh(); return; } // chegou!
    countdown.textContent = fmtRemaining(left);
  };
  update();
  tick = setInterval(update, 1000);
}

// ── Carta entregue: envelope fechado ──
function renderReady(stage, st) {
  const envelope = el('div', { cls: 'envelope' },
    el('div', { cls: 'env-back' }),
    el('div', { cls: 'env-paper' }),
    el('div', { cls: 'env-front' }),
    el('div', { cls: 'env-flap' }),
    el('div', { cls: 'env-seal' })
  );
  const btn = el('button', { cls: 'btn', text: 'Abrir Envelope' });
  const wrap = el('div', { cls: 'envelope-wrap' },
    el('h2', { text: `Chegou uma carta de ${st.ready.sender}` }),
    el('p', { cls: 'note', text: `Entregue em ${fmtDate(st.ready.deliver_at)}` }),
    envelope, btn
  );
  stage.append(wrap);

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const letter = await api('/letters/' + st.ready.id); // só agora o texto é liberado
      envelope.classList.add('open');                       // anima aba + papel
      setTimeout(() => envelope.classList.add('gone'), 1700);
      setTimeout(() => {
        stage.replaceChildren(buildLetter(letter));
        loadChest();
      }, 2200);
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
  };
}

function buildLetter(l) {
  const back = el('button', { cls: 'btn ghost', text: 'Escrever resposta' });
  back.onclick = () => { writeAnyway = false; refresh(); };
  return el('div', {},
    el('div', { cls: 'letter' },
      el('div', { cls: 'meta', text: `De ${l.sender} · ${fmtDate(l.sent_at, false)}` }),
      el('p', { cls: 'body', text: l.content })
    ),
    back
  );
}

// ── Formulário de escrita ──
function renderCompose(stage, st) {
  const area = el('textarea', { attrs: { placeholder: `Querida(o) ${st.other}...`, maxlength: 10000, required: '' } });
  const err = el('p', { cls: 'error', attrs: { role: 'alert' } });
  const send = el('button', { cls: 'btn', text: 'Selar e enviar', attrs: { type: 'submit' } });
  const form = el('form', {}, area, send, err);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    send.disabled = true;
    try {
      await api('/letters', { method: 'POST', body: JSON.stringify({ content: area.value }) });
      writeAnyway = false;
      refresh();
    } catch (ex) {
      err.textContent = ex.message;
      send.disabled = false;
    }
  });

  stage.append(el('h2', { text: `Escrever carta para ${st.other}` }));
  if (st.outgoing.length) {
    stage.append(el('p', { cls: 'note', text: `📮 Sua última carta chega a ${st.other} em ${fmtDate(st.outgoing[st.outgoing.length - 1].deliver_at)}.` }));
  }
  stage.append(form);
}

// ── Baú de cartas ──
async function loadChest() {
  const list = $('#chest-list');
  try {
    const letters = await api('/chest');
    list.replaceChildren();
    if (!letters.length) {
      list.append(el('p', { cls: 'note', text: 'Ainda não há cartas guardadas no baú.' }));
      return;
    }
    letters.forEach((l) => {
      const who = l.sender === me ? `Você → ${l.receiver}` : `${l.sender} → você`;
      list.append(el('details', { cls: 'chest-item' },
        el('summary', {},
          el('span', { cls: 'who-line', text: who }),
          el('span', { cls: 'when', text: fmtDate(l.deliver_at, false) })
        ),
        el('p', { cls: 'chest-body', text: l.content })
      ));
    });
  } catch { /* ignora; o stage já mostra erros */ }
}

// ───────── Boot ─────────
token && me ? startApp() : showLogin();
