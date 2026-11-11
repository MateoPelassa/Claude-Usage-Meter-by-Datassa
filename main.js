const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, screen, nativeImage, powerMonitor, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchUsage, fetchUsageWeb, demoUsage, SessionError } = require('./src/usage');
const history = require('./src/history');
const i18n = require('./src/i18n');
const { createAutomation } = require('./src/automation');

const DEMO_ARG = process.argv.find((a) => a === '--demo' || a.startsWith('--demo='));
const DEMO = !!DEMO_ARG;
const CAPTURE = process.argv.find((a) => a.startsWith('--capture='))?.slice(10);
// --lang=es|en fuerza el idioma sin tocar la configuración (útil para la demo y las capturas).
const LANG_ARG = process.argv.find((a) => a.startsWith('--lang='))?.slice(7);
const ICON = path.join(__dirname, 'assets', 'icon.png');
const APP_ID = 'com.datassa.medidorusoclaude';

if (!CAPTURE && !app.requestSingleInstanceLock()) app.quit();

// ---------------- Configuración ----------------

const DEFAULTS = { pos: null, expanded: false, opacity: 0.94, scale: 1, alerts: true, launchAtLogin: true, refreshMinutes: 3, retryMinutes: 20, shutdownIdleMinutes: 10, lang: 'auto' };
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const historyPath = () => path.join(app.getPath('userData'), 'history.json');

// El widget se llamaba "Claude Limits": si existe la configuración de entonces y todavía no hay una nueva, se copia.
function migrateOldData() {
  if (CAPTURE || fs.existsSync(cfgPath())) return;
  for (const old of ['Claude Limits', 'claude-limits-widget']) {
    const dir = path.join(app.getPath('appData'), old);
    if (!fs.existsSync(path.join(dir, 'config.json'))) continue;
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      for (const f of ['config.json', 'history.json']) {
        if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(app.getPath('userData'), f));
      }
    } catch {}
    return;
  }
}

let cfg = null;
function settings() {
  if (!cfg) {
    migrateOldData();
    try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; }
  }
  return cfg;
}
function saveSettings(patch) {
  Object.assign(settings(), patch);
  if (CAPTURE) return cfg;
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------------- Idioma ----------------

let texts = null;
const currentLang = () => i18n.resolve(LANG_ARG || settings().lang, app.getLocale());
// Textos en el idioma actual. Se recalculan cuando el usuario cambia el idioma en las opciones.
function T() {
  if (!texts || texts.lang !== currentLang()) texts = i18n.create(currentLang());
  return texts;
}
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---------------- Ventana ----------------

let win = null;
let tray = null;
let quitting = false;
let last = null;
const alerted = new Set();

function defaultPos() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - 360, y: workArea.y + workArea.height - 70 };
}

function createWindow() {
  let pos = settings().pos || defaultPos();
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) => pos.x >= w.x - 20 && pos.x < w.x + w.width - 60 && pos.y >= w.y - 10 && pos.y < w.y + w.height - 30);
  if (!onScreen) pos = defaultPos();

  win = new BrowserWindow({
    x: pos.x, y: pos.y, width: 300, height: 48,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
    show: false, focusable: true, alwaysOnTop: true, title: T().appName, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings().scale));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', () => {
    const b = win.getBounds();
    saveSettings({ pos: { x: b.x, y: b.y } });
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (CAPTURE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.CAPTURE_JS) {
        const out = await win.webContents.executeJavaScript(process.env.CAPTURE_JS).catch((e) => e.message);
        if (out !== undefined) console.log('CAPTURE_JS:', JSON.stringify(out));
        await new Promise((r) => setTimeout(r, 600));
      }
      fs.writeFileSync(CAPTURE, (await win.webContents.capturePage()).toPNG());
      quitting = true;
      app.quit();
    }, Number(process.env.CAPTURE_DELAY || 1500)));
  }
}

// ---------------- Inicio con Windows ----------------

// Corriendo desde el código (npm start) el ejecutable es Electron, así que hay que pasarle la carpeta del proyecto.
const loginOpts = () => (app.isPackaged ? {} : { path: process.execPath, args: [`"${app.getAppPath()}"`] });
function setLoginItem(open) {
  if (DEMO || CAPTURE) return;
  app.setLoginItemSettings({ openAtLogin: !!open, ...loginOpts() });
}
// Instalado, sigue la configuración. Desde el código solo vale lo que el usuario haya activado a mano en el menú:
// clonar el repo y probarlo no debe dejar nada registrado en el arranque de Windows.
const loginEnabled = () => (app.isPackaged ? !!settings().launchAtLogin : app.getLoginItemSettings(loginOpts()).openAtLogin);

function trayMenu() {
  const t = T();
  return Menu.buildFromTemplate([
    { label: t.trayShow, click: () => win.showInactive() },
    { label: t.trayRefresh, click: () => refresh() },
    { label: t.trayUsage, click: () => shell.openExternal('https://claude.ai/settings/usage') },
    { type: 'separator' },
    { label: t.trayAlerts, type: 'checkbox', checked: settings().alerts, click: (i) => saveSettings({ alerts: i.checked }) },
    { label: t.trayStartup, type: 'checkbox', checked: loginEnabled(), click: (i) => { saveSettings({ launchAtLogin: i.checked }); setLoginItem(i.checked); } },
    { label: t.trayResetPos, click: () => { const p = defaultPos(); win.setPosition(p.x, p.y); saveSettings({ pos: p }); } },
    { label: t.traySignIn, click: openLogin },
    { label: t.traySignOut, click: logout },
    { type: 'separator' },
    { label: t.trayQuit, click: () => { quitting = true; app.quit(); } },
  ]);
}

function trayTooltip() {
  const five = last?.data?.limits.find((l) => l.key === 'five_hour');
  const week = last?.data?.limits.find((l) => l.key === 'seven_day');
  tray?.setToolTip(last?.data ? T().trayTip(five ? Math.round(five.used) : '–', week ? Math.round(week.used) : '–') : T().appName);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setContextMenu(trayMenu());
  trayTooltip();
  tray.on('click', () => (win.isVisible() ? win.hide() : win.showInactive()));
}

// ---------------- Datos ----------------

const webSession = () => session.fromPartition('persist:claudeai');

let usingWebSession = false;

// Primero la sesión propia de claude.ai; si no hay, la de Claude Code guardada en disco.
async function loadUsage() {
  const cookies = await webSession().cookies.get({ url: 'https://claude.ai', name: 'sessionKey' });
  usingWebSession = cookies.length > 0;
  if (usingWebSession) return fetchUsageWeb(webSession());
  // Si falla la sesión de Claude Code, el error llega tal cual: el mensaje dice por qué (no hay sesión, o venció)
  // y ofrece las dos salidas, en vez de empujar directo al inicio de sesión dentro del widget.
  return fetchUsage();
}

let loginWin = null;
async function openLogin() {
  if (loginWin) return loginWin.focus();
  // Antes de abrir nada se explica qué se está por entregar: una ventana de login dentro de una app de terceros
  // es justo la forma de un robo de credenciales, así que el usuario tiene que poder decidir informado.
  const t = T();
  const { response } = await dialog.showMessageBox({
    type: 'info', title: t.appName, icon: ICON, noLink: true,
    message: t.loginNotice, detail: t.loginNoticeDetail,
    buttons: [t.loginContinue, t.cancel], defaultId: 1, cancelId: 1,
  });
  if (response !== 0 || loginWin) return;

  loginWin = new BrowserWindow({
    width: 480, height: 720, title: 'claude.ai', icon: ICON, autoHideMenuBar: true,
    webPreferences: { partition: 'persist:claudeai', contextIsolation: true, sandbox: true },
  });
  // La ventana no tiene barra de direcciones: el título muestra siempre el sitio real en el que está,
  // y la página no puede cambiarlo.
  const showAddress = () => {
    if (!loginWin) return;
    try {
      const u = new URL(loginWin.webContents.getURL());
      loginWin.setTitle(`${u.protocol === 'https:' ? '🔒 ' : '⚠ '}${u.host}${u.pathname === '/' ? '' : u.pathname} · ${T().loginTitle}`);
    } catch {}
  };
  loginWin.webContents.on('page-title-updated', (e) => { e.preventDefault(); showAddress(); });
  loginWin.loadURL('https://claude.ai/login');
  // Cuando sale de /login (ya entró a su cuenta), se cierra y se actualiza.
  const check = (_e, url) => {
    showAddress();
    const u = new URL(url);
    if (u.hostname === 'claude.ai' && !/^\/(login|magic-link|oauth|sso)/.test(u.pathname)) setTimeout(() => loginWin?.close(), 600);
  };
  loginWin.webContents.on('did-navigate', check);
  loginWin.webContents.on('did-navigate-in-page', check);
  loginWin.on('closed', () => { loginWin = null; refresh(); });
}

async function logout() {
  await webSession().clearStorageData();
  refresh();
}

let samples = null;
let resetTimer = null;

// Guarda la lectura en el historial y le calcula el pronóstico a cada límite.
function withForecast(data) {
  const now = Date.now();
  if (DEMO) {
    const demo = demoUsage(DEMO_ARG.split('=')[1]);
    samples = history.record(demo.samples, demo.data, now);
    data = demo.data;
  } else {
    samples = history.record(samples || history.load(historyPath()), data, now);
    if (!CAPTURE) history.save(historyPath(), samples);
  }
  for (const l of data.limits) l.forecast = history.forecast(l, samples, now);
  return data;
}

// Cuando una ventana se reinicia, se vuelve a consultar enseguida en vez de esperar el próximo ciclo.
function scheduleResetRefresh(data) {
  clearTimeout(resetTimer);
  const next = Math.min(...data.limits.map((l) => (l.resetsAt ? Date.parse(l.resetsAt) : Infinity)).filter((t) => t > Date.now()));
  if (Number.isFinite(next)) resetTimer = setTimeout(refresh, Math.min(next - Date.now() + 20e3, 2 ** 31 - 1));
}

async function refresh() {
  try {
    last = { ok: true, data: withForecast(DEMO ? null : await loadUsage()) };
    checkAlerts(last.data);
    scheduleResetRefresh(last.data);
  } catch (err) {
    // Si falla, se conservan los últimos datos buenos y se informa el error.
    // El botón de iniciar sesión se ofrece si falta la sesión, y también si la de Claude Code quedó bloqueada
    // por exceso de consultas: entrar por claude.ai es la única salida que no depende de esperar.
    const offerLogin = err instanceof SessionError || (!usingWebSession && err.code === 'tooMany');
    last = { ok: false, error: T().errorText(err), session: offerLogin, data: last?.data || null };
  }
  win?.webContents.send('usage', last);
  trayTooltip();
  return last;
}

function notify(title, body = '') {
  if (CAPTURE || !Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON }).show();
}

const wasFull = new Set();

function checkAlerts(data) {
  if (!settings().alerts || !Notification.isSupported()) return;
  const t = T();
  for (const l of data.limits) {
    const name = t.limitName(l.key).toLowerCase();
    const f = l.forecast || {};
    // Por ritmo: avisa antes de llegar, no cuando ya casi no queda.
    const soon = l.windowMs > 864e5 ? 6 * 3600e3 : 30 * 60e3;
    const fastKey = `${l.key}:${l.resetsAt}:fast`;
    if (f.state === 'fast' && f.hitAt - Date.now() < soon && !alerted.has(fastKey)) {
      alerted.add(fastKey);
      notify(t.nFast(name, hhmm(f.hitAt)), t.nFastBody(hhmm(f.end)));
    }
    // Ya se reinició un límite que estaba agotado.
    if (f.state === 'full') wasFull.add(l.key);
    else if (wasFull.delete(l.key)) notify(t.nReset(name), t.nResetBody);

    for (const pct of [95, 80]) {
      const key = `${l.key}:${l.resetsAt}:${pct}`;
      if (l.used >= pct && !alerted.has(key)) {
        alerted.add(key);
        if (pct === 80 && l.used >= 95) continue; // ya avisa el de 95
        const reset = l.resetsAt ? new Date(l.resetsAt) : null;
        notify(t.nPct(Math.round(l.used), name), reset ? t.nPctBody(`${t.wd[reset.getDay()]} ${hhmm(reset)}`) : '');
        break;
      }
    }
  }
}

// ---------------- IPC ----------------

ipcMain.handle('usage:get', () => last || refresh());
ipcMain.handle('usage:refresh', () => refresh());
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('lang:get', () => currentLang());
ipcMain.handle('settings:set', (_e, patch) => {
  // Los tiempos de la automatización se acotan acá: un valor roto no debe dejar reintentos sin pausa ni un apagado inmediato.
  const minutes = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  if ('retryMinutes' in patch) patch.retryMinutes = minutes(patch.retryMinutes, 5, 120, 20);
  if ('shutdownIdleMinutes' in patch) patch.shutdownIdleMinutes = minutes(patch.shutdownIdleMinutes, 5, 120, 10);
  if ('lang' in patch && !['auto', ...i18n.languages].includes(patch.lang)) patch.lang = 'auto';
  const s = saveSettings(patch);
  if ('retryMinutes' in patch || 'shutdownIdleMinutes' in patch) automation.emit();
  if ('scale' in patch) win.webContents.setZoomFactor(s.scale);
  if ('lang' in patch) {
    // El menú de la bandeja y el título se arman una sola vez: hay que rehacerlos en el idioma nuevo.
    tray?.setContextMenu(trayMenu());
    trayTooltip();
    win.setTitle(T().appName);
    automation.scanNow();
    automation.emit();
  }
  return s;
});
ipcMain.handle('win:size', (_e, { width, height }) => {
  // Crece hacia arriba si no entra debajo (el widget suele ir abajo a la derecha).
  const b = win.getBounds();
  const { workArea: w } = screen.getDisplayMatching(b);
  width = Math.round(width);
  height = Math.round(height);
  let x = b.x;
  let y = b.y;
  const anchorBottom = b.y + b.height > w.y + w.height * 0.5;
  if (anchorBottom) y = b.y + b.height - height;
  y = Math.max(w.y, Math.min(y, w.y + w.height - height));
  x = Math.max(w.x, Math.min(x, w.x + w.width - width));
  win.setBounds({ x, y, width, height });
});
ipcMain.handle('open:usage', () => shell.openExternal('https://claude.ai/settings/usage'));

// Enlaces del autor. La ventana solo manda la clave: las direcciones viven acá y no se puede abrir ninguna otra.
// Un enlace vacío no se muestra en el widget.
const LINKS = {
  web: 'https://datassa.com.ar',
  linkedin: '',
};
ipcMain.handle('links:get', () => Object.keys(LINKS).filter((k) => LINKS[k]));
ipcMain.handle('links:open', (_e, key) => { if (Object.hasOwn(LINKS, key) && LINKS[key]) shell.openExternal(LINKS[key]); });
ipcMain.handle('app:hide', () => win.hide());
ipcMain.handle('auth:login', () => openLogin());

// ---------------- Automatización ----------------

const automation = createAutomation({
  cfg: settings,
  saveCfg: saveSettings,
  getUsage: () => last?.data || null,
  refreshUsage: () => refresh(),
  notify,
  t: T,
  onChange: (state) => win && !win.isDestroyed() && win.webContents.send('auto', state),
  logFile: path.join(app.getPath('userData'), 'automation.log'),
  // En demo y en capturas nunca se lanza Claude ni se apaga la PC.
  dryRun: DEMO || !!CAPTURE,
  demo: DEMO,
});
ipcMain.handle('auto:get', () => automation.snapshot());
ipcMain.handle('auto:scan', () => automation.scanNow());
ipcMain.handle('auto:set', (_e, patch) => automation.set(patch));
ipcMain.handle('auto:cancel-shutdown', () => automation.cancelShutdown());

// ---------------- Arranque ----------------

app.on('second-instance', () => win?.showInactive());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  createWindow();
  if (!CAPTURE) createTray();
  if (app.isPackaged) setLoginItem(settings().launchAtLogin);
  refresh();
  automation.start();
  setInterval(refresh, settings().refreshMinutes * 60e3);
  // Windows a veces baja ventanas "siempre visibles" cuando otra toma el primer plano; se reafirma cada tanto.
  setInterval(() => win && !win.isDestroyed() && win.setAlwaysOnTop(true, 'screen-saver'), 15e3);
  powerMonitor.on('resume', () => setTimeout(refresh, 5000));
  powerMonitor.on('unlock-screen', () => refresh());
});
