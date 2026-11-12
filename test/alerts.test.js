const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planAlerts, loadSeen, saveSeen, cleanTypes, windowId } = require('../src/alerts');

const H = 3600e3;
const NOW = Date.parse('2026-01-10T12:00:00Z');
const kinds = (plan) => plan.map((p) => `${p.limit.key}:${p.kind}`);

// Un límite de 5 horas que se reinicia a las 14:00 (con los milisegundos que le agrega la API).
const five = (used, resetsAt = '2026-01-10T14:00:00.471Z', forecast = {}) => ({ key: 'five_hour', windowMs: 5 * H, used, resetsAt, forecast });
const data = (...limits) => ({ limits });

test('el error real: la hora de reinicio cambia unos milisegundos en cada lectura', () => {
  // Valores tomados del historial de uso real: la misma ventana, leída una y otra vez.
  const jitter = ['04:10:00.471', '04:10:00.493', '04:09:59.687', '04:10:00.453', '04:10:00.636', '04:10:00.688'];
  const seen = {};
  const wasFull = new Set();
  let fired = 0;
  jitter.forEach((ms, i) => {
    const l = five(100, `2026-11-12T${ms}Z`);
    fired += planAlerts(data(l), { seen, wasFull, now: NOW + i * 3 * 60e3 }).length;
  });
  assert.equal(fired, 1, 'tiene que avisar una sola vez, no una por lectura');
});

test('la ventana se identifica igual aunque cambien los milisegundos', () => {
  assert.equal(windowId(five(0, '2026-11-12T04:10:00.471Z')), windowId(five(0, '2026-11-12T04:09:59.687Z')));
  assert.notEqual(windowId(five(0, '2026-11-12T04:10:00Z')), windowId(five(0, '2026-11-12T09:10:00Z')));
});

test('avisa solo el umbral más alto y no repite el de abajo', () => {
  const seen = {};
  assert.deepEqual(kinds(planAlerts(data(five(82)), { seen, now: NOW })), ['five_hour:p80']);
  assert.deepEqual(kinds(planAlerts(data(five(96)), { seen, now: NOW + 60e3 })), ['five_hour:p95']);
  // Ya pasó por los dos: bajar y volver a subir en la misma ventana no avisa de nuevo.
  assert.deepEqual(planAlerts(data(five(100)), { seen, now: NOW + 120e3 }), []);
  assert.deepEqual(planAlerts(data(five(81)), { seen, now: NOW + 180e3 }), []);
});

test('cruzar los dos umbrales de golpe avisa uno solo', () => {
  assert.deepEqual(kinds(planAlerts(data(five(97)), { seen: {}, now: NOW })), ['five_hour:p95']);
});

test('una ventana nueva vuelve a avisar', () => {
  const seen = {};
  assert.equal(planAlerts(data(five(96, '2026-01-10T14:00:00.1Z')), { seen, now: NOW }).length, 1);
  assert.equal(planAlerts(data(five(96, '2026-01-10T19:00:00.1Z')), { seen, now: NOW + 5 * H }).length, 1);
});

test('las clases de aviso apagadas no avisan', () => {
  assert.deepEqual(planAlerts(data(five(96)), { seen: {}, types: { p95: false }, now: NOW }), []);
  assert.deepEqual(kinds(planAlerts(data(five(85)), { seen: {}, types: { p95: false }, now: NOW })), ['five_hour:p80']);
  assert.deepEqual(planAlerts(data(five(85)), { seen: {}, types: { p80: false }, now: NOW }), []);
  // Si se apaga el de 95% y el uso llega ahí, el de 80% no salta tarde: ya quedó atrás.
  const seen = {};
  planAlerts(data(five(96)), { seen, types: { p95: false }, now: NOW });
  assert.deepEqual(planAlerts(data(five(97)), { seen, now: NOW + 60e3 }), [{ kind: 'p95', limit: five(97) }]);
});

test('por ritmo: avisa cuando se acaba pronto y una sola vez por ventana', () => {
  const fast = (hitInMin) => five(60, undefined, { state: 'fast', hitAt: NOW + hitInMin * 60e3, end: NOW + 2 * H });
  const seen = {};
  assert.deepEqual(planAlerts(data(fast(90)), { seen, now: NOW }), [], 'falta más de media hora: todavía no');
  assert.deepEqual(kinds(planAlerts(data(fast(20)), { seen, now: NOW })), ['five_hour:pace']);
  assert.deepEqual(planAlerts(data(fast(19)), { seen, now: NOW + 60e3 }), []);
  assert.deepEqual(planAlerts(data(fast(20)), { seen: {}, types: { pace: false }, now: NOW }), []);
});

test('avisa cuando se reinicia un límite que estaba agotado', () => {
  const wasFull = new Set();
  const seen = {};
  planAlerts(data(five(100, undefined, { state: 'full' })), { seen, wasFull, now: NOW });
  const after = planAlerts(data(five(0, '2026-01-10T19:00:00Z', { state: 'idle' })), { seen, wasFull, now: NOW + 2 * H });
  assert.deepEqual(kinds(after), ['five_hour:reset']);
  assert.deepEqual(planAlerts(data(five(0, '2026-01-10T19:00:00Z', { state: 'idle' })), { seen, wasFull, now: NOW + 3 * H }), []);
  // Apagado: se entera igual pero no avisa.
  const quiet = new Set(['five_hour']);
  assert.deepEqual(planAlerts(data(five(0, undefined, { state: 'idle' })), { seen: {}, wasFull: quiet, types: { reset: false }, now: NOW }), []);
});

test('los avisos dados sobreviven a un reinicio del widget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medidor-alerts-'));
  const file = path.join(dir, 'alerts.json');
  try {
    const seen = {};
    assert.equal(planAlerts(data(five(100)), { seen, now: NOW }).length, 1);
    saveSeen(file, seen, NOW);

    // "Reinicio": se vuelve a leer el archivo y la misma ventana no avisa otra vez.
    const reloaded = loadSeen(file, NOW + 60e3);
    assert.deepEqual(planAlerts(data(five(100, '2026-01-10T14:00:00.999Z')), { seen: reloaded, now: NOW + 60e3 }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('los avisos de hace más de 8 días se descartan y un archivo roto no molesta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medidor-alerts-'));
  const file = path.join(dir, 'alerts.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ viejo: NOW - 9 * 24 * H, reciente: NOW - H, roto: 'x' }));
    assert.deepEqual(Object.keys(loadSeen(file, NOW)), ['reciente']);
    fs.writeFileSync(file, '{no es json');
    assert.deepEqual(loadSeen(file, NOW), {});
    assert.deepEqual(loadSeen(path.join(dir, 'no-existe.json'), NOW), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanTypes solo deja las clases conocidas, como booleanos', () => {
  assert.deepEqual(cleanTypes({ p80: false, pace: 'x', extra: true }), { p80: false, p95: true, pace: true, reset: true });
  assert.deepEqual(cleanTypes(undefined), { p80: true, p95: true, pace: true, reset: true });
});
