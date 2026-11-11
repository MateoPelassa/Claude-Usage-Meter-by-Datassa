// Automatización opcional: retomar cada 20 minutos las sesiones de Claude Code que quedaron cortadas por un tope,
// y apagar la PC cuando ya no quede nada inconcluso. Las dos cosas arrancan apagadas y se activan desde el widget.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('./sessions');

const TICK_MS = 60e3;
const MAX_ATTEMPTS = 6; // una sesión que falla 6 veces seguidas se deja de reintentar
const SHUTDOWN_DELAY_S = 60; // margen para cancelar antes de que Windows apague

// Decide si ya se puede apagar la PC. Se evalúa una vez por minuto mientras "Apagar al terminar" está activo.
// ctx:
//   pending        sesiones cortadas por un tope que todavía se pueden reintentar
//   gaveUp         sesiones que se dejaron de reintentar tras 6 fallos
//   running        true si el widget está retomando una sesión en este momento
//   idleMinutes    minutos desde que cualquier sesión de Claude Code escribió algo por última vez
//   idleLimitMinutes  minutos de silencio que el usuario pide antes de apagar (opciones del widget)
//   armedMinutes   minutos desde que se activó el botón
//   retryEnabled   true si "Reintentar" está activo
//   limitReached   true si el límite de 5 horas o el semanal está agotado
function shouldShutdown(ctx) {
  if (ctx.armedMinutes < 2) return false; // margen para arrepentirse apenas se toca el botón
  if (ctx.running || ctx.pending > 0) return false; // queda algo cortado por retomar (las que fallaron 6 veces no cuentan)
  // Un comando largo puede pasar varios minutos sin escribir nada: se espera un rato de silencio (configurable) antes de dar todo por terminado.
  return ctx.idleMinutes >= ctx.idleLimitMinutes;
}

function findClaude(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const name of ['claude.exe', 'claude.cmd']) {
    for (const d of dirs) {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// o: { cfg(), saveCfg(patch), getUsage(), refreshUsage(), notify(title, body), onChange(estado), t(), logFile, dryRun, demo }
// t() devuelve los textos en el idioma actual. Las notas de estado viajan como código ('blocked', 'noClaude')
// y la ventana las traduce, así un cambio de idioma no deja textos viejos.
function createAutomation(o) {
  const st = { retry: !!o.cfg().autoRetry, shutdown: false, pending: [], gaveUp: 0, running: null, lastRetryAt: 0, shutdownAt: null, armedAt: null, note: '' };
  const attempts = new Map();
  let lastActivity = 0;
  let sessions = [];
  let busy = false;

  const log = (msg) => {
    try { fs.appendFileSync(o.logFile, `${new Date().toISOString()} ${msg}\n`); } catch {}
  };
  const full = (l) => Math.round(l.used) >= 100;
  const limits = () => o.getUsage()?.limits || [];
  const limitReached = () => limits().some((l) => l.primary && full(l));
  // No tiene sentido gastar un intento si se sabe que el tope sigue puesto.
  const blocked = (p) => limitReached() || limits().some((l) => l.key === p.limitType && full(l));

  // Los dos tiempos se eligen en las opciones del widget y se leen en cada vuelta, así un cambio rige enseguida.
  const retryMinutes = () => o.cfg().retryMinutes || 20;
  const idleLimitMinutes = () => o.cfg().shutdownIdleMinutes || 10;
  const nextRetryAt = () => (st.lastRetryAt ? st.lastRetryAt + retryMinutes() * 60e3 : 0);

  function snapshot() {
    return {
      retry: st.retry, shutdown: st.shutdown, running: st.running, nextRetryAt: nextRetryAt(), retryMinutes: retryMinutes(), shutdownAt: st.shutdownAt, note: st.note,
      gaveUp: st.gaveUp, pending: st.pending.map((p) => ({ id: p.id, name: p.title || p.name })),
      // Para el panel Avanzado: en qué anda cada sesión reciente.
      sessions: sessions.slice(0, 12).map((s) => ({ id: s.id, name: s.name, title: s.title, status: s.status, activity: s.activity, subagents: s.subagents, limitResetsAt: s.limitResetsAt })),
    };
  }
  const emit = () => o.onChange(snapshot());

  function rescan() {
    if (o.demo) {
      const now = Date.now();
      const demo = (id, name, title, status, ago, extra = {}) => ({ id, name, title, status, activity: now - ago, subagents: 0, limitResetsAt: null, cwd: null, ...extra });
      const titles = o.t().demoSessions;
      sessions = [
        demo('demo-0', 'website', titles[0], 'working', 20e3, { subagents: 3 }),
        demo('demo-1', 'finance-app', titles[1], 'waiting', 50 * 60e3, { limitResetsAt: now + 49 * 60e3 }),
        demo('demo-2', 'erp', titles[2], 'waiting', 70 * 60e3, { limitResetsAt: now + 49 * 60e3 }),
        demo('demo-3', 'chat-bot', titles[3], 'stalled', 14 * 60e3),
        demo('demo-4', 'transcriber', titles[4], 'done', 95 * 60e3),
      ];
      st.pending = sessions.filter((s) => s.status === 'waiting');
      lastActivity = now - 20e3;
      return;
    }
    const found = scan({ maxAgeMs: (o.cfg().retryMaxAgeHours || 24) * 3600e3 });
    sessions = found.sessions;
    lastActivity = found.lastActivity;
    st.pending = found.pending.filter((p) => (attempts.get(p.id) || 0) < MAX_ATTEMPTS);
    st.gaveUp = found.pending.length - st.pending.length;
  }

  function runOne(p) {
    return new Promise((resolve) => {
      const bin = findClaude(o.cfg().claudePath);
      if (!bin) { st.note = 'noClaude'; log('sin comando claude'); return resolve(); }
      if (!p.cwd || !fs.existsSync(p.cwd)) { attempts.set(p.id, MAX_ATTEMPTS); log(`${p.id} carpeta inexistente: ${p.cwd}`); return resolve(); }
      const args = ['-p', o.cfg().retryPrompt || o.t().resumePrompt, '--resume', p.id, ...(o.cfg().retryArgs || [])];
      const cmd = bin.endsWith('.cmd') ? 'cmd.exe' : bin;
      const child = spawn(cmd, bin.endsWith('.cmd') ? ['/c', bin, ...args] : args, { cwd: p.cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
      child.on('error', (e) => { log(`${p.id} no arrancó: ${e.message}`); resolve(); });
      child.on('close', (code) => { log(`${p.id} (${p.name}) terminó con código ${code}${err ? ` · ${err.trim()}` : ''}`); resolve(); });
    });
  }

  async function runQueue(queue) {
    for (const p of queue) {
      if (!st.retry) break;
      if (blocked(p)) { st.note = 'blocked'; continue; }
      attempts.set(p.id, (attempts.get(p.id) || 0) + 1);
      st.running = p.title || p.name;
      st.note = '';
      emit();
      log(`retomando ${p.id} (${p.name}), intento ${attempts.get(p.id)}`);
      if (!o.dryRun) await runOne(p);
      await o.refreshUsage().catch(() => {});
    }
    st.running = null;
    tick();
  }

  function scheduleShutdown() {
    st.shutdown = false;
    st.shutdownAt = Date.now() + SHUTDOWN_DELAY_S * 1000;
    log('apagado programado');
    o.notify(o.t().nShutdown, o.t().nShutdownBody);
    // /f cierra los programas abiertos sin preguntar; /t deja el margen para cancelar con "shutdown /a".
    if (!o.dryRun) execFile('shutdown', ['/s', '/f', '/t', String(SHUTDOWN_DELAY_S), '/c', o.t().shutdownMsg], (e) => e && log(`shutdown falló: ${e.message}`));
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      rescan();
      if (st.retry && !st.running && st.pending.length && now >= nextRetryAt()) {
        st.lastRetryAt = now;
        await o.refreshUsage().catch(() => {});
        st.running = st.pending[0].title || st.pending[0].name;
        runQueue(st.pending.slice());
      }
      if (st.shutdown && !st.shutdownAt) {
        const ctx = {
          pending: st.pending.length, gaveUp: st.gaveUp, running: !!st.running,
          idleMinutes: lastActivity ? (now - lastActivity) / 60e3 : Infinity,
          idleLimitMinutes: idleLimitMinutes(),
          armedMinutes: (now - st.armedAt) / 60e3,
          retryEnabled: st.retry, limitReached: limitReached(),
        };
        if (shouldShutdown(ctx)) scheduleShutdown();
      }
    } catch (e) {
      log(`error: ${e.message}`);
    } finally {
      busy = false;
      emit();
    }
  }

  function set(patch) {
    if ('retry' in patch) {
      st.retry = !!patch.retry;
      st.lastRetryAt = 0; // al activarlo prueba enseguida
      st.note = '';
      o.saveCfg({ autoRetry: st.retry });
    }
    // El apagado nunca se guarda en disco: si quedara activo, la PC se apagaría sola al volver a prenderla.
    if ('shutdown' in patch) {
      st.shutdown = !!patch.shutdown;
      st.armedAt = st.shutdown ? Date.now() : null;
    }
    tick();
    return snapshot();
  }

  function cancelShutdown() {
    if (st.shutdownAt && !o.dryRun) execFile('shutdown', ['/a'], () => {});
    st.shutdownAt = null;
    st.shutdown = false;
    log('apagado cancelado');
    emit();
    return snapshot();
  }

  function start() {
    tick();
    setInterval(tick, TICK_MS);
  }

  // Relee los registros en el momento (al abrir el panel Avanzado), sin esperar la próxima vuelta.
  function scanNow() {
    try { rescan(); } catch (e) { log(`error: ${e.message}`); }
    return snapshot();
  }

  return { start, set, cancelShutdown, snapshot, emit, scanNow };
}

module.exports = { createAutomation, shouldShutdown };
