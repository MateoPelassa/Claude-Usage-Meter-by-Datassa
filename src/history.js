// Historial de lecturas de uso. La API solo devuelve una foto (porcentaje + hora de reinicio);
// guardando las fotos se puede medir el ritmo reciente y saber cuándo se llegó al tope.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 8 * 864e5;
// La hora de reinicio de una misma ventana puede variar unos segundos entre consultas.
const SAME_WINDOW_MS = 2 * 60e3;

function load(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function save(file, samples) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(samples));
}

// Agrega la lectura actual y descarta las de más de 8 días. Cada muestra: { t, l: { clave: [usado, reinicioMs] } }.
function record(samples, data, now = Date.now()) {
  const next = samples.filter((s) => s.t >= now - KEEP_MS && s.t < now);
  next.push({ t: now, l: Object.fromEntries(data.limits.map((l) => [l.key, [l.used, l.resetsAt ? Date.parse(l.resetsAt) : null]])) });
  return next;
}

// Estado de un límite:
//   idle  sin uso en la ventana
//   ok    al ritmo actual alcanza hasta el reinicio
//   fast  al ritmo actual se acaba antes (hitAt)
//   full  ya está agotado (fullSince si el widget vio el momento)
function forecast(l, samples, now = Date.now()) {
  const end = l.resetsAt ? Date.parse(l.resetsAt) : null;
  const full = Math.round(l.used) >= 100;
  if (!end || end <= now) return { state: full ? 'full' : l.used > 0 ? 'ok' : 'idle', end: null };

  // Lecturas de esta misma ventana, de la más vieja a la más nueva.
  const mine = samples
    .filter((s) => s.l[l.key] && s.l[l.key][1] != null && Math.abs(s.l[l.key][1] - end) <= SAME_WINDOW_MS)
    .map((s) => ({ t: s.t, used: s.l[l.key][0] }));

  if (full) {
    const i = mine.findIndex((s) => Math.round(s.used) >= 100);
    // Solo se sabe el momento exacto si antes hubo una lectura por debajo del tope.
    return { state: 'full', end, fullSince: i > 0 ? mine[i].t : null };
  }
  if (l.used <= 0) return { state: 'idle', end };

  // Ritmo reciente: última hora para la ventana de 5 h, últimas 24 h para la semanal.
  const weekly = l.windowMs > 864e5;
  const span = weekly ? 24 * 3600e3 : 3600e3;
  const minSpan = weekly ? 2 * 3600e3 : 10 * 60e3;
  const base = mine.find((s) => s.t >= now - span);
  let rate = null; // % por milisegundo
  let basis = null;
  if (base && now - base.t >= minSpan) {
    rate = (l.used - base.used) / (now - base.t);
    basis = 'recent';
  } else {
    // Sin historial suficiente: promedio desde que arrancó la ventana.
    const elapsed = now - (end - l.windowMs);
    if (elapsed >= l.windowMs * 0.04) {
      rate = l.used / elapsed;
      basis = 'average';
    }
  }
  if (rate == null || rate <= 0) return { state: 'ok', end, basis, rate: rate == null ? null : 0 };
  const hitAt = now + (100 - l.used) / rate;
  return hitAt < end ? { state: 'fast', end, hitAt, basis, rate } : { state: 'ok', end, basis, rate };
}

module.exports = { load, save, record, forecast };
