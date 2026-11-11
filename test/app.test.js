const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n');
const { shouldShutdown } = require('../src/automation');
const { normalize } = require('../src/usage');

// ---- Idiomas ----

// Recorre las claves de un objeto de textos, incluyendo los anidados.
function shape(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return shape(v, `${prefix}${k}.`);
    return [`${prefix}${k}:${Array.isArray(v) ? `array${v.length}` : typeof v === 'function' ? `fn${v.length}` : typeof v}`];
  }).sort();
}

test('español e inglés tienen exactamente los mismos textos', () => {
  // Misma clave, mismo tipo y misma cantidad de parámetros: un texto que falte en un idioma rompe acá.
  assert.deepEqual(shape(i18n.STR.en), shape(i18n.STR.es));
});

test('el idioma automático sigue al sistema', () => {
  assert.equal(i18n.resolve('auto', 'es-AR'), 'es');
  assert.equal(i18n.resolve('auto', 'en-US'), 'en');
  assert.equal(i18n.resolve('auto', 'pt-BR'), 'en');
  assert.equal(i18n.resolve('es', 'en-US'), 'es');
  assert.equal(i18n.resolve(undefined, undefined), 'en');
});

test('nombres de los límites', () => {
  const es = i18n.create('es');
  const en = i18n.create('en');
  assert.equal(es.limitName('five_hour'), '5 horas');
  assert.equal(en.limitName('seven_day'), 'Week');
  assert.equal(es.limitName('seven_day_opus'), 'Opus · semana');
  assert.equal(en.limitName('seven_day_oauth_apps'), 'Apps · week');
});

test('los errores se traducen por código', () => {
  const en = i18n.create('en');
  assert.match(en.errorText({ code: 'http', params: { status: 500 } }), /500/);
  assert.equal(en.errorText({ code: 'signIn' }), 'Sign in to claude.ai to see your usage.');
  assert.equal(en.errorText(new Error('otro')), 'otro');
});

// ---- Regla de apagado ----

const quiet = { pending: 0, gaveUp: 0, running: false, idleMinutes: 15, idleLimitMinutes: 10, armedMinutes: 5, retryEnabled: true, limitReached: false };

test('apaga solo cuando no queda nada y hubo silencio suficiente', () => {
  assert.equal(shouldShutdown(quiet), true);
  assert.equal(shouldShutdown({ ...quiet, armedMinutes: 1 }), false, 'recién activado');
  assert.equal(shouldShutdown({ ...quiet, pending: 1 }), false, 'queda una sesión cortada');
  assert.equal(shouldShutdown({ ...quiet, running: true }), false, 'retomando una sesión');
  assert.equal(shouldShutdown({ ...quiet, idleMinutes: 3 }), false, 'Claude escribió hace poco');
  assert.equal(shouldShutdown({ ...quiet, idleLimitMinutes: 30 }), false, 'el usuario pidió más silencio');
  assert.equal(shouldShutdown({ ...quiet, gaveUp: 2 }), true, 'las que no se pudieron retomar no bloquean');
});

// ---- Sesión de Claude Code ----

test('con el token vencido avisa sin consultar a la API', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medidor-cred-'));
  const exp = Date.now() - 5 * 864e5;
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token-de-prueba', expiresAt: exp } }));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  // Si llegara a consultar, la prueba falla acá en vez de salir a internet.
  t.mock.method(globalThis, 'fetch', () => { throw new Error('no debería consultar'); });
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { fetchUsage, SessionError } = require('../src/usage');
  await assert.rejects(fetchUsage(), (err) => err instanceof SessionError && err.code === 'rejected' && err.params.exp === exp);
});

// ---- Respuesta de la API ----

test('normalize se queda con los límites reconocibles y los ordena', () => {
  const { limits, extra } = normalize({
    seven_day_opus: { utilization: 12, resets_at: '2026-01-12T00:00:00Z' },
    seven_day: { utilization: 61, resets_at: '2026-01-12T00:00:00Z' },
    five_hour: { utilization: 38, resets_at: null },
    iguana_necktie: { utilization: 5 },
    extra_usage: { is_enabled: false },
  });
  assert.deepEqual(limits.map((l) => l.key), ['five_hour', 'seven_day', 'seven_day_opus']);
  assert.deepEqual(limits.map((l) => l.primary), [true, true, false]);
  assert.equal(limits[0].windowMs, 5 * 3600e3);
  assert.equal(limits[1].windowMs, 7 * 864e5);
  assert.equal(extra, null);
});
