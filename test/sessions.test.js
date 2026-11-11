const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../src/sessions');

const NOW = Date.now();
const iso = (agoMin) => new Date(NOW - agoMin * 60e3).toISOString();

// Entradas de un registro de Claude Code, reducidas a los campos que el detector mira.
const user = (agoMin, cwd = 'C:\\proj') => ({ type: 'user', sessionId: 's', cwd, timestamp: iso(agoMin), message: { role: 'user', content: 'hola' } });
const assistant = (agoMin, stop = 'end_turn') => ({ type: 'assistant', sessionId: 's', timestamp: iso(agoMin), message: { role: 'assistant', stop_reason: stop } });
const limitError = (agoMin) => ({
  type: 'assistant', sessionId: 's', timestamp: iso(agoMin), isApiErrorMessage: true, error: 'rate_limit',
  quotaLimits: { rateLimitType: 'five_hour', resetsAt: Math.round((NOW + 3600e3) / 1000) }, message: { role: 'assistant' },
});

// Arma una carpeta de registros temporal con una sesión por archivo.
function fixture(sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medidor-test-'));
  const dir = path.join(root, 'C--proj');
  fs.mkdirSync(dir);
  for (const [id, entries, mtimeAgoMin] of sessions) {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, entries.map((e) => JSON.stringify({ ...e, sessionId: id })).join('\n') + '\n');
    const m = new Date(NOW - mtimeAgoMin * 60e3);
    fs.utimesSync(file, m, m);
  }
  return root;
}
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('clasifica cada sesión por cómo termina su registro', (t) => {
  const root = fixture([
    ['cortada', [user(30), limitError(29)], 29],
    ['retomada', [user(60), limitError(59), user(20), assistant(19)], 19],
    ['trabajando', [user(1), assistant(0.5, 'tool_use')], 0.5],
    ['quieta', [user(30), assistant(29, 'tool_use')], 29],
    ['terminada', [user(40), assistant(39)], 39],
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const r = scan({ dirs: [root], now: NOW });
  const s = byId(r.sessions);
  assert.equal(s.cortada.status, 'waiting');
  assert.equal(s.cortada.limitType, 'five_hour');
  assert.equal(s.retomada.status, 'done');
  assert.equal(s.trabajando.status, 'working');
  assert.equal(s.quieta.status, 'stalled');
  assert.equal(s.terminada.status, 'done');
  assert.deepEqual(r.pending.map((p) => p.id), ['cortada']);
  assert.equal(s.cortada.cwd, 'C:\\proj');
});

test('un corte viejo no pasa por reciente aunque el archivo se haya tocado hoy', (t) => {
  // Caso real: el error es de hace semanas y un /compact posterior modificó el archivo.
  const compact = { type: 'user', timestamp: iso(60), message: { role: 'user', content: '<command-name>/compact</command-name>' } };
  const root = fixture([['vieja', [user(60 * 24 * 40), limitError(60 * 24 * 40), compact], 60]]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const r = scan({ dirs: [root], now: NOW });
  assert.equal(r.pending.length, 0);
  assert.notEqual(byId(r.sessions).vieja.status, 'waiting');
});

test('un comando local después del corte no cuenta como retomada', (t) => {
  const compact = { type: 'user', timestamp: iso(5), message: { role: 'user', content: '<command-name>/compact</command-name>' } };
  const root = fixture([['cortada', [user(30), limitError(29), compact], 5]]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(scan({ dirs: [root], now: NOW }).pending.map((p) => p.id), ['cortada']);
});

test('abrir una sesión vieja no la hace figurar como trabajando', (t) => {
  // Caso real: la app agrega metadatos sin fecha al abrir la sesión y el archivo queda con fecha de hoy.
  const meta = [{ type: 'last-prompt', lastPrompt: 'x' }, { type: 'tools-used' }, { type: 'cost-state' }];
  const twoMonths = 60 * 24 * 60;
  const root = fixture([
    ['vieja', [user(twoMonths), assistant(twoMonths), ...meta], 1],
    ['a-medias', [user(twoMonths), assistant(twoMonths, 'tool_use'), ...meta], 1],
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const r = scan({ dirs: [root], now: NOW });
  assert.deepEqual(r.sessions, []);
  // Tampoco debe contar como actividad reciente para la regla de apagado.
  assert.ok(NOW - r.lastActivity > 24 * 3600e3);
});

test('usa el título de la sesión si existe', (t) => {
  const root = fixture([['con-titulo', [user(10), assistant(9), { type: 'custom-title', customTitle: 'Mi sesión' }], 9]]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(scan({ dirs: [root], now: NOW }).sessions[0].title, 'Mi sesión');
});

test('una carpeta vacía o inexistente no rompe', () => {
  const r = scan({ dirs: [path.join(os.tmpdir(), 'no-existe-medidor')], now: NOW });
  assert.deepEqual(r, { sessions: [], pending: [], lastActivity: 0 });
});
