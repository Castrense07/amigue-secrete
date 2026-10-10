'use strict';
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/app.js');

function makeRes() {
  const res = { statusCode: 0, headers: {}, json: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (s) => { try { res.json = s ? JSON.parse(s) : null; } catch (e) { res.json = s; } };
  return res;
}

async function call(action, data, token) {
  const req = { method: 'POST', headers: {}, body: Object.assign({ action }, data || {}) };
  if (token) req.headers.authorization = 'Bearer ' + token;
  const res = makeRes();
  await handler(req, res);
  return res;
}

function freshStore() {
  handler._test.reset();
  handler._test.useStore(handler._test.memoryStore());
}

const reg = (name, email, extra) => call('register', Object.assign({ name, email, gifts: '', pin: '1234' }, extra || {}));
const loginAdmin = (password) => call('admin_login', { password: password == null ? 'segredo' : password });

test('registro e login básicos', async () => {
  freshStore();
  const r = await reg('Ana', 'ana@example.com', { gifts: 'livros' });
  assert.equal(r.statusCode, 200);
  assert.ok(r.json.session);

  const me = await call('me', {}, r.json.session);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json.name, 'Ana');
  assert.equal(me.json.result, null);

  const ok = await call('login', { email: 'ana@example.com', pin: '1234' });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json.session);

  const bad = await call('login', { email: 'ana@example.com', pin: '9999' });
  assert.equal(bad.statusCode, 401);
});

test('e-mail duplicado retorna 409', async () => {
  freshStore();
  assert.equal((await reg('A', 'x@y.com')).statusCode, 200);
  const dup = await reg('B', 'x@y.com');
  assert.equal(dup.statusCode, 409);
});

test('sugestões viram lista e entradas inválidas são descartadas', async () => {
  freshStore();
  const gifts = [
    { text: 'Fone bluetooth', link: 'https://amazon.com.br/dp/x', price: '199,90' },
    { text: 'Livro', link: 'javascript:alert(1)', price: -5 },
    { text: '' },
    'Item solto',
  ];
  const r = await reg('Ana', 'ana@x.com', { gifts });
  assert.equal(r.statusCode, 200);
  const me = await call('me', {}, r.json.session);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json.gifts.length, 3);
  assert.deepEqual(me.json.gifts[0], { text: 'Fone bluetooth', link: 'https://amazon.com.br/dp/x', price: 199.9 });
  assert.deepEqual(me.json.gifts[1], { text: 'Livro', link: '', price: null });
  assert.deepEqual(me.json.gifts[2], { text: 'Item solto', link: '', price: null });
});

test('faixa de preço do evento vai e volta', async () => {
  freshStore();
  process.env.ADMIN_PASSWORD = 'segredo';
  const at = (await loginAdmin()).json.session;
  assert.equal((await call('admin_save_cfg', { event: 'Natal', note: '', budgetMin: '30', budgetMax: '50' }, at)).statusCode, 200);
  const st = await call('state', {});
  assert.equal(st.json.budgetMin, 30);
  assert.equal(st.json.budgetMax, 50);
  const ov = await call('admin_overview', {}, at);
  assert.equal(ov.json.cfg.budgetMin, 30);
  assert.equal(ov.json.cfg.budgetMax, 50);
  delete process.env.ADMIN_PASSWORD;
});

test('registros concorrentes com o mesmo e-mail não duplicam', async () => {
  freshStore();
  const [a, b] = await Promise.all([reg('A', 'same@x.com'), reg('B', 'same@x.com')]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('sorteio distribui em ciclo e não revela ao organizador', async () => {
  freshStore();
  process.env.ADMIN_PASSWORD = 'segredo';
  const s1 = (await reg('Ana', 'ana@x.com')).json.session;
  const s2 = (await reg('Bia', 'bia@x.com')).json.session;
  const s3 = (await reg('Caio', 'caio@x.com')).json.session;

  const adm = await loginAdmin();
  assert.equal(adm.statusCode, 200);
  const at = adm.json.session;

  const ov = await call('admin_overview', {}, at);
  assert.equal(ov.statusCode, 200);
  assert.equal(ov.json.people.length, 3);
  assert.ok(Array.isArray(ov.json.problems));
  assert.ok(!('hasImage' in ov.json));
  assert.ok(!('results' in ov.json));

  const d = await call('admin_draw', {}, at);
  assert.equal(d.statusCode, 200);

  const picked = [];
  for (const [name, tok] of [['Ana', s1], ['Bia', s2], ['Caio', s3]]) {
    const me = await call('me', {}, tok);
    assert.equal(me.statusCode, 200);
    assert.ok(me.json.result && me.json.result.receiverName);
    assert.notEqual(me.json.result.receiverName, name);
    assert.ok(Array.isArray(me.json.result.receiverGifts));
    picked.push(me.json.result.receiverName);
  }
  assert.deepEqual(picked.sort(), ['Ana', 'Bia', 'Caio']);

  const ov2 = await call('admin_overview', {}, at);
  assert.ok(!('results' in ov2.json));
  assert.equal(ov2.json.cfg.status, 'drawn');
  delete process.env.ADMIN_PASSWORD;
});

test('um participante gera problema e bloqueia o sorteio', async () => {
  freshStore();
  process.env.ADMIN_PASSWORD = 'segredo';
  await reg('A', 'a@x.com');
  const at = (await loginAdmin()).json.session;
  const ov = await call('admin_overview', {}, at);
  assert.ok(ov.json.problems.length >= 1);
  const d = await call('admin_draw', {}, at);
  assert.equal(d.statusCode, 400);
  delete process.env.ADMIN_PASSWORD;
});

test('inscrições fecham depois do sorteio', async () => {
  freshStore();
  process.env.ADMIN_PASSWORD = 'segredo';
  await reg('A', 'a@x.com');
  await reg('B', 'b@x.com');
  const at = (await loginAdmin()).json.session;
  await call('admin_draw', {}, at);
  const r = await reg('C', 'c@x.com');
  assert.equal(r.statusCode, 403);
  delete process.env.ADMIN_PASSWORD;
});

test('reabrir limpa resultados e drawnAt', async () => {
  freshStore();
  process.env.ADMIN_PASSWORD = 'segredo';
  const s1 = (await reg('A', 'a@x.com')).json.session;
  await reg('B', 'b@x.com');
  const at = (await loginAdmin()).json.session;
  await call('admin_draw', {}, at);
  const re = await call('admin_reopen', {}, at);
  assert.equal(re.statusCode, 200);
  const ov = await call('admin_overview', {}, at);
  assert.equal(ov.json.cfg.status, 'open');
  assert.equal(ov.json.cfg.drawnAt, 0);
  const me = await call('me', {}, s1);
  assert.equal(me.json.result, null);
  delete process.env.ADMIN_PASSWORD;
});

test('admin_login sem ADMIN_PASSWORD retorna 503', async () => {
  freshStore();
  delete process.env.ADMIN_PASSWORD;
  const r = await loginAdmin('qualquer');
  assert.equal(r.statusCode, 503);
});

test('diag não expõe nomes de variáveis', async () => {
  freshStore();
  const res = makeRes();
  await handler({ method: 'GET', url: '/api/app?diag=1', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok('urlDoBancoEncontrada' in res.json);
  assert.ok(!('variaveisRelacionadasAoBanco' in res.json));
});
