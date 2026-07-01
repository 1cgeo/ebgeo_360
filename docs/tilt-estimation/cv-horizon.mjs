#!/usr/bin/env node
// Protótipo: detecta horizonte em 360 equirretangular e ajusta senoide -> tilt (τ,α).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/diniz/OneDrive/Desktop/Desenvolvimento/ebgeo_360/package.json');
const sharp = require('sharp');

const W = 1536, H = 768;               // processamento (equirretangular 2:1)
const DEG_PER_PX = 180 / H;
const BAND = [0.18, 0.82];             // faixa vertical onde procurar horizonte

function solve3(A, b) { // resolve 3x3 (Gauss)
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

async function detectHorizon(file, label) {
  const { data, info } = await sharp(readFileSync(file)).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  // brilho por coluna + prefix sums; horizonte = split que melhor separa (claro em cima / escuro embaixo)
  const y0 = Math.floor(h * BAND[0]), y1 = Math.floor(h * BAND[1]);
  const hx = [], conf = [];
  for (let x = 0; x < w; x++) {
    // suaviza coluna (média móvel 5) e prefix sum
    const col = new Float64Array(h);
    for (let y = 0; y < h; y++) col[y] = data[y * w + x];
    const pref = new Float64Array(h + 1);
    for (let y = 0; y < h; y++) pref[y + 1] = pref[y] + col[y];
    let best = -1, bestY = -1;
    for (let y = y0; y <= y1; y++) {
      const above = pref[y] / y;                    // média 0..y-1
      const below = (pref[h] - pref[y]) / (h - y);   // média y..h-1
      const s = above - below;                       // sky(claro) - ground(escuro)
      if (s > best) { best = s; bestY = y; }
    }
    hx.push(bestY); conf.push(Math.max(0, best));
  }
  // normaliza confiança
  const cmax = Math.max(...conf) || 1; const wgt = conf.map(c => c / cmax);
  // ajuste robusto h(x)=c0 + A cosθ + B sinθ  (IRLS)
  const th = hx.map((_, x) => 2 * Math.PI * x / w);
  let W_ = wgt.slice(), c0 = h / 2, A = 0, B = 0;
  for (let it = 0; it < 8; it++) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (let x = 0; x < w; x++) {
      const f = [1, Math.cos(th[x]), Math.sin(th[x])], y = hx[x], ww = W_[x];
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) M[i][j] += ww * f[i] * f[j]; v[i] += ww * f[i] * y; }
    }
    [c0, A, B] = solve3(M, v);
    // resíduos -> pesos Tukey
    const res = hx.map((y, x) => y - (c0 + A * Math.cos(th[x]) + B * Math.sin(th[x])));
    const ares = res.map(Math.abs).sort((a, b) => a - b);
    const mad = (ares[ares.length >> 1] || 1) * 1.4826, s = Math.max(2, mad * 4);
    W_ = res.map((r, x) => wgt[x] * Math.exp(-(r * r) / (2 * s * s)));
  }
  const ampPx = Math.hypot(A, B);
  const tiltDeg = ampPx * DEG_PER_PX;
  const aziImg = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
  const c0offDeg = (c0 - h / 2) * DEG_PER_PX;
  // inliers
  const res = hx.map((y, x) => y - (c0 + A * Math.cos(th[x]) + B * Math.sin(th[x])));
  const inl = res.filter(r => Math.abs(r) < 8).length / w;

  // overlay p/ inspeção
  const step = 8;
  let pts = '';
  for (let x = 0; x < w; x += step) pts += `<circle cx="${x}" cy="${hx[x]}" r="1.5" fill="lime" opacity="0.7"/>`;
  let poly = '';
  for (let x = 0; x < w; x += 4) { const y = c0 + A * Math.cos(th[x]) + B * Math.sin(th[x]); poly += `${x},${y.toFixed(1)} `; }
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="cyan" stroke-width="1" stroke-dasharray="6 6" opacity="0.6"/>
    ${pts}
    <polyline points="${poly}" fill="none" stroke="red" stroke-width="2"/>
    <text x="10" y="24" fill="yellow" font-size="20">${label}  tilt=${tiltDeg.toFixed(1)}deg  azi=${aziImg.toFixed(0)}  inl=${(inl*100).toFixed(0)}%</text>
  </svg>`;
  const outPng = file.replace(/\.\w+$/, '') + '_horizon.png';
  await sharp(readFileSync(file)).resize(w, h, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPng);

  return { label, tiltDeg: +tiltDeg.toFixed(2), aziImg: +aziImg.toFixed(1), c0offDeg: +c0offDeg.toFixed(2), inlierPct: +(inl * 100).toFixed(0), A: +A.toFixed(2), B: +B.toFixed(2), outPng };
}

const arg = process.argv[2]; // caminho p/ JSON [{file,label}] ou o próprio JSON
const jobs = (arg && existsSync(arg)) ? JSON.parse(readFileSync(arg, 'utf8')) : JSON.parse(arg);
const out = [];
for (const j of jobs) out.push(await detectHorizon(j.file, j.label));
console.table(out.map(({ outPng, ...r }) => r));
console.log('\noverlays:'); for (const r of out) console.log('  ' + r.outPng);
writeFileSync(jobs[0].file.replace(/[^/\\]+$/, 'cv_result.json'), JSON.stringify(out, null, 2));
