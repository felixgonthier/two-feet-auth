// Foot measurement, matching and liveness. Pure JavaScript on pixel arrays:
// the browser SDK uses it to guide the camera, the server uses it to decide.

import { FOOTNET } from "./footnet.js";

export const PROC = 256;        // longest side of an analysed frame, in px
export const BINS = 32;         // slices from heel to toes
export const RW = 32;          // rectified foot strip used for texture…
export const RH = 64;          // …32 × 64
export const MATCH = 0.8;       // a view passes at this score
export const STEADY = 0.85;     // enrollment frames must agree this much
export const GUIDE = 0.62;      // guide frame width / height
export const HOG_LEN = (RW / 8) * (RH / 8) * 9;

// The top of each foot. Soles were dropped: holding a sole up to a camera turns and tilts it too much to match reliably.
export const VIEWS = [
  { key: "R.top", side: "R", view: "top", title: "Top of right foot", sub: "From above · toenails showing",
    how: "Stand your bare right foot flat on the floor, trousers covering your leg. Hold the phone straight above it so the whole foot fits inside the frame, toes at the top." },
  { key: "L.top", side: "L", view: "top", title: "Top of left foot", sub: "From above · toenails showing",
    how: "Now your bare left foot, the same way: flat on the floor, phone straight above, the whole foot inside the frame, toes at the top." },
];
for (const v of VIEWS) v.otherKey = `${v.side === "L" ? "R" : "L"}.${v.view}`;
export const viewByKey = Object.fromEntries(VIEWS.map(v => [v.key, v]));

// The guide frame, centred, in source pixels.
export function roiFor(sw, sh) {
  let h = sh * 0.9, w = h * GUIDE;
  if (w > sw * 0.92) { w = sw * 0.92; h = w / GUIDE; }
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}
// Size an analysed frame is scaled to, for a guide frame of rw × rh.
export function procSize(rw, rh) {
  const k = Math.min(1, PROC / Math.max(rw, rh));
  return [Math.max(16, Math.round(rw * k)), Math.max(16, Math.round(rh * k))];
}

// ---------- Colour ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const f3 = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function toLab(data, n) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]];
    const fx = f3((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = f3(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = f3((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { L, A, B };
}
function isSkin(L, A, B) {
  const chroma = Math.hypot(A, B), hue = Math.atan2(B, A) * 57.29578;
  return chroma >= Math.max(3, 0.08 * L) && hue >= 10 && hue <= 100;
}
export function grayFromRGBA(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) out[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  return out;
}

// ---------- Mask helpers ----------
function otsu(D, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, (D[i] * 2) | 0)]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return (thr + 0.5) / 2;
}
function majority(m, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const s = m[i - w - 1] + m[i - w] + m[i - w + 1] + m[i - 1] + m[i] + m[i + 1] + m[i + w - 1] + m[i + w] + m[i + w + 1];
      out[i] = s >= 5 ? 1 : 0;
    }
  }
  return out;
}
function dilate(m, w, h, r) {
  let cur = m;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        out[i] = cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]) ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}
const invert = m => m.map(v => 1 - v);
const erode = (m, w, h, r) => invert(dilate(invert(m), w, h, r));
const and = (a, b) => a.map((v, i) => v & b[i]);
const count = m => m.reduce((s, v) => s + v, 0);

// Keep one connected shape: big, near the centre (or `at`), and not running off the edge.
function pick(m, w, h, at) {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
  const cx0 = at ? at[0] : w / 2, cy0 = at ? at[1] : h / 2, diag = Math.hypot(w, h);
  let id = 0, bestId = 0, bestScore = 0;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let sp = 0, size = 0, sx = 0, sy = 0, touch = 0;
    stack[sp++] = s;
    lab[s] = id;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      size++; sx += x; sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch++;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && m[i - w] && !lab[i - w]) { lab[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && m[i + w] && !lab[i + w]) { lab[i + w] = id; stack[sp++] = i + w; }
    }
    if (size < 30) continue;
    const d = Math.hypot(sx / size - cx0, sy / size - cy0) / diag;
    let score = size * Math.exp(-((d / 0.28) ** 2));
    if (touch > 0.35 * Math.sqrt(size)) score *= 0.2;
    if (score > bestScore) { bestScore = score; bestId = id; }
  }
  const out = new Uint8Array(n);
  if (bestId) for (let i = 0; i < n; i++) out[i] = lab[i] === bestId ? 1 : 0;
  return out;
}
function fillHoles(m, w, h) {
  const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const push = i => { if (!m[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = m[i] || !seen[i] ? 1 : 0;
  return out;
}
function bilinear(img, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}
function patchGaps(arr) {
  for (let b = 0; b < arr.length; b++) {
    if (!Number.isNaN(arr[b])) continue;
    let k = 1;
    while (k < arr.length) {
      if (b - k >= 0 && !Number.isNaN(arr[b - k])) { arr[b] = arr[b - k]; break; }
      if (b + k < arr.length && !Number.isNaN(arr[b + k])) { arr[b] = arr[b + k]; break; }
      k++;
    }
    if (Number.isNaN(arr[b])) arr[b] = 0;
  }
  return arr;
}

// Background colours: up to three clusters from a ring just inside the frame, so a two-tone floor still counts as background.
// The same frame asks for its floor colours several times; work them out once.
let bgMemo = { L: null, centres: null };
function backgroundColours(L, A, B, w, h) {
  if (bgMemo.L === L) return bgMemo.centres;
  const centres = floorColours(L, A, B, w, h);
  bgMemo = { L, centres };
  return centres;
}
function floorColours(L, A, B, w, h) {
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04)), idx = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
      idx.push(y * w + x);
    }
  }
  idx.sort((p, q) => L[p] - L[q]);
  let centres = [1 / 6, 1 / 2, 5 / 6].map(q => { const i = idx[Math.floor(idx.length * q)]; return [L[i], A[i], B[i]]; });
  const dist = (c, i) => { const dl = (L[i] - c[0]) * 0.5, da = A[i] - c[1], db = B[i] - c[2]; return dl * dl + da * da + db * db; };
  for (let it = 0; it < 6; it++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const i of idx) {
      let bk = 0, bd = Infinity;
      centres.forEach((c, k) => { const d = dist(c, i); if (d < bd) { bd = d; bk = k; } });
      const s = sums[bk];
      s[0] += L[i]; s[1] += A[i]; s[2] += B[i]; s[3]++;
    }
    centres = sums.filter(s => s[3] > idx.length * 0.06).map(s => [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3] / idx.length]);
  }
  // A skin-coloured patch on the edge is usually clutter (a slipper, a hand, the foot itself) unless it fills the edge, like a beige wall.
  const kept = centres.filter(c => !isSkin(c[0], c[1], c[2]) || c[3] > 0.45);
  return kept.length ? kept : centres;
}

// Two ways to find the foot, and the one whose outline sits on the stronger colour edge wins.
// The skin-hue one is sure-footed on ordinary floors; the learnt one copes with floors close to skin colour.
// Up to three ways to find the foot; the outline on the strongest colour edge wins. With `prior` (the previous frame's
// mask), outlines that agree with it get a boost, so one odd frame (a shadow, a hand) doesn't flip the result.
const MODE = () => globalThis.__pbSegment || "all";  // tests compare the methods one at a time
function segment(L, A, B, w, h, prior = null) {
  const shadow = floorShadows(L, A, B, w, h);
  const mode = MODE(), use = m => mode === "all" || mode.split(",").includes(m);
  // Shadow removal is its own candidate: very dark skin on a warm floor can look like that floor in shadow, so
  // it's never forced, only offered when there's a fair amount of shadow-like floor in view.
  const shady = count(shadow) > 0.02 * w * h ? shadow : null;
  // The quick methods first; the slower learnt-colour one only when they disagree about the outline.
  const quick = [
    use("hue") ? segmentByHue(L, A, B, w, h) : null,
    shady && use("hue") ? segmentByHue(L, A, B, w, h, shady) : null,
    use("net") && FOOTNET ? segmentNet(L, A, B, w, h, shadow) : null,
  ].filter(Boolean);
  const okQuick = quick.filter(s => plausible(s.mask, s.area, w, h));
  const agree = mode === "all" && okQuick.length >= 2 && iou(okQuick[0].mask, okQuick[okQuick.length - 1].mask) > 0.9;
  const cands = agree ? quick : [
    ...quick,
    use("learnt") ? segmentLearnt(L, A, B, w, h) : null,
    shady && use("learnt") ? segmentLearnt(L, A, B, w, h, shady) : null,
  ].filter(Boolean);
  const ok = cands.filter(s => plausible(s.mask, s.area, w, h));
  if (!ok.length) return cands[0] || null;
  const score = s => edgeContrast(L, A, B, s.mask, w, h) * (prior && prior.length === s.mask.length ? 0.75 + 0.5 * iou(s.mask, prior) : 1);
  return ok.reduce((a, b) => (score(b) > score(a) ? b : a));
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 0; };

// Floor in shadow: darker than a floor colour but the same hue, with its colour shrinking in step with its lightness,
// which is how a shadow darkens a surface. Skin next to a beige floor differs in hue or saturation, so it stays.
function floorShadows(L, A, B, w, h) {
  const n = w * h, out = new Uint8Array(n), centres = backgroundColours(L, A, B, w, h);
  for (let i = 0; i < n; i++) {
    for (const c of centres) {
      const r = L[i] / Math.max(1, c[0]);
      if (r < 0.25 || r > 0.97) continue;
      const tol = 3 + 0.12 * Math.hypot(c[1], c[2]);
      if (Math.hypot(A[i] - c[1] * r, B[i] - c[2] * r) < tol) { out[i] = 1; break; }
    }
  }
  return out;
}

// FootNet: a tiny per-pixel model (10 inputs, one hidden layer of 12) trained on drawn feet with varied skin, floors,
// light and shadows (scripts/train-footnet.mjs). Its outline is just one more candidate for segment() to weigh.
function footFeatures(L, A, B, w, h, shadow) {
  const n = w * h, F = 10, X = new Float32Array(n * F), centres = backgroundColours(L, A, B, w, h);
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (const c of centres) { const dl = (L[i] - c[0]) * 0.5, da = A[i] - c[1], db = B[i] - c[2]; best = Math.min(best, dl * dl + da * da + db * db); }
    dist[i] = Math.sqrt(best);
  }
  // Floor distance averaged over a 7×7 neighbourhood (two box passes), so lone pixels count less.
  const tmp = new Float32Array(n), near = new Float32Array(n), R = 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += dist[y * w + xx]; c++; } } tmp[y * w + x] = s / c; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let k = -R; k <= R; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } } near[y * w + x] = s / c; }
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const ch = Math.hypot(A[i], B[i]), hue = Math.atan2(B[i], A[i]), o = i * F;
      X[o] = L[i] / 100; X[o + 1] = A[i] / 40; X[o + 2] = B[i] / 40; X[o + 3] = ch / 40;
      X[o + 4] = ch > 2 ? Math.cos(hue) : 0; X[o + 5] = ch > 2 ? Math.sin(hue) : 0;
      X[o + 6] = Math.min(2, dist[i] / 30); X[o + 7] = Math.min(2, near[i] / 30); X[o + 8] = shadow[i];
      X[o + 9] = Math.hypot((x / w - 0.5) * 1.6, y / h - 0.5) * 2;
    }
  }
  return X;
}
export function footNetProb(X, n, net = FOOTNET) {
  const { F, H, W1, b1, W2, b2 } = net, p = new Float32Array(n), hid = new Float32Array(H);
  for (let i = 0; i < n; i++) {
    const o = i * F;
    let z = b2;
    for (let j = 0; j < H; j++) {
      let a = b1[j];
      for (let k = 0; k < F; k++) a += W1[j * F + k] * X[o + k];
      z += W2[j] * (a > 0 ? a : 0.01 * a);
    }
    p[i] = 1 / (1 + Math.exp(-z));
  }
  return p;
}
function segmentNet(L, A, B, w, h, shadow) {
  const n = w * h, p = footNetProb(footFeatures(L, A, B, w, h, shadow), n), raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = p[i] > 0.5 ? 1 : 0;
  const smooth = majority(majority(raw, w, h), w, h);
  const core = pick(erode(smooth, w, h, 2), w, h);
  if (count(core) < 0.02 * n) return null;
  const mask = fillHoles(pick(and(dilate(core, w, h, 3), smooth), w, h), w, h);
  return { mask, area: count(mask) };
}
// For scripts/train-footnet.mjs: the same colour conversion and features the engine uses.
export const _training = { toLab, footFeatures, floorShadows };
// A blob that could be one foot: a sensible size, mostly clear of the frame edge, longer than it is wide.
function plausible(mask, area, w, h) {
  const n = w * h;
  if (area < 0.04 * n || area > 0.85 * n) return false;
  let touch = 0, sx = 0, sy = 0;
  for (let x = 0; x < w; x++) touch += mask[x] + mask[(h - 1) * w + x];
  for (let y = 1; y < h - 1; y++) touch += mask[y * w] + mask[y * w + w - 1];
  if (touch > 0.35 * Math.sqrt(area)) return false;
  for (let i = 0; i < n; i++) if (mask[i]) { sx += i % w; sy += (i / w) | 0; }
  const cx = sx / area, cy = sy / area;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { const dx = (i % w) - cx, dy = ((i / w) | 0) - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const ratio = Math.sqrt((tr / 2 + disc) / Math.max(1e-6, tr / 2 - disc));
  return ratio >= 1.4 && ratio <= 5;
}
// How sharply colour changes across the outline: a mask that follows the real foot edge scores high.
function edgeContrast(L, A, B, mask, w, h) {
  let sum = 0, cnt = 0;
  const diff = (i, j) => Math.hypot((L[i] - L[j]) * 0.5, A[i] - A[j], B[i] - B[j]);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (const [s1, s2] of [[1, 2], [-1, -2], [w, 2 * w], [-w, -2 * w]]) {
        // Inside pixel one step in from the edge, outside pixel one step beyond it, to skip the blurred edge itself.
        if (!mask[i + s1] && mask[i - s1]) { sum += diff(i - s1, i + s2); cnt++; }
      }
    }
  }
  return cnt ? sum / cnt : 0;
}

// Learnt two-colour model: the foot's colours from the middle of the guide, where the foot has to be, the floor's from
// the frame edge. Each pixel goes to whichever it is closer to, then both models are refitted from the result, a few
// times over (a light GrabCut). Works when the floor is close to skin colour, where a fixed skin-hue test can't.
function segmentLearnt(L, A, B, w, h, shadow = null) {
  const n = w * h, MINV = 6, X0 = new Float32Array(n);
  for (let i = 0; i < n; i++) X0[i] = L[i] * 0.5;  // lightness counts half, so shadows and shading matter less
  // A colour model is a mean and a variance per channel; cost() is its negative log-likelihood (up to a constant).
  const model = (mean, v) => ({ mean, v, logdet: Math.log(v[0] * v[1] * v[2]) });
  const cost = (g, i) => {
    const z0 = X0[i] - g.mean[0], z1 = A[i] - g.mean[1], z2 = B[i] - g.mean[2];
    return g.logdet + (z0 * z0) / g.v[0] + (z1 * z1) / g.v[1] + (z2 * z2) / g.v[2];
  };
  // Refit model k from the pixels where label[i] === k (every other pixel is enough).
  const refit = (label, k, old) => {
    let c = 0, m0 = 0, m1 = 0, m2 = 0, q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < n; i += 2) {
      if (label[i] !== k) continue;
      c++; m0 += X0[i]; m1 += A[i]; m2 += B[i]; q0 += X0[i] * X0[i]; q1 += A[i] * A[i]; q2 += B[i] * B[i];
    }
    if (c < 10) return old;
    m0 /= c; m1 /= c; m2 /= c;
    return model([m0, m1, m2], [Math.max(MINV, q0 / c - m0 * m0), Math.max(MINV, q1 / c - m1 * m1), Math.max(MINV, q2 / c - m2 * m2)]);
  };
  // Labels: 0..2 floor clusters, 3 foot, 255 not used for fitting.
  const label = new Uint8Array(n), floorCost = new Float32Array(n);
  const scoreFloor = () => {
    for (let i = 0; i < n; i++) {
      let best = Infinity, k = 0;
      for (let j = 0; j < floor.length; j++) { const c = cost(floor[j], i); if (c < best) { best = c; k = j; } }
      floorCost[i] = best;
      label[i] = k;
    }
  };
  // Floor: up to three colour clusters from a ring just inside the frame.
  let floor = backgroundColours(L, A, B, w, h).map(c => model([c[0] * 0.5, c[1], c[2]], [MINV, MINV, MINV]));
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  scoreFloor();
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (!(x < ring || y < ring || x >= w - ring || y >= h - ring)) label[i] = 255;
  floor = floor.map((g, k) => refit(label, k, g));
  scoreFloor();
  // Foot: the middle strip of the guide, minus anything that already looks like floor.
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) label[i] = x > w * 0.42 && x < w * 0.58 && y > h * 0.28 && y < h * 0.78 && floorCost[i] > 16 ? 3 : 255;
  }
  let foot = refit(label, 3, null);
  if (!foot) return null;
  let mask = null;
  const raw = new Uint8Array(n);
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < n; i++) raw[i] = cost(foot, i) < floorCost[i] && !shadow?.[i] ? 1 : 0;
    const smooth = majority(raw, w, h);
    const core = pick(erode(majority(smooth, w, h), w, h, 2), w, h);
    if (count(core) < 0.02 * n) return null;
    mask = fillHoles(pick(and(dilate(core, w, h, 3), smooth), w, h), w, h);
    if (it === 2) break;
    // Refit: the foot from its own interior, the floor from well outside it.
    const inner = erode(mask, w, h, 2), outer = dilate(mask, w, h, 4);
    for (let i = 0; i < n; i++) label[i] = inner[i] ? 3 : 255;
    foot = refit(label, 3, foot);
    scoreFloor();
    for (let i = 0; i < n; i++) if (outer[i]) label[i] = 255;
    floor = floor.map((g, k) => refit(label, k, g));
    scoreFloor();
  }
  return { mask, area: count(mask) };
}

// Foot mask: skin-hued pixels that differ from the background, the most central blob, then trimmed to the foot's own skin colour.
function segmentByHue(L, A, B, w, h, shadow = null) {
  const n = w * h, centres = backgroundColours(L, A, B, w, h);
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (const c of centres) {
      const dl = (L[i] - c[0]) * 0.5, da = A[i] - c[1], db = B[i] - c[2];
      best = Math.min(best, dl * dl + da * da + db * db);
    }
    D[i] = shadow?.[i] ? 0 : Math.sqrt(best);
  }
  const thr = Math.max(10, otsu(D, n));
  const fg = new Uint8Array(n), skin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (D[i] <= thr) continue;
    fg[i] = 1;
    if (isSkin(L[i], A[i], B[i])) skin[i] = 1;
  }
  const rough = majority(majority(skin, w, h), w, h);
  // Shrinking first breaks thin bridges to background blobs; then grow the chosen blob back.
  const core = pick(erode(rough, w, h, 2), w, h);
  if (count(core) < 0.02 * n) return null;
  let mask = fillHoles(pick(and(dilate(core, w, h, 3), rough), w, h), w, h);
  let area = count(mask);

  // Trim to pixels whose colour matches the foot itself, which drops skin-coloured wood, walls and furniture.
  let sa = 0, sb = 0, qa = 0, qb = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    sa += A[i]; sb += B[i]; qa += A[i] * A[i]; qb += B[i] * B[i];
    sx += i % w; sy += (i / w) | 0;
  }
  const ma = sa / area, mb = sb / area;
  const da = Math.max(2.5, Math.sqrt(qa / area - ma * ma)), db = Math.max(2.5, Math.sqrt(qb / area - mb * mb));
  const same = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const za = (A[i] - ma) / da, zb = (B[i] - mb) / db;
    same[i] = fg[i] && za * za + zb * zb <= 9 ? 1 : 0;
  }
  const trimmed = fillHoles(pick(majority(majority(same, w, h), w, h), w, h, [sx / area, sy / area]), w, h);
  const tArea = count(trimmed);
  if (tArea >= 0.6 * area && tArea <= 1.1 * area) { mask = trimmed; area = tArea; }
  return { mask, area };
}

// Width and side outline of the foot in BINS slices along its long axis.
function slices(mask, w, h, cx, cy, ex, ey) {
  let umin = Infinity, umax = -Infinity;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      const u = (x - cx) * ex + (y - cy) * ey;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
    }
  }
  const len = umax - umin + 1;
  const cnt = new Float64Array(BINS);
  const lo = new Float64Array(BINS).fill(Infinity), hi = new Float64Array(BINS).fill(-Infinity);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      const dx = x - cx, dy = y - cy;
      const u = dx * ex + dy * ey, v = -dx * ey + dy * ex;
      const b = Math.min(BINS - 1, Math.floor(((u - umin) / len) * BINS));
      cnt[b]++;
      if (v < lo[b]) lo[b] = v;
      if (v > hi[b]) hi[b] = v;
    }
  }
  const binLen = len / BINS, width = [], left = [], right = [];
  for (let b = 0; b < BINS; b++) {
    width.push(cnt[b] / binLen / len);
    left.push(cnt[b] ? lo[b] / len : NaN);
    right.push(cnt[b] ? hi[b] / len : NaN);
  }
  return { umin, umax, len, width, lo: patchGaps(left), hi: patchGaps(right) };
}

// Histogram of edge directions in 8×8 cells: picks up toes, nails and creases.
function hog(img, m, W, H) {
  let s = 0, c = 0;
  for (let i = 0; i < W * H; i++) if (m[i]) { s += img[i]; c++; }
  const mean = c ? s / c : 0;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = m[i] ? img[i] : mean;
  const CS = 8, NB = 9, cw = W / CS, hist = new Float32Array(cw * (H / CS) * NB);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + W] - g[i - W];
      const mag = Math.hypot(gx, gy);
      if (!mag) continue;
      let ang = Math.atan2(gy, gx);
      if (ang < 0) ang += Math.PI;
      const fb = (ang / Math.PI) * NB - 0.5;
      let b0 = Math.floor(fb);
      const t = fb - b0;
      const b1 = (b0 + 1 + NB) % NB;
      b0 = (b0 + NB) % NB;
      const cell = (((y / CS) | 0) * cw + ((x / CS) | 0)) * NB;
      hist[cell + b0] += mag * (1 - t);
      hist[cell + b1] += mag * t;
    }
  }
  const norm = () => {
    let q = 0;
    for (const v of hist) q += v * v;
    q = Math.sqrt(q) || 1;
    for (let i = 0; i < hist.length; i++) hist[i] /= q;
  };
  norm();
  for (let i = 0; i < hist.length; i++) hist[i] = Math.min(hist[i], 0.2);
  norm();
  return Array.from(hist);
}

const round = (arr, d = 4) => arr.map(v => Math.round(v * 10 ** d) / 10 ** d);
const fail = (code, message) => ({ ok: false, code, message });

// ---------- Analysis: an RGBA frame of the guide area (≤ PROC px) in, foot measurements out ----------
// How much of the frame's height the foot should run (heel to toes). The scanner sends frames cut around the foot,
// where it runs about 72%; this band is what the server accepts.
export const FIT = { min: 0.45, max: 0.96 };
// Centre, heel-to-toe axis (toes first) and slices of a foot mask.
function orient(mask, area, w, h) {
  let sx = 0, sy = 0;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (mask[i]) { sx += x; sy += y; }
  const cx = sx / area, cy = sy / area;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      const dx = x - cx, dy = y - cy;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ex = Math.cos(th), ey = Math.sin(th);
  let P = slices(mask, w, h, cx, cy, ex, ey);
  // Which end has the toes. The user is asked to hold toes at the top, so when the foot runs up and down the frame the
  // upper end wins: a bare ankle or leg at the heel end can make that end look wider. Only a foot lying across the
  // frame falls back to "the ball of the foot is wider than the heel". Turning 180° keeps left and right distinct.
  const half = BINS / 2;
  const flip = Math.abs(ey) > 0.6 ? ey > 0 : Math.max(...P.width.slice(0, half)) > Math.max(...P.width.slice(half));
  if (flip) { ex = -ex; ey = -ey; P = slices(mask, w, h, cx, cy, ex, ey); }
  return { cx, cy, ex, ey, P };
}
// Where to cut a leg off the heel end (a bin index from the heel), or 0. A heel just narrows to its rounded end; a leg
// joined to it narrows at the ankle and then widens again towards the frame edge.
function ankleCut(width) {
  const end = Math.round(BINS * 0.45);
  let neck = 2;
  for (let b = 2; b < end; b++) if (width[b] < width[neck]) neck = b;
  const beyond = Math.max(...width.slice(0, neck));
  return neck > 2 && beyond > 1.3 * width[neck] && width[neck] < 0.8 * Math.max(...width) ? neck : 0;
}
// Toes: seen from above, the toe end's edge is a row of bumps, one per toe, where a blob is one smooth curve.
// Counts the bumps along the front edge, across the foot's width.
function toeBumps(mask, w, h, cx, cy, ex, ey, P) {
  const N = 24, front = new Float64Array(N).fill(-Infinity), len = P.len;
  const span = Math.max(...P.hi) - Math.min(...P.lo) || 1, v0 = Math.min(...P.lo);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      const dx = x - cx, dy = y - cy, u = (dx * ex + dy * ey - P.umin) / len;
      if (u < 0.7) continue;
      const k = Math.min(N - 1, Math.max(0, Math.floor(((-dx * ey + dy * ex) / len - v0) / span * N)));
      if (u > front[k]) front[k] = u;
    }
  }
  const f = Array.from(front, v => (v === -Infinity ? NaN : v));
  let bumps = 0;
  for (let k = 1; k < N - 1; k++) {
    if (Number.isNaN(f[k])) continue;
    // A bump: higher than its neighbours on both sides, standing out from the lower of the two dips around it.
    let l = k - 1, r = k + 1;
    while (l > 0 && !(f[l] < f[k])) l--;
    while (r < N - 1 && !(f[r] < f[k])) r++;
    if (!(f[k] >= f[k - 1] && f[k] > f[k + 1])) continue;
    let dipL = f[k], dipR = f[k];
    for (let q = k - 1; q >= 0 && !(f[q] > f[k]); q--) if (f[q] < dipL) dipL = f[q];
    for (let q = k + 1; q < N && !(f[q] > f[k]); q++) if (f[q] < dipR) dipR = f[q];
    if (f[k] - Math.max(dipL, dipR) > 0.003) bumps++;
  }
  return bumps;
}
// `prior`: the previous frame's mask (geo.mask), to keep the outline steady from frame to frame.
// `minToes`: toe bumps the front edge must show. The server asks for 2 on full-size frames; the phone's small live
// copy, where toes blur together, asks for 1 just to guide.
export function analyzePixels(data, w, h, { prior = null, minToes = 2, fit = FIT } = {}) {
  const n = w * h;
  if (!(w >= 16 && h >= 16 && w <= PROC && h <= PROC) || data.length !== n * 4) return fail("bad_frame", "The frame has the wrong size.");
  const { L, A, B } = toLab(data, n);
  const seg = segment(L, A, B, w, h, prior);
  if (!seg || seg.area < 0.04 * n) {
    // Nothing found in a very dark frame: say so, rather than "looking".
    let sum = 0;
    for (let i = 0; i < n; i += 4) sum += L[i];
    if (sum / (n / 4) < 22) return fail("dark", "It's too dark to see the foot. Turn on a light or move somewhere brighter.");
    return fail("none", "Looking for a bare foot inside the frame…");
  }
  let { mask, area } = seg;
  if (area > 0.85 * n) return fail("close", "Too close. Move the phone back so there's floor around the foot.");
  let { cx, cy, ex, ey, P } = orient(mask, area, w, h);
  // A bare ankle or leg joined at the heel stretches the outline, by more or less depending on distance and angle,
  // which shifts every measurement. Cut it off where the outline narrows past the heel and then widens again.
  const cut = ankleCut(P.width);
  if (cut > 0) {
    const at = P.umin + (cut / BINS) * P.len;
    mask = mask.slice();
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (mask[i] && (x - cx) * ex + (y - cy) * ey < at) mask[i] = 0;
    mask = fillHoles(pick(mask, w, h), w, h);
    area = count(mask);
    if (area < 0.04 * n) return fail("none", "Looking for a bare foot inside the frame…");
    ({ cx, cy, ex, ey, P } = orient(mask, area, w, h));
  }
  let touch = 0;
  for (let x = 0; x < w; x++) touch += mask[x] + mask[(h - 1) * w + x];
  for (let y = 1; y < h - 1; y++) touch += mask[y * w] + mask[y * w + w - 1];
  if (touch > 0.35 * Math.sqrt(area)) return fail("cropped", "Something skin-coloured runs off the frame. Fit heel to toes inside it, and cover your leg.");
  // Distance: the foot should run most of the way up the frame, the same at enrollment and at every login, so its
  // details are seen at the same size (like Face ID's "move closer").
  const fill = P.len / h;
  if (fill < fit.min) return fail("far", "Move the phone closer: the foot looks too small.");
  if (fill > fit.max) return fail("close", "Move the phone back a little so the whole foot fits.");
  // Is it a foot at all? Mostly skin-coloured, and wider at the toes than at the heel.
  // Skin, as seen and after a simple white balance (the frame's average colour cast taken out), so bluish or
  // yellowish room light doesn't make real skin look grey.
  let skinPx = 0, wbPx = 0, ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += A[i]; mb += B[i]; }
  ma /= n; mb /= n;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (isSkin(L[i], A[i], B[i])) skinPx++;
    if (isSkin(L[i], A[i] - ma, B[i] - mb)) wbPx++;
  }
  skinPx = Math.max(skinPx, wbPx);
  const toeW = Math.max(...P.width.slice(Math.round(BINS * 0.55))), heelW = Math.max(...P.width.slice(0, Math.round(BINS * 0.3)));
  if (skinPx < 0.45 * area) return fail("not_skin", "That doesn't look like a foot yet. Show one bare foot from above, toes at the top.");
  if (toeW < 1.08 * heelW) return fail("not_foot", "That doesn't look like a foot yet. Show one bare foot from above, toes at the top.");
  if (toeBumps(mask, w, h, cx, cy, ex, ey, P) < minToes) return fail("no_toes", "Can't make out the toes. Show the whole foot from above, toes spread a little, at the top.");
  let maxW = 0;
  for (let b = 0; b < BINS; b++) maxW = Math.max(maxW, P.hi[b] - P.lo[b]);
  const aspect = 1 / (maxW || 1);
  const fillRatio = area / (P.len * P.len * (maxW || 1));
  if (aspect < 1.6 || aspect > 4.6 || fillRatio < 0.45 || fillRatio > 0.92) {
    return fail("shape", "That shape doesn't look like a foot. Fit one bare foot inside the frame, heel to toes.");
  }

  // Straighten the foot into a 32×64 strip (toes at the top) for the texture check.
  const rect = new Float32Array(RW * RH), rmask = new Uint8Array(RW * RH);
  for (let j = 0; j < RH; j++) {
    const u = P.umax - ((j + 0.5) / RH) * P.len;
    for (let i = 0; i < RW; i++) {
      const v = (-0.25 + ((i + 0.5) / RW) * 0.5) * P.len;
      const x = cx + u * ex - v * ey, y = cy + u * ey + v * ex;
      const kk = j * RW + i;
      rect[kk] = bilinear(L, w, h, x, y);
      const xi = Math.round(x), yi = Math.round(y);
      rmask[kk] = xi >= 0 && yi >= 0 && xi < w && yi < h ? mask[yi * w + xi] : 0;
    }
  }

  let tL = 0, tA = 0, tB = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { tL += L[i]; tA += A[i]; tB += B[i]; }

  const contour = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) contour.push(x, y);
    }
  }

  return {
    ok: true,
    features: {
      prof: round(P.width),
      lo: round(P.lo),
      hi: round(P.hi),
      aspect: Math.round(aspect * 1e4) / 1e4,
      hog: round(hog(rect, rmask, RW, RH)),
      tone: round([tL / area, tA / area, tB / area], 1),
    },
    geo: { w, h, mask, contour: Int16Array.from(contour), cx, cy, ex, ey, umin: P.umin, umax: P.umax },
  };
}

export const validFeature = f =>
  !!f && Array.isArray(f.prof) && f.prof.length === BINS && Array.isArray(f.lo) && f.lo.length === BINS &&
  Array.isArray(f.hi) && f.hi.length === BINS && Array.isArray(f.hog) && f.hog.length === HOG_LEN &&
  Array.isArray(f.tone) && f.tone.length === 3 && typeof f.aspect === "number";

// ---------- Matching ----------
// Tuned on drawn sample feet with background clutter: same foot 0.85+, the other foot 0.66 or less, another person 0.63 or less.
const TAU = { shape: 0.18, outline: 0.06, prop: 0.22, hog0: 0.5, tone: 14 };
const WEIGHT = { shape: 0.28, outline: 0.37, proportions: 0.08, texture: 0.17, tone: 0.1 };
// Shapes are compared relative to the foot's own width as well as its length, so a phone held at a slight angle
// (which makes the foot look shorter, not narrower) changes little; overall proportions, which do change, count less.
// `tau` and `weight` are overridable for tuning experiments; the defaults are what logins use.
export function compare(a, b, tau = TAU, weight = WEIGHT) {
  const wa = Math.max(...a.prof) || 1, wb = Math.max(...b.prof) || 1;
  const sa = Math.max(...a.hi.map((v, i) => v - a.lo[i])) || 1, sb = Math.max(...b.hi.map((v, i) => v - b.lo[i])) || 1;
  let dProf = 0, sProf = 0, dLo = 0, dHi = 0, dot = 0;
  for (let i = 0; i < BINS; i++) {
    const pa = a.prof[i] / wa, pb = b.prof[i] / wb;
    dProf += Math.abs(pa - pb);
    sProf += (pa + pb) / 2;
    dLo += Math.abs(a.lo[i] / sa - b.lo[i] / sb);
    dHi += Math.abs(a.hi[i] / sa - b.hi[i] / sb);
  }
  for (let i = 0; i < a.hog.length; i++) dot += a.hog[i] * b.hog[i];
  const gauss = (e, tau) => Math.exp(-((e / tau) ** 2));
  const parts = {
    shape: gauss(dProf / (sProf || 1), tau.shape),
    outline: gauss((dLo + dHi) / (2 * BINS), tau.outline),
    proportions: gauss(Math.abs(a.aspect - b.aspect) / ((a.aspect + b.aspect) / 2), tau.prop),
    texture: Math.max(0, Math.min(1, (dot - tau.hog0) / (1 - tau.hog0))),
    tone: gauss(Math.hypot(a.tone[1] - b.tone[1], a.tone[2] - b.tone[2]), tau.tone),
  };
  const score = Object.keys(weight).reduce((t, k) => t + weight[k] * parts[k], 0);
  return { score, parts };
}
// The average of several measurements of one foot: steadier than any one of them (noise and small segmentation
// differences average out), so logins compare the average of their frames with the average of the enrolled ones.
export function meanFeatures(list) {
  const o = {};
  for (const k of ["prof", "lo", "hi", "hog", "tone"]) o[k] = list[0][k].map((_, i) => list.reduce((s, f) => s + f[k][i], 0) / list.length);
  o.aspect = list.reduce((s, f) => s + f.aspect, 0) / list.length;
  return o;
}
export const bestOf = (templates, f) => (templates || []).reduce((m, t) => Math.max(m, compare(t, f).score), 0);

// ---------- Liveness: the toes lift and drop on cue while everything around them stays put ----------
// A photo of a foot moves as one flat picture: tilted, zoomed, shifted or caught in glare, one warp plus a brightness
// change explains all of it. Live toes don't follow that warp. So each frame is warped onto the matched frame using the
// heel, midfoot and ball, and what's left over is measured in three places:
//   rest   the heel-to-ball points the warp was fitted on (how well it fits: blur, noise)
//   toes   the toes themselves
//   guard  a ring of floor around the front of the foot: a finger or anything else reaching over the toes crosses it
// Region bounds are fractions of the foot's length from the heel (s) and across its axis (v).
export function zones(geo) {
  const { w, h, mask, cx, cy, ex, ey, umin, umax } = geo, len = umax - umin;
  const near = dilate(mask, w, h, Math.max(3, Math.round(len * 0.03)));
  const pad = dilate(mask, w, h, Math.max(2, Math.round(len * 0.02)));
  const ringIn = dilate(pad, w, h, Math.max(2, Math.round(len * 0.04)));
  const ringOut = dilate(ringIn, w, h, Math.max(3, Math.round(len * 0.08)));
  const rest = [], toes = [], guard = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const dx = x - cx, dy = y - cy, s = (dx * ex + dy * ey - umin) / len;
      if (near[i] && s <= 0.66) rest.push(x, y);
      else if (pad[i] && s >= 0.74) toes.push(x, y);
      else if (ringOut[i] && !ringIn[i] && s >= 0.66) guard.push(x, y);
    }
  }
  return { rest, toes, guard };
}
// Mean and variance of (frame − reference) over points, with the frame turned by th and shifted by dx, dy.
function diffStats(G, R, w, h, pts, pivot, th, dx, dy, smooth) {
  const c = Math.cos(th), s = Math.sin(th);
  let n = 0, sum = 0, sq = 0;
  for (let k = 0; k < pts.length; k += 2) {
    const px = pts[k] - pivot[0], py = pts[k + 1] - pivot[1];
    const x = pivot[0] + c * px - s * py + dx, y = pivot[1] + s * px + c * py + dy;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
    const d = (smooth ? bilinear(G, w, h, x, y) : G[Math.round(y) * w + Math.round(x)]) - R[pts[k + 1] * w + pts[k]];
    n++;
    sum += d;
    sq += d * d;
  }
  if (n < pts.length / 8) return { mean: 0, v: Infinity };
  const mean = sum / n;
  return { mean, v: sq / n - mean * mean };
}
const DEG = Math.PI / 180;
const ALIGN = [
  { t: 3 * DEG, tn: 2, s: 3, sn: 4 },
  { t: 1.5 * DEG, tn: 1, s: 1, sn: 2 },
  { t: 0.75 * DEG, tn: 1, s: 0.5, sn: 1, smooth: true },
];
// Solve the n × n system M x = v (Gaussian elimination with partial pivoting); null if it's singular.
function solve(M, v, n) {
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < n; r++) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let t = a[r][n]; for (let k = r + 1; k < n; k++) t -= a[r][k] * x[k]; x[r] = t / a[r][r]; }
  return x;
}
// The warp: q = pivot + [a b; c d] (p − pivot) + (tx, ty); brightness: G(q) ≈ gain · R(p) + bias.
const warpAt = (W, pivot, x, y) => { const px = x - pivot[0], py = y - pivot[1]; return [pivot[0] + W[0] * px + W[1] * py + W[4], pivot[1] + W[2] * px + W[3] * py + W[5]]; };
function residualRms(G, R, w, h, pts, pivot, W) {
  let n = 0, sq = 0;
  for (let k = 0; k < pts.length; k += 2) {
    const [x, y] = warpAt(W, pivot, pts[k], pts[k + 1]);
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
    const d = bilinear(G, w, h, x, y) - (W[6] * R[pts[k + 1] * w + pts[k]] + W[7]);
    n++;
    sq += d * d;
  }
  return n >= pts.length / 8 && n > 0 ? Math.sqrt(sq / n) : Infinity;
}
// Residual over points after warping, with a gain and offset fitted to just those points.
function localRms(G, R, w, h, pts, pivot, W) {
  let n = 0, sg = 0, sr = 0, srr = 0, sgr = 0, sgg = 0;
  for (let k = 0; k < pts.length; k += 2) {
    const [x, y] = warpAt(W, pivot, pts[k], pts[k + 1]);
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
    const g = bilinear(G, w, h, x, y), r = R[pts[k + 1] * w + pts[k]];
    n++; sg += g; sr += r; srr += r * r; sgr += g * r; sgg += g * g;
  }
  if (!n || n < pts.length / 8) return Infinity;
  const vr = srr / n - (sr / n) ** 2, cov = sgr / n - (sg / n) * (sr / n), vg = sgg / n - (sg / n) ** 2;
  // Least-squares gain, kept to a sensible range, and the residual variance it leaves.
  const gain = vr > 1e-6 ? Math.max(0.5, Math.min(2, cov / vr)) : 1;
  return Math.sqrt(Math.max(0, vg - 2 * gain * cov + gain * gain * vr));
}
// How much the toes, the heel-to-ball and the ring around the toes changed between grey frames G and R, after undoing
// the movement and brightness change that best explains the heel, midfoot and ball (rigid search, then a refined
// affine fit: hand shake, the phone moving closer or tilting, a photo being waved about).
// Grey frame smoothed by two 3 × 3 box passes: resampling a shifted or zoomed frame blurs fine detail (toenails, the
// gaps between toes) a little, and without this the toes would seem to change more than the smoother heel does.
const smoothMemo = new WeakMap();
function smooth(G, w, h) {
  if (smoothMemo.has(G)) return smoothMemo.get(G);
  let cur = Float32Array.from(G);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) { s += cur[j * w + i]; c++; }
        out[y * w + x] = s / c;
      }
    }
    cur = out;
  }
  smoothMemo.set(G, cur);
  return cur;
}
export function motionOf(G0, R0, w, h, zone, pivot) {
  const G = smooth(G0, w, h), R = smooth(R0, w, h);
  const sub = [], stride = Math.max(1, Math.floor(zone.rest.length / 2 / 1500));
  for (let k = 0; k < zone.rest.length; k += 2 * stride) sub.push(zone.rest[k], zone.rest[k + 1]);
  let best = { th: 0, dx: 0, dy: 0, v: diffStats(G, R, w, h, sub, pivot, 0, 0, 0).v };
  for (const st of ALIGN) {
    if (st.smooth) best.v = diffStats(G, R, w, h, sub, pivot, best.th, best.dx, best.dy, true).v;
    const c = best;
    for (let ti = -st.tn; ti <= st.tn; ti++) {
      for (let xi = -st.sn; xi <= st.sn; xi++) {
        for (let yi = -st.sn; yi <= st.sn; yi++) {
          const th = c.th + ti * st.t, dx = c.dx + xi * st.s, dy = c.dy + yi * st.s;
          const v = diffStats(G, R, w, h, sub, pivot, th, dx, dy, st.smooth).v;
          if (v < best.v) best = { th, dx, dy, v };
        }
      }
    }
  }
  const c0 = Math.cos(best.th), s0 = Math.sin(best.th);
  let W = [c0, -s0, s0, c0, best.dx, best.dy, 1, diffStats(G, R, w, h, sub, pivot, best.th, best.dx, best.dy, true).mean];
  // Gauss–Newton with damping and robust (Huber) weights on the heel-to-ball points.
  const P = 8, JtJ = Array.from({ length: P }, () => new Float64Array(P)), Jtr = new Float64Array(P), J = new Float64Array(P);
  let lambda = 1e-3;
  for (let it = 0; it < 8; it++) {
    for (const row of JtJ) row.fill(0);
    Jtr.fill(0);
    const res = [];
    for (let k = 0; k < sub.length; k += 2) {
      const [x, y] = warpAt(W, pivot, sub[k], sub[k + 1]);
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) { res.push(NaN); continue; }
      res.push(bilinear(G, w, h, x, y) - (W[6] * R[sub[k + 1] * w + sub[k]] + W[7]));
    }
    const mags = res.filter(r => !Number.isNaN(r)).map(Math.abs).sort((a, b) => a - b);
    if (mags.length < 20) break;
    const kH = Math.max(3, 1.5 * mags[Math.floor(mags.length / 2)]);
    let cost = 0;
    for (let k = 0, j = 0; k < sub.length; k += 2, j++) {
      const r = res[j];
      if (Number.isNaN(r)) continue;
      const [x, y] = warpAt(W, pivot, sub[k], sub[k + 1]);
      const gx = (bilinear(G, w, h, x + 1, y) - bilinear(G, w, h, x - 1, y)) / 2, gy = (bilinear(G, w, h, x, y + 1) - bilinear(G, w, h, x, y - 1)) / 2;
      const px = sub[k] - pivot[0], py = sub[k + 1] - pivot[1], Rv = R[sub[k + 1] * w + sub[k]];
      J[0] = gx * px; J[1] = gx * py; J[2] = gy * px; J[3] = gy * py; J[4] = gx; J[5] = gy; J[6] = -Rv; J[7] = -1;
      const wt = Math.abs(r) <= kH ? 1 : kH / Math.abs(r);
      cost += wt * r * r;
      for (let a = 0; a < P; a++) { Jtr[a] += wt * J[a] * r; for (let b = a; b < P; b++) JtJ[a][b] += wt * J[a] * J[b]; }
    }
    for (let a = 0; a < P; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];
    const M = JtJ.map((row, a) => Array.from(row, (v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
    const d = solve(M, Array.from(Jtr, v => -v), P);
    if (!d) break;
    const next = W.map((v, i) => v + d[i]);
    // Keep only sensible warps: no more than 25% zoom or skew from where the rigid search started.
    if (Math.abs(next[0] - c0) > 0.25 || Math.abs(next[3] - c0) > 0.25 || Math.abs(next[1] + s0) > 0.25 || Math.abs(next[2] - s0) > 0.25 || next[6] < 0.5 || next[6] > 2) break;
    const before = residualRms(G, R, w, h, sub, pivot, W), after = residualRms(G, R, w, h, sub, pivot, next);
    if (after <= before) { W = next; lambda = Math.max(1e-6, lambda / 3); if (before - after < 0.01) break; }
    else lambda *= 10;
  }
  // Each region is then measured after its own brightness correction, since light that clips or catches one part of
  // the picture (glare on a photo, a bright lamp) changes skin and floor by different amounts. Only a change of shape
  // and shading within a region counts.
  return {
    rest: localRms(G, R, w, h, zone.rest, pivot, W),
    toes: localRms(G, R, w, h, zone.toes, pivot, W),
    guard: zone.guard.length ? localRms(G, R, w, h, zone.guard, pivot, W) : 0,
  };
}
// What one frame shows, against the matched (toes down) frame:
//   up       the toes changed well beyond how well the rest fits, and nothing crossed the ring around them
//   down     the toes look as they did when matched
//   blocked  something changed in the ring around the toes (a finger, a hand, the picture itself bending)
//   between  anything else (half-lifted, blurred)
export const LIVE = { excess: 5, ratio: 3, still: 2, guard: 2.5, guardRatio: 1.4, run: 2 };
export function toeState(m) {
  if (!(m.rest < Infinity && m.toes < Infinity)) return "between";
  if (m.guard > LIVE.guard + LIVE.guardRatio * m.rest) return "blocked";
  if (m.toes - m.rest >= LIVE.excess && m.toes >= LIVE.ratio * m.rest) return "up";
  if (m.toes - m.rest <= LIVE.still) return "down";
  return "between";
}
// The cues the scanner shows after a match, in order. Each must be answered by LIVE.run frames in a row.
export const CUES = ["up", "down", "up"];
// Frames (in the order taken) and the cue showing when each was taken: did the toes follow every cue, in order?
export function followsCues(states, cues) {
  let step = 0, run = 0;
  for (let i = 0; i < states.length && step < CUES.length; i++) {
    if (cues[i] !== step) { if (cues[i] > step) return false; run = 0; continue; }
    run = states[i] === CUES[step] ? run + 1 : 0;
    if (run >= LIVE.run) { step++; run = 0; }
  }
  return step === CUES.length;
}
