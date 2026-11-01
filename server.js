/**
 * Slowmail privado — backend
 * Express + SQLite (node:sqlite embutido). Feito para exatamente duas pessoas.
 *
 * REGRA DE OURO (anti-spoiler):
 * O campo `content` só sai do banco para a API quando deliver_at <= agora.
 * Os endpoints de status/listagem nem sequer selecionam a coluna `content`
 * enquanto a carta está em trânsito ou fechada.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // SQLite embutido no Node (22.13+), sem compilação

// ───────────────────────── Configuração ─────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-em-producao';
const MIN_HOURS = parseFloat(process.env.MIN_HOURS ?? '24'); // mínimo de espera
const MAX_HOURS = parseFloat(process.env.MAX_HOURS ?? '72'); // máximo de espera
const MAX_CHARS = 10000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sessão de 30 dias

// As duas únicas pessoas e suas senhas
const USERS = {
  Carlos: process.env.PASSWORD_CARLOS || 'carta123',
  Amiga: process.env.PASSWORD_AMIGA || 'carta456',
};
const otherOf = (u) => (u === 'Carlos' ? 'Amiga' : 'Carlos');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('⚠️  Defina SESSION_SECRET em produção!');
}

// ───────────────────────── Banco de dados ─────────────────────────
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'slowmail.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS letters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender      TEXT    NOT NULL CHECK (sender   IN ('Carlos','Amiga')),
    receiver    TEXT    NOT NULL CHECK (receiver IN ('Carlos','Amiga')),
    content     TEXT    NOT NULL,
    sent_at     TEXT    NOT NULL,            -- ISO 8601 UTC
    deliver_at  TEXT    NOT NULL,            -- ISO 8601 UTC
    is_read     INTEGER NOT NULL DEFAULT 0   -- 0 = fechada, 1 = aberta
  );
  CREATE INDEX IF NOT EXISTS idx_letters_receiver ON letters (receiver, deliver_at);
  CREATE INDEX IF NOT EXISTS idx_letters_sender   ON letters (sender, deliver_at);
`);

const nowISO = () => new Date().toISOString(); // ISO UTC compara certo como texto

// ───────────────────────── Autenticação (token assinado) ─────────────────────────
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createToken(user) {
  const payload = b64(JSON.stringify({ u: user, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!USERS[u] || exp < Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const user = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (!user) return res.status(401).json({ error: 'Não autorizado' });
  req.user = user;
  next();
}

// Limite simples de tentativas de login (em memória)
const attempts = new Map();
function loginLimiter(req, res, next) {
  const key = req.ip;
  const rec = attempts.get(key) || { count: 0, until: 0 };
  if (rec.until > Date.now()) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  req.attemptKey = key;
  next();
}
function registerFail(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = Date.now() + 5 * 60 * 1000;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

// ───────────────────────── App ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Login: { user: "Carlos" | "Amiga", password }
app.post('/api/login', loginLimiter, (req, res) => {
  const { user, password } = req.body || {};
  if (!USERS[user] || typeof password !== 'string' || !safeEqual(password, USERS[user])) {
    registerFail(req.attemptKey);
    return res.status(401).json({ error: 'Nome ou senha incorretos.' });
  }
  attempts.delete(req.attemptKey);
  res.json({ token: createToken(user), user });
});

/**
 * Estado da tela principal. NUNCA seleciona `content`.
 *  - ready:   carta já entregue e ainda fechada (mostra "Abrir Envelope")
 *  - transit: carta a caminho (mostra contagem regressiva)
 *  - compose: nada pendente (mostra o formulário)
 */
app.get('/api/status', auth, (req, res) => {
  const me = req.user;
  const now = nowISO();

  const ready = db
    .prepare(
      `SELECT id, sender, sent_at, deliver_at FROM letters
       WHERE receiver = ? AND is_read = 0 AND deliver_at <= ?
       ORDER BY deliver_at ASC LIMIT 1`
    )
    .get(me, now);

  const transit = db
    .prepare(
      `SELECT sender, sent_at, deliver_at FROM letters
       WHERE receiver = ? AND deliver_at > ?
       ORDER BY deliver_at ASC LIMIT 1`
    )
    .get(me, now);

  // Cartas que EU enviei e ainda estão viajando
  const outgoing = db
    .prepare(
      `SELECT receiver, sent_at, deliver_at FROM letters
       WHERE sender = ? AND deliver_at > ? ORDER BY deliver_at ASC`
    )
    .all(me, now);

  res.json({
    me,
    other: otherOf(me),
    state: ready ? 'ready' : transit ? 'transit' : 'compose',
    ready: ready || null,
    transit: transit || null,
    outgoing,
    serverNow: now, // o front usa para corrigir diferença de relógio
  });
});

// Enviar carta: { content }
app.post('/api/letters', auth, (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'A carta está vazia.' });
  if (content.length > MAX_CHARS) {
    return res.status(400).json({ error: `Máximo de ${MAX_CHARS} caracteres.` });
  }

  // Entrega aleatória entre MIN_HOURS e MAX_HOURS a partir de agora
  const hours = MIN_HOURS + Math.random() * Math.max(0, MAX_HOURS - MIN_HOURS);
  const sentAt = new Date();
  const deliverAt = new Date(sentAt.getTime() + hours * 3600 * 1000);

  const info = db
    .prepare(
      `INSERT INTO letters (sender, receiver, content, sent_at, deliver_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(req.user, otherOf(req.user), content, sentAt.toISOString(), deliverAt.toISOString());

  // Não devolvemos o content
  res.status(201).json({
    id: info.lastInsertRowid,
    sent_at: sentAt.toISOString(),
    deliver_at: deliverAt.toISOString(),
  });
});

// Abrir uma carta. Só devolve `content` se já foi entregue e eu sou remetente/destinatário.
app.get('/api/letters/:id', auth, (req, res) => {
  const letter = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  const involved = letter && (letter.sender === req.user || letter.receiver === req.user);
  if (!involved) return res.status(404).json({ error: 'Carta não encontrada.' });

  // 🔒 Verificação anti-spoiler
  if (letter.deliver_at > nowISO()) {
    return res.status(403).json({ error: 'Esta carta ainda está a caminho.' });
  }

  // Ao abrir pela primeira vez, o destinatário marca como lida
  if (letter.receiver === req.user && !letter.is_read) {
    db.prepare('UPDATE letters SET is_read = 1 WHERE id = ?').run(letter.id);
    letter.is_read = 1;
  }
  res.json(letter);
});

/**
 * Baú de cartas: cartas já entregues e "abertas" para mim
 * (as que enviei + as que recebi e já li). Cartas recebidas e ainda fechadas
 * ficam de fora para preservar o ritual do envelope.
 */
app.get('/api/chest', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, sender, receiver, content, sent_at, deliver_at FROM letters
       WHERE deliver_at <= ?
         AND (sender = ? OR (receiver = ? AND is_read = 1))
       ORDER BY deliver_at DESC`
    )
    .all(nowISO(), req.user, req.user);
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`💌 Slowmail rodando em http://localhost:${PORT}`);
  console.log(`   Entrega entre ${MIN_HOURS}h e ${MAX_HOURS}h`);
});
