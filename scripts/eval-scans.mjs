// Replays saved scans through the engine, so changes to it can be judged on real feet before they ship: files saved with
// "Save this scan for debugging" in the scanner's ?debug mode, or a tester-mode export (GET /v1/admin/tester-scans, one
// scan per line, which also says who each scan is from). No dependencies.
//   node scripts/eval-scans.mjs scan1.json tester-scans.jsonl …      verdicts per upload, then every session against every other
//   node scripts/eval-scans.mjs -o out/ scan1.json …                 also writes one PNG per upload: the outline the
//                                                                    engine found (green), its axis (blue), the toe end (red)
//   node scripts/eval-scans.mjs --candidates out/ scan1.json …       one PNG per frame with every candidate outline and its numbers
// Scans are replayed in time order: enrollments build the user, later verifies are matched against it. Tester scans
// say who they are from (a hash of the user); files from the same phone (same user agent) are taken to be the same person.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as eng from "../core/engine.js";
import { analyzeInOrder, decideEnroll, decideMatch } from "../core/decide.js";

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args.splice(i, 2)[1]; };
const outDir = opt("-o"), candDir = opt("--candidates");
if (!args.length) { console.error("usage: node scripts/eval-scans.mjs [-o dir] [--candidates dir] scan.json …"); process.exit(1); }

const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
const frame = f => ({ w: f.w, h: f.h, format: "rgba", px: unb64(f.rgba) });
const scans = [];
for (const file of args) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    for (const line of text.split("\n").filter(Boolean)) {
      const { name, scan: x } = JSON.parse(line);
      scans.push(load(name.replace(/\.bin$/, ""), x.scan, { who: x.person, at: x.received_at }));
    }
  } else scans.push(load(path.basename(file, ".json").replace(/^piggyback-scan-/, ""), JSON.parse(text), {}));
}
function load(name, d, { who, at }) {
  const uploads = (d.uploads || []).map((u, i) => ({ i, key: u.key, purpose: u.purpose, result: u.result || {}, stills: (u.stills || []).map(frame) }));
  return { name, ua: d.ua || "", who, at: at || d.saved || "", trail: d.trail || [], misses: (d.misses || []).map(m => ({ code: m.code, ...frame(m) })), uploads };
}
scans.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
const agents = [...new Set(scans.map(s => s.who || s.ua))];
const person = s => "ABCDEFGHIJKLMNOP"[agents.indexOf(s.who || s.ua)] || "?";

// ---------- Replay ----------
const users = {}, sessions = {};  // per person: { views }, and features per session for the cross table
const parts = c => Object.entries(c.parts).filter(([k]) => k !== "proportions").map(([k, v]) => `${k.slice(0, 4)}=${v.toFixed(2)}`).join(" ");
const pngs = [];
for (const s of scans) {
  const who = person(s), user = (users[who] ||= { views: {} });
  const codes = {};
  for (const t of s.trail) codes[t[1]] = (codes[t[1]] || 0) + 1;
  console.log(`\n== ${s.name}  person ${who}  (${s.ua.replace(/^Mozilla\/5\.0 \(/, "").slice(0, 40)})  live frames: ${Object.entries(codes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  for (const u of s.uploads) {
    const view = eng.viewByKey[u.key];
    if (!view) continue;
    const shots = analyzeInOrder(u.stills), codes = shots.map(a => (a.ok ? "ok" : a.code)).join(",");
    const good = shots.filter(a => a.ok).map(a => a.features);
    let line = `u${u.i} ${u.key} ${u.purpose.padEnd(6)} server=${(u.result.ok ? "ok" : u.result.reason || "?").padEnd(10)} frames=${codes.padEnd(24)}`;
    if (u.purpose === "enroll") {
      const r = decideEnroll(view, u.stills, user.views[view.otherKey]);
      line += ` replay=${r.ok ? `ok(${r.templates.length})` : r.reason}`;
      if (r.ok) user.views[u.key] = r.templates;
    } else {
      const r = decideMatch(view, u.stills, user);
      line += ` replay=${r.ok ? "ok" : r.reason} score=${(r.score ?? 0).toFixed(3)}`;
      if (good.length) for (const k of [u.key, view.otherKey]) if (user.views[k]) { const c = eng.compare(eng.meanFeatures(user.views[k]), eng.meanFeatures(good)); line += `\n      vs ${k}: ${c.score.toFixed(3)}  ${parts(c)}`; }
    }
    console.log(line);
    if (good.length) sessions[`${who}.${u.key}.${s.name.slice(-4)}u${u.i}`] = good;
    if (outDir) pngs.push([`${outDir}/${s.name}-u${u.i}-${u.key}-${u.purpose}.png`, u.stills.map((f, i) => overlay(f, shots[i]))]);
    if (candDir) u.stills.forEach((f, i) => {
      const cs = eng._candidates(f.px, f.w, f.h);
      console.log(`      frame ${i}: ` + cs.map(c => `${c.name}${c.ok ? "" : "(x)"} ${c.score.toFixed(1)} [contrast ${c.contrast.toFixed(1)} solidity ${c.solidity.toFixed(2)} compact ${c.compact.toFixed(1)} edge ${c.edges.bottom}/${c.edges.other}]`).join("  "));
      pngs.push([`${candDir}/${s.name}-u${u.i}-f${i}-candidates.png`, cs.map(c => outline(f, c.mask))]);
    });
  }
  if (outDir && s.misses.length) pngs.push([`${outDir}/${s.name}-misses.png`, s.misses.map(f => overlay(f, eng.analyzePixels(f.px, f.w, f.h, { minToes: 1, quick: true })))]);
}

// ---------- Every session against every other ----------
const keys = Object.keys(sessions);
if (keys.length > 1) {
  const kind = (a, b) => { const [pa, sa] = a.split("."), [pb, sb] = b.split("."); return pa === pb && sa === sb ? "same foot" : pa === pb ? "other foot" : "other person"; };
  const rows = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) rows.push({ kind: kind(keys[i], keys[j]), a: keys[i], b: keys[j], c: eng.compare(eng.meanFeatures(sessions[keys[i]]), eng.meanFeatures(sessions[keys[j]])) });
  rows.sort((x, y) => (x.kind === y.kind ? y.c.score - x.c.score : x.kind.localeCompare(y.kind)));
  console.log(`\n== Sessions against each other (mean of each session's frames); a login passes at ${eng.MATCH}`);
  for (const r of rows) console.log(`${r.kind.padEnd(13)} ${r.c.score.toFixed(3)}  ${parts(r.c)}  ${r.a} ~ ${r.b}`);
  const by = {};
  for (const r of rows) (by[r.kind] ||= []).push(r.c.score);
  console.log("");
  for (const [k, v] of Object.entries(by)) console.log(`${k.padEnd(13)} n=${String(v.length).padStart(3)}  min ${Math.min(...v).toFixed(3)}  max ${Math.max(...v).toFixed(3)}`);
}

// ---------- Pictures ----------
for (const [file, frames] of pngs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = tile(frames, 2);
  fs.writeFileSync(file, png(t.rgba, t.w, t.h));
}
if (pngs.length) console.log(`\nwrote ${pngs.length} pictures`);

function overlay(f, a) {
  if (a?.geo) return outline(f, a.geo.mask, a.geo);
  const out = outline(f, null);
  for (let y = 0; y < 3; y++) for (let x = 0; x < f.w; x++) { const i = (y * f.w + x) * 4; out.rgba[i] = 255; out.rgba[i + 1] = out.rgba[i + 2] = 0; }  // red bar: no verdict
  return out;
}
function outline(f, mask, g) {
  const rgba = Uint8Array.from(f.px), w = f.w, h = f.h;
  const dot = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; };
  if (mask) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) dot(x, y, [0, 255, 0]); }
  if (g) {
    for (let u = g.umin; u <= g.umax; u += 0.5) dot(g.cx + u * g.ex, g.cy + u * g.ey, [0, 128, 255]);
    for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) dot(g.cx + g.umax * g.ex + d, g.cy + g.umax * g.ey + e, [255, 0, 0]);
  }
  return { w, h, rgba };
}
function tile(frames, k) {
  const gap = 4, h = Math.max(...frames.map(f => f.h)), W = frames.reduce((s, f) => s + f.w * k + gap, 0), H = h * k, out = new Uint8Array(W * H * 4).fill(40);
  let x0 = 0;
  for (const f of frames) {
    for (let y = 0; y < f.h * k; y++) for (let x = 0; x < f.w * k; x++) { const si = (((y / k) | 0) * f.w + ((x / k) | 0)) * 4, di = (y * W + x0 + x) * 4; out[di] = f.rgba[si]; out[di + 1] = f.rgba[si + 1]; out[di + 2] = f.rgba[si + 2]; out[di + 3] = 255; }
    x0 += f.w * k + gap;
  }
  return { rgba: out, w: W, h: H };
}
function png(rgba, w, h) {
  const CRC = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
