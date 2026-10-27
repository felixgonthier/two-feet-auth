// Trains FootNet, the tiny per-pixel foot model in core/engine.js, and writes core/footnet.js.
//   npm install && node scripts/train-footnet.mjs [scan.json | tester-scans.jsonl …]   (needs Chrome, like the browser tests)
// Training data is drawn feet (sdk/sample-camera.js) over many floors, skin tones, lights and shadows; the true foot
// outline comes from drawing the same pose again on a magenta floor. Saved real scans (the scanner's ?debug files, or a
// tester-mode export) add real feet: every frame the engine accepts, labelled by the outline it found, keeping a margin
// on both sides of the edge and nothing behind the cut (ankle, leg) where that outline says nothing. The model is one
// of the ways the engine finds the foot, so this teaches it what the other ways agreed on, on real floors and skin.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IMAGES = Number(process.env.IMAGES || 600), HIDDEN = 12, EPOCHS = 8, REAL_PER_FRAME = 1400;

// ---------- Real frames, labelled by the engine's outline ----------
const eng = await import(path.join(ROOT, "core/engine.js"));
const real = { X: [], Y: [], valX: [], valY: [], frames: 0 };
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
function grow(m, w, h, r, val) {  // dilate (val 1) or erode (val 0) by r steps of the 4-neighbourhood
  let cur = m;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const n = [cur[i], x > 0 ? cur[i - 1] : val, x < w - 1 ? cur[i + 1] : val, y > 0 ? cur[i - w] : val, y < h - 1 ? cur[i + w] : val];
      out[i] = val ? Math.max(...n) : Math.min(...n);
    }
    cur = out;
  }
  return cur;
}
let seed = 777;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, "utf8");
  const scans = file.endsWith(".jsonl") ? text.split("\n").filter(Boolean).map(l => JSON.parse(l).scan.scan) : [JSON.parse(text)];
  for (const d of scans) {
    const frames = [...(d.uploads || []).flatMap(u => u.stills || []), ...(d.samples || [])];
    for (const fr of frames) {
      const px = unb64(fr.rgba), w = fr.w, h = fr.h, n = w * h;
      const a = eng.analyzePixels(px, w, h, { minToes: 1 });
      if (!a.ok) continue;
      const { L, A, B } = eng._training.toLab(px, n), g = a.geo;
      const feats = eng._training.footFeatures(L, A, B, w, h, eng._training.floorShadows(L, A, B, w, h));
      const inside = grow(g.mask, w, h, 3, 0), near = grow(g.mask, w, h, 6, 1), len = g.umax - g.umin;
      const label = new Int8Array(n).fill(-1);  // 1 foot, 0 floor, -1 unsure
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
        if (inside[i]) label[i] = 1;
        else if (!near[i] && (x - g.cx) * g.ex + (y - g.cy) * g.ey > g.umin + 0.02 * len) label[i] = 0;
      }
      const toVal = real.frames++ % 7 === 0, F = 10;
      for (let s = 0; s < REAL_PER_FRAME; s++) {
        let i, want = s % 2 === 0 ? 1 : 0;
        for (let tries = 0; tries < 60; tries++) { i = Math.floor(rand() * n); if (label[i] === want) break; }
        if (label[i] !== want) continue;
        (toVal ? real.valX : real.X).push(Array.from(feats.slice(i * F, i * F + F)));
        (toVal ? real.valY : real.Y).push(want);
      }
    }
  }
}
if (real.frames) console.log(`real feet: ${real.frames} frames, ${real.X.length} pixels to train on, ${real.valX.length} held out`);

// The browser imports the real modules, so serve the repo.
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/plain" });
  res.end(fs.readFileSync(file));
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
page.on("console", m => console.log(m.text()));
await page.goto(base + "/package.json");

const net = await page.evaluate(async (base, IMAGES, HIDDEN, EPOCHS, real) => {
  const cam = await import(base + "/sdk/sample-camera.js");
  const eng = await import(base + "/core/engine.js");
  const { toLab, footFeatures, floorShadows } = eng._training;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const SKINS = [[240, 210, 192], [224, 172, 140], [190, 134, 104], [140, 94, 70], [96, 62, 46], [70, 46, 36]];
  const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  const roi = eng.roiFor(cam.SW, cam.SH), [w, h] = eng.procSize(roi.w, roi.h), n = w * h, F = 10;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  const crop = img => { g.drawImage(img, roi.x, roi.y, roi.w, roi.h, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
  const X = [], Y = [], valX = [], valY = [];
  for (let k = 0; k < IMAGES; k++) {
    const pose = cam.samplePose(rand);
    // Floors: anything from near-white to near-black, often warm and close to skin, which is the hard case.
    const warm = rand() < 0.6, v = 25 + rand() * 220;
    pose.floor = warm ? [v, v * (0.7 + rand() * 0.25), v * (0.5 + rand() * 0.35)].map(Math.round) : [v * (0.6 + rand() * 0.4), v * (0.6 + rand() * 0.4), v * (0.6 + rand() * 0.4)].map(Math.round);
    const t = rand() * (SKINS.length - 1), skin = mixRgb(SKINS[Math.floor(t)], SKINS[Math.ceil(t)], t % 1);
    const side = rand() < 0.5 ? "L" : "R";
    const px = crop(cam.drawSample({ pose, skin, rand, side }));
    const truth = crop(cam.drawSample({ pose: { ...pose, floor: [255, 0, 255], split: null, clutter: [], cast: null, light: { ang: 0, gain: 1, slope: 0 } }, skin, rand: () => 0.5, side }));
    const { L, A, B } = toLab(new Uint8Array(px.buffer), n);
    const feats = footFeatures(L, A, B, w, h, floorShadows(L, A, B, w, h));
    const isFoot = i => !(truth[i * 4] > 200 && truth[i * 4 + 1] < 60 && truth[i * 4 + 2] > 200);
    const toVal = k % 7 === 0;
    for (let s = 0; s < 700; s++) {
      // Half foot, half floor, so the rare class isn't drowned out.
      let i, want = s % 2 === 0;
      for (let tries = 0; tries < 50; tries++) { i = Math.floor(rand() * n); if (isFoot(i) === want) break; }
      (toVal ? valX : X).push(feats.slice(i * F, i * F + F));
      (toVal ? valY : Y).push(isFoot(i) ? 1 : 0);
    }
    if (k % 100 === 99) console.log(`drew ${k + 1}/${IMAGES} images`);
  }
  for (const x of real.X) X.push(x);
  for (const y of real.Y) Y.push(y);
  for (const x of real.valX) valX.push(x);
  for (const y of real.valY) valY.push(y);
  // A 10 → HIDDEN → 1 network, leaky ReLU, trained with Adam on log-loss.
  const H = HIDDEN, W1 = new Float32Array(H * F).map(() => (rand() - 0.5) * 0.6), b1 = new Float32Array(H), W2 = new Float32Array(H).map(() => (rand() - 0.5) * 0.6);
  let b2 = 0;
  const params = [W1, b1, W2], m = params.map(p => new Float32Array(p.length)), vv = params.map(p => new Float32Array(p.length));
  let mb2 = 0, vb2 = 0, step = 0;
  const forward = (x, hid) => { let z = b2; for (let j = 0; j < H; j++) { let a = b1[j]; for (let q = 0; q < F; q++) a += W1[j * F + q] * x[q]; hid[j] = a; z += W2[j] * (a > 0 ? a : 0.01 * a); } return 1 / (1 + Math.exp(-z)); };
  const hid = new Float32Array(H), order = X.map((_, i) => i);
  const accuracy = (XS, YS) => { let ok = 0; for (let i = 0; i < XS.length; i++) ok += (forward(XS[i], hid) > 0.5) === (YS[i] === 1); return ok / XS.length; };
  for (let ep = 0; ep < EPOCHS; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const lr = 0.01 * Math.pow(0.6, ep), BATCH = 256;
    for (let s = 0; s < order.length; s += BATCH) {
      const gW1 = new Float32Array(H * F), gb1 = new Float32Array(H), gW2 = new Float32Array(H);
      let gb2 = 0;
      const end = Math.min(order.length, s + BATCH);
      for (let t = s; t < end; t++) {
        const x = X[order[t]], y = Y[order[t]], p = forward(x, hid), d = p - y;
        gb2 += d;
        for (let j = 0; j < H; j++) {
          const a = hid[j], act = a > 0 ? a : 0.01 * a, da = d * W2[j] * (a > 0 ? 1 : 0.01);
          gW2[j] += d * act; gb1[j] += da;
          for (let q = 0; q < F; q++) gW1[j * F + q] += da * x[q];
        }
      }
      step++;
      const bs = end - s, grads = [gW1, gb1, gW2];
      params.forEach((P, pi) => { for (let q = 0; q < P.length; q++) { const gq = grads[pi][q] / bs; m[pi][q] = 0.9 * m[pi][q] + 0.1 * gq; vv[pi][q] = 0.999 * vv[pi][q] + 0.001 * gq * gq; P[q] -= lr * (m[pi][q] / (1 - 0.9 ** step)) / (Math.sqrt(vv[pi][q] / (1 - 0.999 ** step)) + 1e-8); } });
      const gq = gb2 / bs; mb2 = 0.9 * mb2 + 0.1 * gq; vb2 = 0.999 * vb2 + 0.001 * gq * gq; b2 -= lr * (mb2 / (1 - 0.9 ** step)) / (Math.sqrt(vb2 / (1 - 0.999 ** step)) + 1e-8);
    }
    const nv = valX.length - real.valX.length;
    console.log(`epoch ${ep + 1}: pixel accuracy ${(accuracy(X, Y) * 100).toFixed(1)}% train, ${(accuracy(valX.slice(0, nv), valY.slice(0, nv)) * 100).toFixed(1)}% held out drawn${real.valX.length ? `, ${(accuracy(real.valX, real.valY) * 100).toFixed(1)}% held out real` : ""}`);
  }
  const r = a => Array.from(a, x => Math.round(x * 1e4) / 1e4);
  return { F, H, W1: r(W1), b1: r(b1), W2: r(W2), b2: Math.round(b2 * 1e4) / 1e4, samples: X.length };
}, base, IMAGES, HIDDEN, EPOCHS, real);

await browser.close();
server.close();
const { samples, ...weights } = net;
const OUT = process.env.OUT || path.join(ROOT, "core/footnet.js");  // OUT=… writes elsewhere, to judge a model before installing it
fs.writeFileSync(OUT, `// FootNet weights: ${weights.F} inputs, ${weights.H} hidden units, ${weights.F * weights.H + 2 * weights.H + 1} numbers.
// Written by scripts/train-footnet.mjs from ${IMAGES} drawn feet${real.frames ? ` and ${real.frames} real frames` : ""} (${samples} pixels). Don't edit by hand; retrain.
export const FOOTNET = ${JSON.stringify(weights)};
`);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
