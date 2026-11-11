// Genera assets/icon.png (256x256): un medidor de aguja sobre un cuadrado oscuro redondeado.
// El arco se pinta naranja hasta donde apunta la aguja y gris el resto, como una barra de consumo.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = 256, SS = 4;
const CX = 128, CY = 158; // eje de la aguja
const NEEDLE = -Math.PI * 0.32; // hacia dónde apunta (0 = derecha, -PI/2 = arriba)
const ORANGE = [217, 119, 87, 255], GREY = [92, 89, 84, 255], DARK = [32, 31, 34, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Distancia de un punto a un segmento.
function distSeg(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}
function sample(x, y) {
  if (!inRoundRect(x, y, 8, 8, 248, 248, 56)) return [0, 0, 0, 0];
  const dx = x - CX, dy = y - CY, r = Math.hypot(dx, dy);
  if (r < 17) return ORANGE; // eje
  if (distSeg(x, y, CX, CY, CX + 66 * Math.cos(NEEDLE), CY + 66 * Math.sin(NEEDLE)) < 8) return ORANGE; // aguja
  const a = Math.atan2(dy, dx);
  // Arco de 200 grados, abierto hacia abajo.
  const start = -Math.PI - 0.18, end = 0.18;
  const ang = a > end + 0.01 ? a - Math.PI * 2 : a;
  if (r > 78 && r < 100 && ang >= start && ang <= end) return ang <= NEEDLE ? ORANGE : GREY;
  return DARK;
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let acc = [0, 0, 0, 0];
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const p = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
    acc = acc.map((v, i) => v + (i < 3 ? p[i] * p[3] : p[3]));
  }
  const o = y * (S * 4 + 1) + 1 + x * 4;
  for (let i = 0; i < 3; i++) raw[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
  raw[o + 3] = Math.round(acc[3] / (SS * SS));
}
const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = T[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const h = Buffer.alloc(13); h.writeUInt32BE(S, 0); h.writeUInt32BE(S, 4); h[8] = 8; h[9] = 6;
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('icon ok');
