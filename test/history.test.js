const test = require('node:test');
const assert = require('node:assert/strict');
const { record, forecast } = require('../src/history');

const H = 3600e3;
const NOW = Date.parse('2026-01-10T12:00:00Z');

// Límite de 5 horas que se reinicia dentro de `leftH` horas.
const five = (used, leftH = 2) => ({ key: 'five_hour', windowMs: 5 * H, used, resetsAt: new Date(NOW + leftH * H).toISOString() });
const week = (used, leftDays = 3) => ({ key: 'seven_day', windowMs: 7 * 24 * H, used, resetsAt: new Date(NOW + leftDays * 24 * H).toISOString() });
// Muestra de la misma ventana que `l`, tomada hace `agoMin` minutos.
const sample = (l, agoMin, used) => ({ t: NOW - agoMin * 60e3, l: { [l.key]: [used, Date.parse(l.resetsAt)] } });

test('agotado: no pronostica una hora, informa desde cuándo', () => {
  const l = five(100, 0.8);
  const f = forecast(l, [sample(l, 130, 82), sample(l, 120, 100), sample(l, 0, 100)], NOW);
  assert.equal(f.state, 'full');
  assert.equal(f.fullSince, NOW - 120 * 60e3);
  assert.equal(f.hitAt, undefined);
});

test('agotado sin haber visto el momento: fullSince queda vacío', () => {
  const l = five(100, 0.8);
  assert.equal(forecast(l, [sample(l, 30, 100), sample(l, 0, 100)], NOW).fullSince, null);
});

test('99,6% ya cuenta como agotado (se muestra redondeado a 100)', () => {
  assert.equal(forecast(five(99.6), [], NOW).state, 'full');
});

test('sin uso en la ventana', () => {
  assert.equal(forecast(five(0), [], NOW).state, 'idle');
  assert.equal(forecast({ key: 'five_hour', windowMs: 5 * H, used: 0, resetsAt: null }, [], NOW).state, 'idle');
});

test('ritmo reciente alto: avisa antes del reinicio', () => {
  const l = five(60, 2);
  // 40 puntos en los últimos 40 minutos: los 40 que faltan se van en 40 minutos, mucho antes de las 2 horas.
  const f = forecast(l, [sample(l, 40, 20)], NOW);
  assert.equal(f.state, 'fast');
  assert.equal(f.basis, 'recent');
  assert.ok(Math.abs(f.hitAt - (NOW + 40 * 60e3)) < 1000);
});

test('uso alto pero quieto en la última hora: alcanza', () => {
  const l = five(90, 1);
  const f = forecast(l, [sample(l, 50, 90)], NOW);
  assert.equal(f.state, 'ok');
  assert.equal(f.rate, 0);
});

test('sin historial usa el promedio de la ventana', () => {
  // 80% usado con 3 de 5 horas transcurridas: al promedio se acaba antes de las 2 horas que faltan.
  const f = forecast(five(80, 2), [], NOW);
  assert.equal(f.state, 'fast');
  assert.equal(f.basis, 'average');
});

test('ignora muestras de otra ventana', () => {
  const l = five(30, 4);
  const other = { t: NOW - 30 * 60e3, l: { five_hour: [5, Date.parse(l.resetsAt) - 5 * H] } };
  // La muestra vieja haría parecer que subió 25 puntos en media hora.
  assert.notEqual(forecast(l, [other], NOW).basis, 'recent');
});

test('el límite semanal mide el ritmo sobre 24 horas', () => {
  const l = week(61, 2.3);
  const f = forecast(l, [sample(l, 20 * 60, 45)], NOW);
  assert.equal(f.state, 'fast');
  assert.ok(f.hitAt < f.end);
});

test('record agrega la lectura y descarta las de más de 8 días', () => {
  const old = { t: NOW - 9 * 24 * H, l: {} };
  const recent = { t: NOW - H, l: {} };
  const out = record([old, recent], { limits: [five(10)] }, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[1].t, NOW);
  assert.deepEqual(out[1].l.five_hour, [10, NOW + 2 * H]);
});
