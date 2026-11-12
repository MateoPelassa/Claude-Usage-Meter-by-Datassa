'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

// Textos en el idioma elegido (src/i18n.js). Se reemplaza al cambiar el idioma en las opciones.
let T = window.I18N.create('es');

// Logo propio: un medidor de aguja.
const GAUGE = '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 15l3.6-5.2"/><circle cx="12" cy="15" r="1.4"/>';

const ICON = {
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  retry: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24">${ICON[n]}</svg>`;

let state = {
  usage: null, auto: null, links: [], showAdvanced: false, expanded: false, loading: false, showSettings: false,
  scale: 1, opacity: 0.94, showUsed: false, retryMinutes: 20, shutdownIdleMinutes: 10,
  alerts: true, alertTypes: {}, alertSilent: false,
  shutdownAck: false, confirmShutdown: false,
};

// ---------------- Cálculos ----------------

const left = (l) => Math.min(100, Math.max(0, 100 - l.used));
const fc = (l) => l.forecast || { state: 'ok' };
// Qué número y qué barra se muestran: lo consumido (como en claude.ai) o lo disponible. Se elige en las opciones.
const shown = (l) => (state.showUsed ? 100 - left(l) : left(l));
const shownWord = () => (state.showUsed ? T.used : T.available);
const otherText = (l) => `${Math.round(state.showUsed ? left(l) : 100 - left(l))}% ${state.showUsed ? T.available : T.used}`;

// Color de la barra: por lo que queda y por el ritmo, lo que sea más grave.
function tone(l) {
  const s = fc(l).state;
  if (s === 'full' || left(l) <= 10) return 'danger';
  if (s === 'fast' || left(l) <= 25) return 'warn';
  return '';
}

function fmtUntil(ms) {
  const min = Math.max(1, Math.round(ms / 60e3));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24 ? `${h % 24} h` : ''}`.trim();
}

function fmtWhen(date, now = new Date()) {
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return time;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `${T.tomorrow} ${time}`;
  return `${T.wd[date.getDay()]} ${time}`;
}

// La frase que resume un límite. El pronóstico (l.forecast) lo calcula el proceso principal con el historial de lecturas.
function statusOf(l, now = Date.now()) {
  const f = fc(l);
  const reset = l.resetsAt ? new Date(l.resetsAt) : null;
  const future = reset && reset > now;
  const right = future ? T.resets(fmtWhen(reset)) : '';
  const hint = future ? T.resetsIn(fmtUntil(reset - now)) : '';
  if (f.state === 'full') {
    const since = f.fullSince ? fmtUntil(now - f.fullSince) : '';
    return { cls: 'danger', text: T.full(since, future ? fmtUntil(reset - now) : ''), right: future ? fmtWhen(reset) : '', hint };
  }
  if (f.state === 'idle') return { cls: 'muted', text: T.idle, right, hint };
  if (f.state === 'fast' && f.hitAt > now) {
    return {
      cls: f.hitAt - now < 3600e3 ? 'danger' : 'warn',
      text: T.fast(fmtWhen(new Date(f.hitAt))),
      right,
      hint: T.beforeReset(f.basis === 'recent' ? T.basisRecent : T.basisAverage, fmtUntil(f.end - f.hitAt)),
    };
  }
  return { cls: 'ok', text: T.ok, right, hint };
}

// La barra acompaña al número: se llena con lo consumido o se vacía como una batería.
function barHtml(l, big = false) {
  return `<div class="bar ${big ? 'big' : ''}"><div class="fill ${tone(l)}" style="width:${shown(l)}%"></div></div>`;
}

// ---------------- Render ----------------

function renderPill() {
  const u = state.usage?.data;
  const items = $('#pillItems');
  $('#pill').classList.toggle('error', !!(state.usage && !state.usage.ok));
  $('#pillLogo').title = `${T.appName} · ${T.tipDrag}`;
  items.title = T.tipDetail;
  $('#expandBtn').title = T.tipDetail;
  if (!u) {
    items.innerHTML = `<div class="pill-item"><div class="pill-top"><span class="k">${esc(state.usage?.error ? T.noData : T.loading)}</span></div></div>`;
    return;
  }
  const show = u.limits.filter((l) => l.primary).slice(0, 2);
  items.innerHTML = show.map((l) => {
    const s = statusOf(l);
    const reset = l.resetsAt ? new Date(l.resetsAt) : null;
    let value = `${Math.round(shown(l))}%`;
    if (fc(l).state === 'full' && reset && reset > Date.now()) {
      const when = fmtWhen(reset);
      value = when.length > 5 ? when : T.backAt(when);
    }
    const name = T.limitName(l.key);
    return `
    <div class="pill-item" title="${esc(name)} · ${Math.round(shown(l))}% ${shownWord()} · ${esc(s.text)}">
      <div class="pill-top"><span class="k">${l.key === 'five_hour' ? T.fiveHourShort : esc(name)}</span><span class="v ${tone(l)}">${esc(value)}</span></div>
      ${barHtml(l)}
    </div>`;
  }).join('');
}

function autoHtml() {
  const a = state.auto;
  if (!a) return '';
  const n = a.pending.length;
  const names = a.pending.map((p) => p.name).join(', ');
  let status;
  if (a.shutdownAt) {
    const t = new Date(a.shutdownAt);
    status = `<div class="auto-warn"><span>${esc(T.shutdownAt(`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`))}</span><button data-action="cancel-shutdown">${T.cancel}</button></div>`;
  } else if (state.confirmShutdown) {
    // La primera vez se pide confirmación: el apagado cierra todo sin guardar.
    status = `<div class="auto-warn"><span>${esc(T.confirmShutdown)}</span><span class="btns"><button class="ghost" data-action="confirm-shutdown-no">${T.cancel}</button><button data-action="confirm-shutdown-yes">${T.enable}</button></span></div>`;
  } else {
    const parts = [n ? T.pendingCount(n) : T.nothingPending];
    if (a.running) parts.push(T.resuming(a.running));
    else if (a.retry && n && a.nextRetryAt > Date.now()) parts.push(T.nextTry(fmtWhen(new Date(a.nextRetryAt))));
    if (a.note) parts.push(T.notes[a.note] || a.note);
    if (a.gaveUp) parts.push(T.gaveUp(a.gaveUp));
    if (a.shutdown) parts.push(T.armed);
    status = `<div class="auto-status" title="${esc(names)}">${esc(parts.join(' · '))}</div>`;
  }
  return `
    <div class="auto">
      <div class="auto-btns">
        <button class="chip ${a.retry ? 'on' : ''}" data-action="toggle-retry" title="${esc(T.retryTip(a.retryMinutes))}">${icon('retry')}${esc(T.retryChip(a.retryMinutes))}</button>
        <button class="chip power ${a.shutdown ? 'on' : ''}" data-action="toggle-shutdown" title="${esc(T.shutdownTip)}">${icon('power')}${esc(T.shutdownChip)}</button>
      </div>
      ${status}
    </div>`;
}

// Panel Avanzado: en qué anda cada sesión de Claude Code y a qué ritmo se viene consumiendo.
const STATUS_ORDER = { working: 0, waiting: 1, stalled: 2, done: 3 };
function sessionRow(s, now) {
  const ago = fmtUntil(now - s.activity);
  let text;
  let hint = '';
  if (s.status === 'working') {
    text = s.subagents ? `${T.sWorking} · ${T.sSubagents(s.subagents)}` : T.sWorking;
  } else if (s.status === 'waiting') {
    text = s.limitResetsAt > now ? T.sWaitsReset(fmtWhen(new Date(s.limitResetsAt))) : T.sCut;
    hint = T.sCutTip(ago);
  } else if (s.status === 'stalled') {
    text = T.sStalled(ago);
    hint = T.sStalledTip;
  } else {
    text = T.sDone(ago);
  }
  return `<div class="sess" title="${esc([s.name, hint].filter(Boolean).join(' · '))}"><i class="dot ${s.status}"></i><span class="t">${esc(s.title || s.name)}</span><span class="s ${s.status}">${esc(text)}</span></div>`;
}

function advancedHtml() {
  if (!state.showAdvanced) return '';
  const now = Date.now();
  const list = [...(state.auto?.sessions || [])].sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.activity - a.activity));
  const count = (st) => list.filter((s) => s.status === st).length;
  const summary = [[count('working'), T.sumWorking], [count('waiting'), T.sumWaiting], [count('stalled'), T.sumStalled]].filter(([n]) => n).map(([n, f]) => f(n)).join(' · ');

  // Ritmo de consumo, según el mismo cálculo que usa el pronóstico.
  const pace = [];
  for (const l of state.usage?.data?.limits.filter((x) => x.primary) || []) {
    const f = fc(l);
    if (f.rate == null || !f.end) continue;
    const weekly = l.windowMs > 864e5;
    const per = weekly ? f.rate * 864e5 : f.rate * 3600e3;
    let text = T.pace(per.toFixed(per < 10 ? 1 : 0), weekly);
    // Cuánto se puede gastar por día para llegar justo al reinicio semanal.
    if (weekly && f.end > now) text += T.budget((left(l) / Math.max(1, (f.end - now) / 864e5)).toFixed(0));
    pace.push(`<div class="sess" title="${esc(f.basis === 'recent' ? T.paceRecentTip : T.paceAverageTip)}"><span class="t muted">${esc(T.paceLabel(T.limitName(l.key).toLowerCase()))}</span><span class="s">${esc(text)}</span></div>`);
  }

  return `
    <div class="adv">
      <div class="adv-head"><span>${T.sessions}</span><span>${esc(summary || T.last6h)}</span></div>
      ${list.length ? list.map((s) => sessionRow(s, now)).join('') : `<div class="sess"><span class="t muted">${T.noSessions}</span></div>`}
      ${pace.length ? `<div class="adv-head"><span>${T.consumption}</span><span></span></div>${pace.join('')}` : ''}
    </div>`;
}

function settingsHtml() {
  if (!state.showSettings) return '';
  const seg = (on, action, label, tip = '') => `<button class="${on ? 'on' : ''}" data-action="${action}" title="${esc(tip)}">${esc(label)}</button>`;
  // Un interruptor por clase de aviso: encendido salvo que se haya apagado a propósito.
  const chip = (k, label, tip) => `<button class="chip-sm ${state.alertTypes[k] !== false ? 'on' : ''}" data-alert="${k}" title="${esc(tip)}">${esc(label)}</button>`;
  return `
    <div class="settings">
      <div class="set seg-row"><span>${T.setBars}</span><div class="seg">
        ${seg(state.showUsed, 'show-used', T.setConsumed, T.setConsumedTip)}
        ${seg(!state.showUsed, 'show-left', T.setAvailable, T.setAvailableTip)}
      </div></div>
      <div class="set seg-row"><span>${T.setLanguage}</span><div class="seg">
        ${seg(T.lang === 'es', 'lang-es', 'Español')}
        ${seg(T.lang === 'en', 'lang-en', 'English')}
      </div></div>
      <div class="set seg-row" title="${esc(T.alertsTip)}"><span>${T.setAlerts}</span><div class="seg">
        ${seg(state.alerts, 'alerts-on', T.alertsOn)}
        ${seg(!state.alerts, 'alerts-off', T.alertsOff)}
      </div></div>
      <div class="chips ${state.alerts ? '' : 'dim'}" aria-label="${esc(T.alertKinds)}">
        ${chip('p80', T.alertP80, T.alertP80Tip)}
        ${chip('p95', T.alertP95, T.alertP95Tip)}
        ${chip('pace', T.alertPace, T.alertPaceTip)}
        ${chip('reset', T.alertReset, T.alertResetTip)}
        <button class="chip-sm ${state.alertSilent ? '' : 'on'}" data-action="alert-sound" title="${esc(T.alertSoundTip)}">${T.alertSound}</button>
      </div>
      <label class="set"><span>${T.setSize}</span><input type="range" min="0.8" max="1.5" step="0.05" value="${state.scale}" data-set="scale"><b>${Math.round(state.scale * 100)}%</b></label>
      <label class="set"><span>${T.setOpacity}</span><input type="range" min="0.35" max="1" step="0.01" value="${state.opacity}" data-set="opacity"><b>${Math.round(state.opacity * 100)}%</b></label>
      <label class="set" title="${esc(T.setRetryTip)}"><span>${T.setRetry}</span><input type="range" min="5" max="120" step="5" value="${state.retryMinutes}" data-cfg="retryMinutes"><b>${state.retryMinutes} min</b></label>
      <label class="set" title="${esc(T.setIdleTip)}"><span>${T.setIdle}</span><input type="range" min="5" max="120" step="5" value="${state.shutdownIdleMinutes}" data-cfg="shutdownIdleMinutes"><b>${state.shutdownIdleMinutes} min</b></label>
    </div>`;
}

function renderPanel() {
  const panel = $('#panel');
  const u = state.usage?.data;
  const err = state.usage && !state.usage.ok ? state.usage.error : null;
  const updated = u?.fetchedAt ? Math.round((Date.now() - u.fetchedAt) / 60e3) : null;
  const sub = [u?.plan || 'Claude', updated == null ? '' : updated < 1 ? T.updatedNow : T.updatedAgo(updated), u?.demo ? 'DEMO' : ''].filter(Boolean).join(' · ');
  // Datos viejos: la última consulta falló o hace rato que no llega una nueva.
  const stale = !!u && (!!err || updated >= 10);

  let body = '';
  if (err) body += `<div class="alert">${esc(err)}${u ? `<br>${T.showingLast}` : ''}</div>`;
  if (state.usage?.session) body += `<button class="login-btn" data-action="login">${T.login}</button>`;
  if (u) {
    for (const l of u.limits.filter((x) => x.primary)) {
      const s = statusOf(l);
      body += `
        <div class="limit" title="${esc(s.hint)}">
          <div class="limit-top"><span class="limit-name">${esc(T.limitName(l.key))}</span><span class="limit-pct ${tone(l)}" title="${otherText(l)}">${Math.round(shown(l))}%<small>${shownWord()}</small></span></div>
          ${barHtml(l, true)}
          <div class="limit-status"><span class="${s.cls}">${esc(s.text)}</span><span>${esc(s.right)}</span></div>
        </div>`;
    }
    for (const l of u.limits.filter((x) => !x.primary)) {
      const resets = l.resetsAt ? ` · ${T.resetsLong(fmtWhen(new Date(l.resetsAt)))}` : '';
      body += `<div class="minor" title="${otherText(l)}${esc(resets)}"><span class="n">${esc(T.limitName(l.key))}</span>${barHtml(l)}<span class="p">${Math.round(shown(l))}%</span></div>`;
    }
    if (u.extra) {
      const credits = u.extra.used != null && u.extra.limit != null ? `${u.extra.used} / ${u.extra.limit}` : `${Math.round(u.extra.utilization || 0)}%`;
      body += `<div class="minor"><span class="n">${T.extra}</span><span></span><span class="p">${esc(credits)}</span></div>`;
    }
  }

  panel.innerHTML = `
    <div class="head drag">
      <div class="logo"><svg viewBox="0 0 24 24">${GAUGE}</svg></div>
      <div class="who"><div class="title">${esc(T.appName)}</div><div class="sub ${stale ? 'stale' : ''}">${esc(sub)}</div></div>
      <button class="icon-btn ${state.showSettings ? 'on' : ''}" data-action="toggle-settings" title="${esc(T.tipSettings)}" style="-webkit-app-region:no-drag">${icon('sliders')}</button>
      <button class="icon-btn ${state.loading ? 'spin' : ''}" data-action="refresh" title="${esc(T.tipRefresh)}" style="-webkit-app-region:no-drag">${icon('refresh')}</button>
      <button class="icon-btn" data-action="collapse" title="${esc(T.tipCollapse)}" style="-webkit-app-region:no-drag">${icon('down')}</button>
    </div>
    ${settingsHtml()}
    ${body}
    ${autoHtml()}
    ${advancedHtml()}
    <div class="foot">
      <span class="link ${state.showAdvanced ? 'on' : ''}" data-action="toggle-advanced" title="${esc(T.advancedTip)}">${T.advanced} ${state.showAdvanced ? '▴' : '▾'}</span>
      <span class="link" data-action="open-usage">${T.viewUsage}</span>
    </div>
    <div class="credit" title="${esc(T.unofficial)}">
      <span>${T.madeBy} <b>Datassa</b></span>
      ${state.links.includes('web') ? `<span class="link" data-link="web" title="datassa.com.ar">${T.web}</span>` : ''}
      ${state.links.includes('linkedin') ? '<span class="link" data-link="linkedin">LinkedIn</span>' : ''}
      <span class="note">${esc(T.unofficial)}</span>
    </div>`;
}

// Mientras se arrastra un control deslizante no se redibuja el panel: redibujar reemplaza el control
// que el mouse tiene agarrado y el arrastre queda colgado. Lo pendiente se dibuja al soltar.
let dragging = false;
let renderPending = false;
document.addEventListener('pointerdown', (e) => {
  if (e.target.matches?.('input[type=range]')) dragging = true;
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (renderPending) render();
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

function render() {
  if (dragging) { renderPending = true; return; }
  renderPending = false;
  document.documentElement.lang = T.lang;
  document.body.classList.toggle('expanded', state.expanded);
  $('#panel').classList.toggle('hidden', !state.expanded);
  renderPill();
  if (state.expanded) renderPanel();
  requestAnimationFrame(fit);
}

function fit() {
  // La ventana se mide en píxeles reales: el contenido está escalado por el zoom.
  const r = $('#root').getBoundingClientRect();
  window.api.size({ width: Math.ceil(r.width * state.scale), height: Math.ceil(r.height * state.scale) });
}

function applyLook() {
  document.documentElement.style.setProperty('--alpha', state.opacity);
}

let saveTimer;
async function setLook(patch, persist = true) {
  Object.assign(state, patch);
  applyLook();
  if ('scale' in patch) { await window.api.setSettings({ scale: state.scale }); requestAnimationFrame(fit); }
  clearTimeout(saveTimer);
  if (persist) saveTimer = setTimeout(() => window.api.setSettings({ opacity: state.opacity }), 250);
  document.querySelectorAll('[data-set]').forEach((el) => { el.nextElementSibling.textContent = `${Math.round(state[el.dataset.set] * 100)}%`; });
}

let cfgTimer;
document.addEventListener('input', (e) => {
  const k = e.target.dataset.set;
  // El tamaño se aplica al soltar: cambiarlo redimensiona la ventana y el control se correría debajo del puntero.
  if (k === 'scale') e.target.nextElementSibling.textContent = `${Math.round(Number(e.target.value) * 100)}%`;
  else if (k) setLook({ [k]: Number(e.target.value) });
  // Tiempos de la automatización: se guardan al soltar un momento el control.
  const c = e.target.dataset.cfg;
  if (c) {
    state[c] = Number(e.target.value);
    e.target.nextElementSibling.textContent = `${state[c]} min`;
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => window.api.setSettings({ retryMinutes: state.retryMinutes, shutdownIdleMinutes: state.shutdownIdleMinutes }), 250);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.set === 'scale') setLook({ scale: Number(e.target.value) });
});

// Ctrl + rueda: agrandar o achicar.
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const scale = Math.min(1.5, Math.max(0.8, Math.round((state.scale + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100));
  setLook({ scale });
}, { passive: false });

// ---------------- Acciones ----------------

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  render();
  state.usage = await window.api.refresh();
  state.loading = false;
  render();
}

function setExpanded(v) {
  state.expanded = v;
  window.api.setSettings({ expanded: v });
  render();
}

async function setAuto(patch) {
  state.auto = await window.api.setAuto(patch);
  render();
}

async function setLang(lang) {
  await window.api.setSettings({ lang });
  T = window.I18N.create(await window.api.getLang());
  // Los mensajes de error y los títulos de la demo vienen ya traducidos del proceso principal: se piden de nuevo.
  state.auto = await window.api.getAuto();
  render();
  refresh();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-link]')?.dataset.link;
  if (link) return window.api.openLink(link);
  const kind = e.target.closest('[data-alert]')?.dataset.alert;
  if (kind) {
    state.alertTypes = { ...state.alertTypes, [kind]: state.alertTypes[kind] === false };
    window.api.setSettings({ alertTypes: state.alertTypes });
    return render();
  }
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'refresh') return refresh();
  if (a === 'collapse') return setExpanded(false);
  if (a === 'open-usage') return window.api.openUsage();
  if (a === 'login') return window.api.login();
  if (a === 'toggle-settings') { state.showSettings = !state.showSettings; return render(); }
  if (a === 'show-used' || a === 'show-left') {
    state.showUsed = a === 'show-used';
    window.api.setSettings({ showUsed: state.showUsed });
    return render();
  }
  if (a === 'lang-es' || a === 'lang-en') return setLang(a.slice(5));
  if (a === 'alerts-on' || a === 'alerts-off') {
    state.alerts = a === 'alerts-on';
    window.api.setSettings({ alerts: state.alerts });
    return render();
  }
  if (a === 'alert-sound') {
    state.alertSilent = !state.alertSilent;
    window.api.setSettings({ alertSilent: state.alertSilent });
    return render();
  }
  if (a === 'toggle-advanced') {
    state.showAdvanced = !state.showAdvanced;
    render();
    // Al abrirlo se releen los registros para no mostrar un estado de hace un minuto.
    if (state.showAdvanced) window.api.scanAuto().then((s) => { state.auto = s; render(); });
    return;
  }
  if (a === 'toggle-retry') return setAuto({ retry: !state.auto?.retry });
  if (a === 'toggle-shutdown') {
    if (state.auto?.shutdown) return setAuto({ shutdown: false });
    if (state.shutdownAck) return setAuto({ shutdown: true });
    state.confirmShutdown = true;
    return render();
  }
  if (a === 'confirm-shutdown-no') { state.confirmShutdown = false; return render(); }
  if (a === 'confirm-shutdown-yes') {
    state.confirmShutdown = false;
    state.shutdownAck = true;
    window.api.setSettings({ shutdownAck: true });
    return setAuto({ shutdown: true });
  }
  if (a === 'cancel-shutdown') return window.api.cancelShutdown().then((s) => { state.auto = s; render(); });
  if (e.target.closest('#pillItems, #expandBtn')) setExpanded(true);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.expanded) setExpanded(false);
  if ((e.ctrlKey && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); refresh(); }
});

window.api.onUsage((u) => { state.usage = u; state.loading = false; render(); });
window.api.onAuto((a) => { state.auto = a; render(); });
// El interruptor de avisos también está en el menú de la bandeja: si cambia desde ahí, el panel se entera.
window.api.onSettings((s) => { state.alerts = !!s.alerts; render(); });

(async function init() {
  $('#logo').innerHTML = GAUGE;
  T = window.I18N.create(await window.api.getLang());
  const s = await window.api.getSettings();
  state.scale = s.scale || 1;
  state.opacity = s.opacity;
  state.showUsed = !!s.showUsed;
  state.shutdownAck = !!s.shutdownAck;
  state.alerts = s.alerts !== false;
  state.alertTypes = s.alertTypes || {};
  state.alertSilent = !!s.alertSilent;
  state.retryMinutes = s.retryMinutes || 20;
  state.shutdownIdleMinutes = s.shutdownIdleMinutes || 10;
  applyLook();
  state.expanded = !!s.expanded;
  state.usage = await window.api.get();
  state.auto = await window.api.getAuto();
  state.links = await window.api.getLinks();
  render();
  // Los "en X min" avanzan solos; con Avanzado abierto también se releen las sesiones.
  setInterval(() => {
    if (state.showAdvanced && state.expanded) window.api.scanAuto().then((x) => { state.auto = x; render(); });
    else render();
  }, 30e3);
})();
