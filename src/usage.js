// Lee el uso de los límites de la suscripción de Claude con la sesión que ya tiene Claude Code en esta PC.
// El token solo se lee del archivo local y se envía únicamente a api.anthropic.com. Nunca se renueva desde acá
// (renovarlo invalidaría la sesión de Claude Code): si venció, se le pide al usuario que abra Claude Code.
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Los errores llevan un código en vez de un texto: el mensaje se arma después en el idioma del usuario (src/i18n.js).
class UsageError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}
// Falta iniciar sesión (o venció): el widget ofrece el botón para entrar.
class SessionError extends UsageError {}

function credentialPaths() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  return dirs.map((d) => path.join(d, '.credentials.json'));
}

function readSession() {
  for (const p of credentialPaths()) {
    try {
      const oauth = JSON.parse(fs.readFileSync(p, 'utf8')).claudeAiOauth;
      if (oauth?.accessToken) return oauth;
    } catch {}
  }
  throw new SessionError('noSession');
}

function planName(oauth) {
  const sub = (oauth.subscriptionType || '').toLowerCase();
  const tier = (oauth.rateLimitTier || '').toLowerCase();
  const base = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' }[sub] || (sub ? sub[0].toUpperCase() + sub.slice(1) : 'Claude');
  const mult = tier.match(/(\d+)x/);
  return mult ? `${base} ${mult[1]}x` : base;
}

// El nombre visible de cada límite lo pone el diccionario a partir de la clave; acá solo va lo que no depende del idioma.
function normalize(json) {
  const limits = [];
  for (const [key, v] of Object.entries(json || {})) {
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
    // Solo límites reconocibles; la API también trae campos internos con nombres en clave (ej. "iguana_necktie").
    if (!/^(five_hour|seven_day)(_|$)/.test(key)) continue;
    const weekly = key.startsWith('seven_day');
    limits.push({ key, primary: key === 'five_hour' || key === 'seven_day', windowMs: weekly ? 7 * 864e5 : 5 * 3600e3, used: v.utilization, resetsAt: v.resets_at || null });
  }
  // Primero 5 horas y semana; después los límites por modelo.
  limits.sort((a, b) => (b.primary - a.primary) || (a.key === 'five_hour' ? -1 : b.key === 'five_hour' ? 1 : 0));
  const extra = json?.extra_usage?.is_enabled ? {
    used: json.extra_usage.used_credits ?? null,
    limit: json.extra_usage.monthly_limit ?? null,
    utilization: json.extra_usage.utilization ?? null,
  } : null;
  return { limits, extra };
}

async function fetchUsage() {
  const oauth = readSession();
  // expiresAt viene en milisegundos; si parece estar en segundos se convierte.
  const exp = oauth.expiresAt ? (oauth.expiresAt < 1e12 ? oauth.expiresAt * 1000 : oauth.expiresAt) : null;
  // Con el token vencido ni se consulta: la API no contesta "vencido" sino "demasiadas consultas",
  // un error que no dice qué hacer y que empeora insistiendo.
  if (exp && exp < Date.now()) throw new SessionError('rejected', { exp });
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-usage-meter/1.0',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SessionError('rejected', { exp });
  }
  if (res.status === 429) throw new UsageError('tooMany');
  if (!res.ok) throw new UsageError('http', { status: res.status });
  const data = normalize(await res.json());
  return { plan: planName(oauth), ...data, fetchedAt: Date.now() };
}

// Datos de ejemplo para `npm run demo`, relativos a la hora actual. Con `--demo=full` el límite de 5 horas aparece agotado.
// Devuelve también un historial inventado para que el pronóstico tenga con qué calcular.
function demoUsage(variant = '') {
  const now = Date.now();
  const full = variant === 'full';
  const fiveEnd = now + (full ? 49 * 60e3 : 2.4 * 3600e3);
  const weekEnd = now + 2.3 * 864e5;
  const data = {
    plan: 'Max 20x',
    limits: [
      { key: 'five_hour', primary: true, windowMs: 5 * 3600e3, used: full ? 100 : 38, resetsAt: new Date(fiveEnd).toISOString() },
      { key: 'seven_day', primary: true, windowMs: 7 * 864e5, used: 61, resetsAt: new Date(weekEnd).toISOString() },
      { key: 'seven_day_opus', primary: false, windowMs: 7 * 864e5, used: 12, resetsAt: new Date(weekEnd).toISOString() },
    ],
    extra: null,
    fetchedAt: now,
    demo: true,
  };
  const sample = (ago, five, week) => ({ t: now - ago, l: { five_hour: [five, fiveEnd], seven_day: [week, weekEnd], seven_day_opus: [12, weekEnd] } });
  const samples = full
    ? [sample(20 * 3600e3, 0, 45), sample(130 * 60e3, 82, 60), sample(120 * 60e3, 100, 61)]
    : [sample(20 * 3600e3, 0, 45), sample(50 * 60e3, 30, 61)];
  return { data, samples };
}

// ---- Sesión propia de claude.ai (la misma que usa la página Configuración → Uso) ----

function planFromOrg(org) {
  const caps = org.capabilities || [];
  const tier = (org.rate_limit_tier || '').toLowerCase();
  const base = caps.includes('claude_max') ? 'Max' : caps.includes('claude_pro') ? 'Pro' : caps.includes('raven') ? 'Team' : 'Claude';
  const mult = tier.match(/(\d+)x/);
  return mult ? `${base} ${mult[1]}x` : base;
}

async function fetchUsageWeb(ses) {
  const get = async (url) => {
    const res = await ses.fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new SessionError('signIn');
    if (!res.ok) throw new UsageError('httpWeb', { status: res.status });
    return res.json();
  };
  const orgs = await get('https://claude.ai/api/organizations');
  const org = orgs.find((o) => (o.capabilities || []).some((c) => /claude_(max|pro)|raven/.test(c))) || orgs[0];
  if (!org) throw new SessionError('noOrg');
  const data = normalize(await get(`https://claude.ai/api/organizations/${org.uuid}/usage`));
  return { plan: planFromOrg(org), ...data, fetchedAt: Date.now() };
}

module.exports = { fetchUsage, fetchUsageWeb, demoUsage, SessionError, normalize };
