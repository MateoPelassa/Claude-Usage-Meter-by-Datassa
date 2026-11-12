// Decide qué avisos corresponden en cada lectura. No muestra nada: devuelve la lista, y quien llama los muestra.
// Así la lógica se puede probar sin abrir ventanas, y el error de avisos repetidos tiene su propia prueba.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 8 * 864e5;
const TYPES = ['p80', 'p95', 'pace', 'reset'];

// Identifica una ventana de consumo (por ejemplo "las 5 horas que terminan a las 04:10").
// La API devuelve la hora de reinicio con milisegundos que cambian en cada lectura (04:10:00.471, 04:09:59.687...),
// así que se redondea al minuto: usar el valor tal cual hacía que cada lectura pareciera una ventana nueva
// y el mismo aviso saltara una y otra vez.
const windowId = (l) => `${l.key}:${l.resetsAt ? Math.round(Date.parse(l.resetsAt) / 60e3) : 'sin-reinicio'}`;

// `seen` es { clave: momento } con los avisos que ya se dieron. `wasFull` es el conjunto de límites que estaban agotados.
// types: qué clases de aviso quiere el usuario ({ p80, p95, pace, reset }); lo que no sea `false` está activo.
function planAlerts(data, { types = {}, seen, wasFull = new Set(), now = Date.now() }) {
  const on = (k) => types[k] !== false;
  const out = [];
  for (const l of data.limits) {
    const win = windowId(l);
    const f = l.forecast || {};
    // Un aviso por ventana y por clase: devuelve true la primera vez y false todas las siguientes.
    const once = (kind) => {
      const k = `${win}:${kind}`;
      if (seen[k]) return false;
      seen[k] = now;
      return true;
    };

    // Por ritmo: avisa antes de llegar, no cuando ya casi no queda.
    const soon = l.windowMs > 864e5 ? 6 * 3600e3 : 30 * 60e3;
    if (on('pace') && f.state === 'fast' && f.hitAt - now < soon && once('fast')) out.push({ kind: 'pace', limit: l });

    // Se reinició un límite que estaba agotado.
    if (f.state === 'full') wasFull.add(l.key);
    else if (wasFull.delete(l.key) && on('reset')) out.push({ kind: 'reset', limit: l });

    // Por porcentaje: avisa el umbral más alto que se cruzó; los de abajo quedan como ya avisados.
    const top = [95, 80].find((p) => l.used >= p);
    if (top) {
      for (const lower of [95, 80].filter((p) => p < top)) seen[`${win}:pct${lower}`] ??= now;
      if (on(`p${top}`) && once(`pct${top}`)) out.push({ kind: `p${top}`, limit: l });
    }
  }
  return out;
}

// Los avisos ya dados se guardan en disco: si el widget se reinicia en la misma ventana, no repite lo que ya avisó.
function loadSeen(file, now = Date.now()) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(o).filter(([, t]) => typeof t === 'number' && now - t < KEEP_MS));
  } catch {
    return {};
  }
}

function saveSeen(file, seen, now = Date.now()) {
  for (const k of Object.keys(seen)) if (now - seen[k] >= KEEP_MS) delete seen[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seen));
}

// Deja solo las clases de aviso conocidas, como booleanos: lo que llegue de la ventana no se guarda tal cual.
function cleanTypes(input) {
  return Object.fromEntries(TYPES.map((k) => [k, !(input && input[k] === false)]));
}

module.exports = { planAlerts, loadSeen, saveSeen, cleanTypes, windowId, TYPES };
