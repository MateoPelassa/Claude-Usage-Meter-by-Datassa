// Lee los registros locales de Claude Code para saber en qué anda cada sesión: cuáles están trabajando,
// cuáles quedaron cortadas por un tope de consumo y cuáles terminaron. Solo lee ~/.claude/projects; no modifica nada.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 64 * 1024;
const ACTIVE_MS = 6 * 3600e3; // ventana de "sesiones recientes"
const WORKING_MS = 2 * 60e3; // escribió hace menos de esto: está trabajando

function roots() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean).map((d) => path.join(d, 'projects'));
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Últimas entradas del registro (una por línea). La primera línea del trozo puede venir cortada y se descarta.
function tailEntries(file, size) {
  const length = Math.min(size, TAIL_BYTES);
  const lines = readChunk(file, size - length, length).split('\n');
  if (length < size) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Carpeta donde se abrió la sesión: es la que Claude Code usa para ubicarla al retomarla.
function headCwd(file, size) {
  const m = readChunk(file, 0, Math.min(size, HEAD_BYTES)).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

const findLast = (arr, fn) => {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return arr[i];
  return null;
};

// Resume una sesión a partir del final de su registro.
function describe(file, st, sub, now, maxAgeMs) {
  const entries = tailEntries(file, st.size);
  const lastAssistant = findLast(entries, (e) => e.type === 'assistant');
  const lastMsg = findLast(entries, (e) => e.type === 'assistant' || e.type === 'user');
  // Cortada por tope: la última respuesta de Claude fue ese error. Se mira solo "assistant" porque después
  // del corte pueden quedar comandos locales (/compact) que no retoman el trabajo.
  // La antigüedad se mide por la fecha del error, no del archivo: un /compact posterior toca el archivo
  // y haría pasar por reciente un corte de hace semanas.
  const errorAt = lastAssistant?.timestamp ? Date.parse(lastAssistant.timestamp) : st.mtimeMs;
  const limited = !!lastAssistant && !!lastAssistant.isApiErrorMessage && (lastAssistant.error === 'rate_limit' || lastAssistant.apiErrorStatus === 429)
    && now - errorAt <= maxAgeMs;
  const cwd = headCwd(file, st.size) || lastMsg?.cwd || null;
  const title = findLast(entries, (e) => e.type === 'custom-title')?.customTitle || findLast(entries, (e) => e.type === 'ai-title')?.aiTitle || null;
  const activity = Math.max(st.mtimeMs, sub.latest);

  // Qué estaba pasando en el último mensaje, para interpretar el silencio.
  let turn = 'done';
  if (lastMsg?.type === 'user') turn = 'thinking';
  else if (lastMsg?.message?.stop_reason === 'tool_use') turn = 'tool';

  let status;
  if (limited) status = 'waiting'; // espera el reinicio del límite
  else if (now - activity <= WORKING_MS) status = 'working';
  else if (turn !== 'done') status = 'stalled'; // quedó a mitad de un paso: comando largo o espera una aprobación
  else status = 'done';

  const reset = lastAssistant?.quotaLimits?.resetsAt;
  return {
    id: lastMsg?.sessionId || path.basename(file, '.jsonl'),
    file,
    cwd,
    name: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
    title,
    mtime: st.mtimeMs,
    activity,
    status,
    subagents: sub.active,
    limitType: limited ? lastAssistant.quotaLimits?.rateLimitType || null : null,
    limitResetsAt: limited && reset ? reset * 1000 : null,
  };
}

// Los subagentes escriben en sus propios archivos mientras la sesión principal espera.
function subagentActivity(dir, id, now) {
  const out = { latest: 0, active: 0 };
  try {
    const sub = path.join(dir, id, 'subagents');
    for (const s of fs.readdirSync(sub)) {
      const m = fs.statSync(path.join(sub, s)).mtimeMs;
      out.latest = Math.max(out.latest, m);
      if (now - m <= WORKING_MS) out.active++;
    }
  } catch {}
  return out;
}

// Devuelve:
//   sessions      sesiones con actividad en las últimas 6 horas, la más reciente primero
//   pending       sesiones cortadas por un tope dentro de maxAgeMs (las que se pueden reintentar)
//   lastActivity  momento de la última escritura en cualquier sesión
// dirs permite apuntar a otra carpeta de registros (lo usan las pruebas).
function scan({ maxAgeMs = 24 * 3600e3, now = Date.now(), dirs = roots() } = {}) {
  const sessions = [];
  const pending = [];
  let lastActivity = 0;
  for (const root of dirs) {
    let projects = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
    for (const p of projects) {
      const dir = path.join(root, p.name);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch {}
      for (const f of files) {
        const file = path.join(dir, f);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        lastActivity = Math.max(lastActivity, st.mtimeMs);
        const age = now - st.mtimeMs;
        if (age > Math.max(maxAgeMs, ACTIVE_MS)) continue;
        const sub = age <= ACTIVE_MS ? subagentActivity(dir, f.slice(0, -6), now) : { latest: 0, active: 0 };
        lastActivity = Math.max(lastActivity, sub.latest);
        let s;
        try { s = describe(file, st, sub, now, maxAgeMs); } catch { continue; }
        // Las cortadas por tope se listan siempre; el resto, solo si tuvo actividad reciente.
        if (s.status === 'waiting' || now - s.activity <= ACTIVE_MS) sessions.push(s);
        if (s.status === 'waiting') pending.push(s);
      }
    }
  }
  sessions.sort((a, b) => b.activity - a.activity);
  pending.sort((a, b) => a.mtime - b.mtime);
  return { sessions, pending, lastActivity };
}

module.exports = { scan };
