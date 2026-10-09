'use strict';
/*
 * Amigo Secreto: API única (POST /api/app com { action, ... }).
 * Armazenamento: Redis da Upstash (Vercel Marketplace). Sem as variáveis de ambiente,
 * roda com um banco em memória apenas fora da Vercel (útil para testar localmente).
 *
 * Privacidade:
 *  - o organizador nunca recebe quem tirou quem (nenhuma ação devolve resultados a ele);
 *  - cada participante só lê o próprio resultado, com sessão própria;
 *  - subgrupos só aparecem nas ações do organizador;
 *  - PINs são guardados com hash (scrypt).
 */
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Armazenamento ---------- */
function memoryStore() {
  const m = new Map();
  const alive = (k) => {
    const e = m.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { m.delete(k); return null; }
    return e;
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { const e = alive(k); return e ? clone(e.val) : null; },
    async set(k, v, ex) { m.set(k, { val: clone(v), exp: ex ? Date.now() + ex * 1000 : 0 }); },
    async del(k) { m.delete(k); },
    async hget(k, f) { const e = alive(k); return e && f in e.val ? clone(e.val[f]) : null; },
    async hset(k, f, v) {
      let e = alive(k);
      if (!e) { e = { val: {}, exp: 0 }; m.set(k, e); }
      e.val[f] = clone(v);
    },
    async hmset(k, o) { for (const f of Object.keys(o)) await this.hset(k, f, o[f]); },
    async hgetall(k) { const e = alive(k); return e ? clone(e.val) : {}; },
    async hdel(k, f) { const e = alive(k); if (e) delete e.val[f]; },
    async incr(k) {
      let e = alive(k);
      if (!e) { e = { val: 0, exp: 0 }; m.set(k, e); }
      e.val += 1;
      return e.val;
    },
    async expire(k, s) { const e = alive(k); if (e) e.exp = Date.now() + s * 1000; },
  };
}

function upstashStore(url, token) {
  const { Redis } = require('@upstash/redis');
  const r = new Redis({ url, token });
  return {
    get: (k) => r.get(k),
    set: (k, v, ex) => (ex ? r.set(k, v, { ex }) : r.set(k, v)),
    del: (k) => r.del(k),
    hget: (k, f) => r.hget(k, f),
    hset: (k, f, v) => r.hset(k, { [f]: v }),
    hmset: (k, o) => (Object.keys(o).length ? r.hset(k, o) : Promise.resolve()),
    hgetall: async (k) => (await r.hgetall(k)) || {},
    hdel: (k, f) => r.hdel(k, f),
    incr: (k) => r.incr(k),
    expire: (k, s) => r.expire(k, s),
  };
}

let _store = null;
function getStore() {
  if (_store) return _store;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) _store = upstashStore(url, token);
  else if (!process.env.VERCEL) _store = memoryStore();
  else throw new HttpError(503, 'Banco de dados não configurado. Siga o passo 3 do README.');
  return _store;
}

/* ---------- Utilidades ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const normKey = (s) => String(s || '').trim().toLowerCase();

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(String(pin), salt, 32);
  const a = Buffer.from(h, 'hex');
  return a.length === calc.length && crypto.timingSafeEqual(a, calc);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function secureShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function clientIp(req) {
  const h = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'local';
  return String(h).split(',')[0].trim();
}
async function limit(key, max, windowSec) {
  const s = getStore();
  const k = 'as:rl:' + key;
  const n = await s.incr(k);
  if (n === 1) await s.expire(k, windowSec);
  if (n > max) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
}

async function getCfg() {
  const c = await getStore().get('as:cfg');
  return Object.assign({ status: 'open', event: '', note: '' }, c || {});
}
async function saveCfg(patch) {
  const c = Object.assign(await getCfg(), patch);
  await getStore().set('as:cfg', c);
  return c;
}

async function newSession(payload, ttlSec) {
  const token = crypto.randomBytes(24).toString('base64url');
  await getStore().set('as:sess:' + token, payload, ttlSec);
  return token;
}
function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(\S+)$/.exec(h);
  return m ? m[1] : '';
}
async function requirePerson(ctx) {
  const t = bearer(ctx.req);
  const sess = t ? await getStore().get('as:sess:' + t) : null;
  if (!sess || !sess.id) throw new HttpError(401, 'Sessão expirada. Entre de novo.');
  const person = await getStore().hget('as:people', sess.id);
  if (!person) throw new HttpError(401, 'Sessão expirada. Entre de novo.');
  return person;
}
async function requireAdmin(ctx) {
  const t = bearer(ctx.req);
  const sess = t ? await getStore().get('as:sess:' + t) : null;
  if (!sess || !sess.admin) throw new HttpError(401, 'Sessão do organizador expirada. Entre de novo.');
}

/* ---------- Subgrupos e sorteio ---------- */
function buildPools(people, groups) {
  const by = {}, order = [];
  people.forEach((p) => {
    const raw = ((groups[p.id] && groups[p.id].name) || '').trim();
    const k = normKey(raw);
    if (!by[k]) { by[k] = { key: k, name: raw || 'Sem subgrupo', members: [] }; order.push(k); }
    by[k].members.push(p);
  });
  const pools = order.map((k) => by[k]);
  const problems = [];
  if (people.length < 2) problems.push('Precisa de pelo menos 2 pessoas inscritas.');
  else pools.forEach((pl) => {
    if (pl.members.length < 2) {
      problems.push(pl.key
        ? 'O subgrupo "' + pl.name + '" tem só ' + pl.members[0].name + '. Coloque essa pessoa em outro subgrupo.'
        : pl.members[0].name + ' está sozinho(a) sem subgrupo. Coloque em um subgrupo com outras pessoas.');
    }
  });
  return { pools, problems };
}

/* ---------- Ações públicas ---------- */
const ACTIONS = {
  async state() {
    const cfg = await getCfg();
    return { event: cfg.event, note: cfg.note, status: cfg.status, imageAt: cfg.imageAt || 0 };
  },

  async image() {
    const im = await getStore().get('as:image');
    return { dataUrl: (im && im.dataUrl) || '' };
  },

  async register(ctx) {
    const s = getStore();
    await limit('reg:' + clientIp(ctx.req), 30, 3600);
    const cfg = await getCfg();
    if (cfg.status === 'drawn') throw new HttpError(403, 'As inscrições foram encerradas porque o sorteio já foi liberado.');
    const name = str(ctx.body.name, 80);
    const email = str(ctx.body.email, 120).toLowerCase();
    const gifts = str(ctx.body.gifts, 1000);
    const pin = String(ctx.body.pin == null ? '' : ctx.body.pin);
    if (!name) throw new HttpError(400, 'Informe seu nome.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
    if (pin.length < 4 || pin.length > 64) throw new HttpError(400, 'O PIN precisa ter pelo menos 4 caracteres.');
    if (await s.hget('as:emails', email)) throw new HttpError(409, 'Esse e-mail já está inscrito. Use a aba "Já me inscrevi" para entrar.');
    const id = crypto.randomBytes(6).toString('hex');
    await s.hset('as:people', id, { id, name, email, gifts, pin: hashPin(pin), createdAt: Date.now() });
    await s.hset('as:emails', email, { id });
    return { session: await newSession({ id }, 60 * 60 * 24 * 60) };
  },

  async login(ctx) {
    const s = getStore();
    const email = str(ctx.body.email, 120).toLowerCase();
    const pin = String(ctx.body.pin == null ? '' : ctx.body.pin);
    await limit('login:' + email, 8, 600);
    await limit('loginip:' + clientIp(ctx.req), 40, 600);
    const ref = email ? await s.hget('as:emails', email) : null;
    const person = ref ? await s.hget('as:people', ref.id) : null;
    if (!person || !checkPin(pin, person.pin)) throw new HttpError(401, 'E-mail ou PIN incorretos.');
    return { session: await newSession({ id: person.id }, 60 * 60 * 24 * 60) };
  },

  async me(ctx) {
    const person = await requirePerson(ctx);
    const cfg = await getCfg();
    let result = null;
    if (cfg.status === 'drawn') {
      const r = await getStore().hget('as:results', person.id);
      if (r) result = { receiverName: r.receiverName, receiverGifts: r.receiverGifts || '' };
    }
    return { name: person.name, email: person.email, gifts: person.gifts || '', status: cfg.status, result };
  },

  async update(ctx) {
    const person = await requirePerson(ctx);
    const cfg = await getCfg();
    if (cfg.status === 'drawn') throw new HttpError(403, 'O sorteio já foi liberado e a inscrição não pode mais ser editada.');
    const name = str(ctx.body.name, 80);
    if (!name) throw new HttpError(400, 'Informe seu nome.');
    person.name = name;
    person.gifts = str(ctx.body.gifts, 1000);
    await getStore().hset('as:people', person.id, person);
    return { ok: true };
  },

  /* ---------- Organizador ---------- */
  async admin_login(ctx) {
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) throw new HttpError(503, 'Defina a variável ADMIN_PASSWORD na Vercel (passo 4 do README).');
    await limit('admin:' + clientIp(ctx.req), 10, 900);
    if (!safeEqual(ctx.body.password || '', pass)) throw new HttpError(401, 'Senha incorreta.');
    return { session: await newSession({ admin: true }, 60 * 60 * 12) };
  },

  async admin_overview(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const cfg = await getCfg();
    const peopleMap = await s.hgetall('as:people');
    const groups = await s.hgetall('as:groups');
    const results = await s.hgetall('as:results');
    const list = Object.values(peopleMap);
    const ids = new Set(list.map((p) => p.id));
    const people = list
      .map((p) => ({ id: p.id, name: p.name, email: p.email, gifts: p.gifts || '', group: (groups[p.id] && groups[p.id].name) || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    let needsRedraw = false;
    if (cfg.status === 'drawn') {
      needsRedraw = list.some((p) => !results[p.id]) || Object.values(results).some((r) => !ids.has(r.receiverId));
    }
    return {
      cfg: { event: cfg.event, note: cfg.note, status: cfg.status, drawnAt: cfg.drawnAt || 0 },
      hasImage: !!cfg.imageAt,
      people,
      needsRedraw,
    };
  },

  async admin_set_group(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const id = str(ctx.body.id, 40);
    if (!(await s.hget('as:people', id))) throw new HttpError(404, 'Participante não encontrado.');
    const group = str(ctx.body.group, 60);
    if (group) await s.hset('as:groups', id, { name: group });
    else await s.hdel('as:groups', id);
    return { ok: true };
  },

  async admin_remove(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const id = str(ctx.body.id, 40);
    const person = await s.hget('as:people', id);
    if (!person) return { ok: true };
    await s.hdel('as:people', id);
    await s.hdel('as:emails', person.email);
    await s.hdel('as:groups', id);
    await s.hdel('as:results', id);
    return { ok: true };
  },

  async admin_reset_pin(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const id = str(ctx.body.id, 40);
    const pin = String(ctx.body.pin == null ? '' : ctx.body.pin);
    const person = await s.hget('as:people', id);
    if (!person) throw new HttpError(404, 'Participante não encontrado.');
    if (pin.length < 4 || pin.length > 64) throw new HttpError(400, 'O PIN precisa ter pelo menos 4 caracteres.');
    person.pin = hashPin(pin);
    await s.hset('as:people', id, person);
    return { ok: true };
  },

  async admin_save_cfg(ctx) {
    await requireAdmin(ctx);
    await saveCfg({ event: str(ctx.body.event, 100), note: str(ctx.body.note, 600) });
    return { ok: true };
  },

  async admin_image(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const url = ctx.body.dataUrl;
    if (!url) { await s.del('as:image'); await saveCfg({ imageAt: 0 }); return { ok: true }; }
    if (typeof url !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url) || url.length > 400000) {
      throw new HttpError(400, 'Imagem inválida ou grande demais.');
    }
    await s.set('as:image', { dataUrl: url });
    await saveCfg({ imageAt: Date.now() });
    return { ok: true };
  },

  async admin_draw(ctx) {
    await requireAdmin(ctx);
    const s = getStore();
    const people = Object.values(await s.hgetall('as:people'));
    const groups = await s.hgetall('as:groups');
    const { pools, problems } = buildPools(people, groups);
    if (problems.length) throw new HttpError(400, problems[0]);
    const cfg = await getCfg();
    if (cfg.status === 'drawn') await saveCfg({ status: 'open' });
    const now = Date.now();
    const out = {};
    pools.forEach((pl) => {
      const o = secureShuffle(pl.members.slice());
      o.forEach((g, i) => {
        const r = o[(i + 1) % o.length];
        out[g.id] = { receiverId: r.id, receiverName: r.name, receiverGifts: r.gifts || '', drawnAt: now };
      });
    });
    await s.del('as:results');
    await s.hmset('as:results', out);
    await saveCfg({ status: 'drawn', drawnAt: now });
    return { ok: true, people: people.length, pools: pools.length };
  },

  async admin_reopen(ctx) {
    await requireAdmin(ctx);
    await saveCfg({ status: 'open' });
    await getStore().del('as:results');
    return { ok: true };
  },
};

/* ---------- Entrada ---------- */
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!fn) return send(res, 404, { error: 'Ação desconhecida.' });
  try {
    return send(res, 200, await fn({ req, body }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Erro interno. Tente de novo em instantes.' });
  }
}

module.exports = handler;
module.exports._test = { useStore: (s) => { _store = s; }, memoryStore };
