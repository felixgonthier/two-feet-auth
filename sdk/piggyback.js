// <piggyback-auth> — drop-in foot scanner for any login page.
//
//   <script type="module" src="https://feet.example.com/sdk/piggyback.js"></script>
//   <piggyback-auth server="https://feet.example.com" session-token="…"></piggyback-auth>
//
// Your backend creates the session (POST /v1/sessions) and hands the session token to the page.
// The element walks the user through the views (the top of each foot), uploads frames, and fires:
//   piggyback-complete  { code, redirect_to }   → send the code to your backend, which swaps it at POST /v1/token
//   piggyback-view      { key, ok, reason, message }
//   piggyback-error     { error, message }      → camera_unavailable, session_failed, invalid_session, network
//   piggyback-handoff-done {}                   → on the phone, once its views have passed; the computer finishes
// The element never decides whether the user passed; the server does.
// For demos without a server, set `element.backend` to a LocalBackend (sdk/local-backend.js) before it connects.
//
// Attributes: server, session-token, autostart, source="sample" (drawn feet, for demos), sample-who="you|impostor|photo",
//   handoff="auto|on|off" (computers offer "Use my phone" with a QR code by default), mode="phone" (set by the phone page).
// Theme with CSS custom properties: --pb-accent, --pb-accent-ink, --pb-bg, --pb-ink, --pb-muted, --pb-good, --pb-bad, --pb-font.
import { viewByKey, LIVE, CUES, STEADY, roiFor, GUIDE, procSize, analyzePixels, compare, zones, motionOf, toeState, grayFromRGBA } from "../core/engine.js";
import { analyzeInOrder } from "../core/decide.js";
import { qrEncode } from "../core/qr.js";

const TICK = 130;            // ms between analysed frames
const WIGGLE_PER_CUE = 5;    // grey frames sent per toe cue (the server takes up to 16 in all)
const WIGGLE_TIMEOUT = 9000; // ms to follow the toe cues before sending what we have
const MISS_GRACE = 3;        // odd frames in a row a hold survives
const TESTER_PARTIAL = 15000; // ms of searching after which tester mode sends what it has so far, so a try that never ends is still seen
// One camera stream per page, shared by every scanner on it: a phone doing step after step (enroll, then the first
// login) asks for the camera once. Between scanners the stream is paused (its tracks disabled, so it sees nothing)
// rather than closed, because Safari asks for permission again for every new stream; it's closed after CAMERA_KEEP.
const CAMERA_KEEP = 3 * 60 * 1000;
const camera = { stream: null, users: 0, idle: 0 };
async function openCamera() {
  clearTimeout(camera.idle);
  if (!camera.stream || camera.stream.getTracks().some(t => t.readyState === "ended")) {
    camera.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } } });
  }
  camera.stream.getTracks().forEach(t => { t.enabled = true; });
  camera.users++;
  return camera.stream;
}
function releaseCamera() {
  camera.users = Math.max(0, camera.users - 1);
  if (camera.users) return;
  clearTimeout(camera.idle);
  camera.stream?.getTracks().forEach(t => { t.enabled = false; });
  camera.idle = setTimeout(() => { camera.stream?.getTracks().forEach(t => t.stop()); camera.stream = null; }, CAMERA_KEEP);
}
// Whether the browser is about to ask for the camera ("prompt"), or null where it won't say.
async function cameraPermission() {
  try { return (await navigator.permissions.query({ name: "camera" })).state; } catch { return null; }
}
// Browsers ask for the camera on every visit until the site is allowed for good, which only the user can do (a page
// can't): how to do it in this browser. Safari on iPhone keeps asking until it's set in Website Settings; other
// browsers on iPhone can't remember it at all.
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
function allowTip() {
  const ua = navigator.userAgent;
  if (isIOS()) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
    ? "This browser asks for the camera every time and can't remember it on iPhone. Open this page in Safari instead, then tap aA in the address bar › Website Settings › Camera › Allow, and it won't ask again."
    : "To stop the camera question for good: tap aA in the address bar › Website Settings › Camera › Allow. You only do this once.";
  if (/Android/.test(ua)) return "To stop the camera question: when Chrome asks, choose “Allow while visiting the site”, not “Only this time”.";
  if (/Firefox\//.test(ua)) return "To stop the camera question: tick “Remember this decision” when Firefox asks.";
  if (/Edg\/|Chrome\//.test(ua)) return "To stop the camera question: choose “Allow on every visit” when the browser asks, not “Allow this time”.";
  if (/Safari\//.test(ua)) return "To stop the camera question: Safari › Settings for This Website › Camera › Allow.";
  return null;
}
// Why the camera couldn't start, from getUserMedia's error: a short label and what to do about it in this browser.
function cameraProblem(e) {
  const ua = navigator.userAgent, name = e?.name || "";
  if (!navigator.mediaDevices?.getUserMedia) return ["Camera unavailable", "This browser can't use the camera on this page. Open it in Safari or Chrome."];
  if (/NotReadable|TrackStart|Abort/.test(name)) return ["Camera busy", "Another app or tab is using the camera. Close it, then tap Start camera again."];
  if (/NotFound|DevicesNotFound|Overconstrained/.test(name)) return ["No camera", "No camera was found on this device."];
  // Refused: by the user, by an earlier "Don't allow", or by the browser itself after several dismissed prompts.
  if (isIOS()) return ["Camera blocked", /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
    ? "The camera was refused. Tap Start camera and allow it, or open this page in Safari."
    : "Safari has blocked the camera for this site. Tap aA in the address bar › Website Settings › Camera › Allow, then tap Start camera again."];
  if (/Android/.test(ua)) return ["Camera blocked", "The browser has blocked the camera for this site. Tap the icon left of the address › Permissions › Camera › Allow (or Reset permissions), then tap Start camera again. If it's already allowed there, check Android's settings: Apps › Chrome › Permissions › Camera."];
  if (/Firefox\//.test(ua)) return ["Camera blocked", "Firefox has blocked the camera for this site. Click the crossed-out camera in the address bar, remove the block, then try again."];
  if (/Edg\/|Chrome\//.test(ua)) return ["Camera blocked", "The browser has blocked the camera for this site. Click the icon left of the address › Camera › Allow, then try again."];
  if (/Safari\//.test(ua)) return ["Camera blocked", "Safari has blocked the camera for this site. Safari › Settings for This Website › Camera › Allow, then try again."];
  return ["Camera blocked", "The camera was refused. Allow camera access in your browser's settings for this site, then try again."];
}
// The phone looks at a smaller copy of each frame (about a third of the pixels) to guide and to see the foot hold
// still; the full-size frames it sends are what the server decides on.
const LIVE_SCALE = 0.62;
// The live check finds the foot at a wider range of distances than the frames it sends allow, since those are cut
// around the foot so it runs FOOT_FILL of their height; a hold starts inside LIVE_FIT_ENTER and may drift to LIVE_FIT.
const FOOT_FILL = 0.72;
const LIVE_FIT_ENTER = { min: 0.3, max: 0.94 }, LIVE_FIT = { min: 0.27, max: 0.96 };
const POLL = 1500;           // ms between checks on a phone that is scanning for this computer
const ENROLL_HOLD = 9;       // steady frames (about 1.2 s) before an enrollment view is saved
const VERIFY_HOLD = 4;       // steady frames (about half a second) before a login sends them to be matched
const ENROLL_SEND = 4;       // of which this many, spread out, go to the server
// The judge's taste: a meaningless number per scan (0..1), taken from image texture so it never tracks
// a foot's size or shape. It only picks his reaction; it plays no part in the decision.
const footVibe = f => {
  let h = 7;
  for (let i = 0; i < f.hog.length; i += 5) h = (h * 31 + Math.round(f.hog[i] * 1e4)) % 1000003;
  return (h % 1000) / 1000;
};
const VIBE = { lovely: 0.72, ugly: 0.3 };
const RING = 26; // px the progress border's canvas overhangs the lens (room for its glow)
// A phone-screen shape: a w × h rectangle with smooth (superellipse) corners of radius r, as points clockwise
// from the top centre, plus the length all the way round.
const shapeMemo = new Map();
function screenShape(w, h, r = w * 0.2, steps = 480) {
  // Drawn twice every animation frame for the same lens size; worked out once per size.
  const key = `${w},${h},${r},${steps}`;
  if (shapeMemo.has(key)) return shapeMemo.get(key);
  const shape = buildScreenShape(w, h, r, steps);
  if (shapeMemo.size > 8) shapeMemo.clear();
  shapeMemo.set(key, shape);
  return shape;
}
function buildScreenShape(w, h, r, steps) {
  const a = w / 2, b = h / 2, pts = [];
  let total = 0;
  for (let i = 0; i < steps; i++) {
    // Walk a superellipse (n = 5 is close to Apple's continuous corners) and stretch its middle into straight sides.
    // Snap tiny cosines to 0 so the walk really starts at the top centre, where the progress begins.
    const th = -Math.PI / 2 + (i / steps) * Math.PI * 2, c = Math.abs(Math.cos(th)) < 1e-9 ? 0 : Math.cos(th), s = Math.sin(th);
    const x = Math.sign(c) * Math.abs(c) ** 0.4 * r, y = Math.sign(s) * Math.abs(s) ** 0.4 * r;
    pts.push([a + x + Math.sign(c) * (a - r), b + y + Math.sign(s) * (b - r)]);
    if (i) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  total += Math.hypot(pts[0][0] - pts[steps - 1][0], pts[0][1] - pts[steps - 1][1]);
  return { pts, total };
}
// "#4CD992" → "rgba(76,217,146,0.16)"; other colour formats come back unchanged.
const withAlpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(hex) ? `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})` : hex);
const tracePath = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };

const CSS = `
:host {
  /* Brand (brand/BRAND.md): blue = act, green = done, pink = you are here. Round and glassy. Customers can override any of these. */
  --pb-accent: #2F6BFF; --pb-accent-ink: #FFFFFF; --pb-bg: #FFFFFF; --pb-ink: #14161A; --pb-muted: #555B66;
  --pb-good: #4CD992; --pb-good-ink: #138A50; --pb-pink: #FF8FB1; --pb-bad: #D93A2B;
  --pb-glass: rgba(255,255,255,.62); --pb-glass-edge: rgba(255,255,255,.85); --pb-glass-line: rgba(20,22,26,.10);
  --pb-btn-deepen: 0; --pb-btn-glass: rgba(255,255,255,.66); --pb-btn-glass-hover: rgba(255,255,255,.86); --pb-btn-shadow: rgba(20,22,26,.16);
  --pb-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  display: block; container-type: inline-size; color: var(--pb-ink); font: 16px/1.5 var(--pb-font);
}
@media (prefers-color-scheme: dark) {
  :host { --pb-accent: #6B95FF; --pb-bg: #111318; --pb-ink: #F3F4F6; --pb-muted: #A2A8B4; --pb-good: #5BE39C; --pb-good-ink: #5BE39C; --pb-bad: #FF7A6B;
    --pb-glass: rgba(255,255,255,.07); --pb-glass-edge: rgba(255,255,255,.18); --pb-glass-line: rgba(255,255,255,.10);
    --pb-btn-deepen: 1; --pb-btn-glass: rgba(255,255,255,.1); --pb-btn-glass-hover: rgba(255,255,255,.14); --pb-btn-shadow: rgba(0,0,0,.45); }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
/* Like Face ID: a lens shaped like a phone screen with a progress border around it, the status underneath, then what to do. */
.card { max-width: 420px; margin: 0 auto; display: grid; gap: 14px; justify-items: center; text-align: center; }
.side { display: grid; gap: 14px; justify-items: center; }
/* One column: the button sits right under the status, close to the lens. */
.status { order: -2; } .actions { order: -1; }
/* The choices sit side by side as pills of one size: equal columns as wide as the longest label. */
.actions { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; margin-top: 8px; }
.eyebrow { margin: 0 0 2px; color: var(--pb-muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.viewfinder { position: relative; width: min(100% - 56px, 250px); aspect-ratio: 0.62; margin: 26px auto 10px; }
.lens { position: absolute; inset: 0; isolation: isolate; }
.lens canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; filter: drop-shadow(0 16px 22px rgba(20,22,26,.3)); }
.lens video { position: absolute; left: 0; top: 0; width: 2px; height: 2px; opacity: 0; pointer-events: none; }
.ring { position: absolute; left: -26px; top: -26px; width: calc(100% + 52px); height: calc(100% + 52px); pointer-events: none; } /* RING px over each side */
.viewfinder.shake { animation: vshake .5s ease-in-out; }
@keyframes vshake { 0%, 100% { transform: translateX(0); } 15% { transform: translateX(-10px); } 30% { transform: translateX(9px); } 45% { transform: translateX(-7px); } 60% { transform: translateX(5px); } 75% { transform: translateX(-3px); } }
/* The status: a small glass chip with a dot, so it reads as live feedback rather than a heading. */
.status { display: inline-flex; align-items: center; gap: 8px; max-width: 34ch; margin: 0; padding: 6px 14px 6px 12px; border: 1px solid var(--pb-glass-edge); border-radius: 18px;
  background: var(--pb-glass); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); box-shadow: 0 0 0 1px var(--pb-glass-line);
  color: var(--pb-muted); font-size: 14px; font-weight: 600; line-height: 1.35; text-align: left; transition: color .2s, background .2s; }
.status::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .55; }
.status.live { color: var(--pb-ink); }
.status.live::before { background: var(--pb-accent); opacity: 1; animation: blink 1.4s ease-in-out infinite; }
.status.good { color: var(--pb-good-ink); background: color-mix(in srgb, var(--pb-good) 10%, var(--pb-glass)); }
.status.bad { color: var(--pb-bad); background: color-mix(in srgb, var(--pb-bad) 9%, var(--pb-glass)); }
.status.good::before, .status.bad::before { background: currentColor; opacity: 1; animation: none; }
/* Finished: a checklist of what happened, and a bar while the page heads back to the app. */
.done-list { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 8px; width: 100%; max-width: 300px; text-align: left; }
.done-list li { display: flex; align-items: center; gap: 10px; padding: 9px 14px 9px 10px; border: 1px solid var(--pb-glass-edge); border-radius: 16px; background: var(--pb-glass);
  box-shadow: 0 0 0 1px var(--pb-glass-line); font-size: 14px; font-weight: 600; animation: rise-in .4s cubic-bezier(.2,.9,.3,1.2) both; }
.done-list li:nth-child(2) { animation-delay: .12s; } .done-list li:nth-child(3) { animation-delay: .24s; }
.done-list.tips li { font-weight: 500; animation: none; }
.done-list.tips li::before { background: var(--pb-glass-line) no-repeat center/12px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3zM9.5 19h5M10.5 21.5h3' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); box-shadow: none; }
.done-list li::before { content: ""; flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--pb-good) no-repeat center/12px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5' fill='none' stroke='white' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 4px 10px -6px var(--pb-good); }
.done-list small { margin-left: auto; padding-left: 8px; color: var(--pb-muted); font-weight: 500; }
@keyframes rise-in { from { opacity: 0; transform: translateY(8px); } }
.leaving { display: grid; gap: 6px; width: 100%; max-width: 300px; color: var(--pb-muted); font-size: 13px; font-weight: 600; }
.leaving i { height: 4px; border-radius: 99px; background: var(--pb-glass-line); overflow: hidden; }
.leaving i::after { content: ""; display: block; height: 100%; width: 100%; border-radius: inherit; background: var(--pb-accent); transform-origin: left; animation: leave 1.6s linear both; }
@keyframes leave { from { transform: scaleX(0); } }
/* Confetti from the judge on success. */
.burst { position: absolute; left: 50%; top: 40%; pointer-events: none; }
.burst i { position: absolute; width: 8px; height: 12px; border-radius: 2px; opacity: 0; }
.judge[data-celebrate] .burst i { animation: confetti 1.3s cubic-bezier(.15,.7,.3,1) both; }
.burst i:nth-child(3n) { background: #FF8FB1; } .burst i:nth-child(3n+1) { background: var(--pb-good); } .burst i:nth-child(3n+2) { background: #FFD36B; border-radius: 50%; width: 9px; height: 9px; }
@keyframes confetti { 0% { opacity: 1; transform: translate(0,0) rotate(0); } 100% { opacity: 0; transform: translate(var(--x), var(--y)) rotate(var(--r)); } }
/* Finished: a check in the chip instead of the dot. */
.status.done::before { width: 16px; height: 16px; background: currentColor no-repeat center/10px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5' fill='none' stroke='white' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
@keyframes blink { 50% { opacity: .3; } }
/* Which foot to show, inside the lens at the top, big enough to read at arm's length on a phone. */
.which { position: absolute; top: 14px; left: 50%; z-index: 2; display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px 6px 6px; transform: translateX(-50%);
  border: 1px solid rgba(255,255,255,.3); border-radius: 999px; background: rgba(20,22,26,.55); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  color: #FFFFFF; font-size: 15px; font-weight: 700; white-space: nowrap; pointer-events: none; animation: rise-in .35s ease both; }
.which b { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(180deg, #FF9BBC, #E5578A); font-size: 13px; }
.which span small { font-weight: 500; opacity: .75; }
/* The judge: a small pig in a frosted glass tile inside the lens, reacting to every foot. */
.judge { position: absolute; left: 50%; bottom: 16px; width: 62px; height: 62px; padding: 7px; transform: translateX(-50%); pointer-events: none; z-index: 2;
  border: 1px solid rgba(255,255,255,.32); border-radius: 18px; background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.08));
  -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 8px 18px -8px rgba(0,0,0,.45);
  transition: background .3s, border-color .3s, box-shadow .3s; }
/* Success comes out of the judge: his tile turns green and a check pops out of its corner. */
.judge[data-ok] { border-color: rgba(255,255,255,.6); background: linear-gradient(180deg, rgba(255,255,255,.3), rgba(255,255,255,0) 60%), var(--pb-good);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 8px 22px -8px var(--pb-good); }
.tick { position: absolute; right: -9px; top: -9px; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #FFFFFF; color: var(--pb-good-ink);
  box-shadow: 0 4px 10px -3px rgba(0,0,0,.35); opacity: 0; transform: translate(-16px, 16px) scale(.3); transition: opacity .2s, transform .45s cubic-bezier(.2,1.5,.4,1); }
.tick svg { width: 14px; height: 14px; }
.judge[data-ok] .tick { opacity: 1; transform: none; }
.pig { position: relative; width: 100%; height: 100%; transform-origin: 50% 85%; }
.pig img { width: 100%; height: 100%; display: block; filter: drop-shadow(0 3px 5px rgba(0,0,0,.3)); transition: filter .35s ease; }
.pig::after { content: ""; position: absolute; inset: 28% 6% 22%; border-radius: 50%; opacity: 0; transition: opacity .3s;
  background: radial-gradient(circle at 22% 62%, rgba(255,70,120,.75), transparent 24%), radial-gradient(circle at 78% 62%, rgba(255,70,120,.75), transparent 24%); }
.judge.yes .pig { animation: nod .9s ease-in-out both; }
.judge.no .pig { animation: shake .8s ease-in-out both; }
.judge.flustered .pig { animation: fluster 1.6s ease-in-out both; }
.judge.flustered .pig::after { opacity: 1; }
.judge.sick .pig { animation: queasy 1.8s ease-in-out both; }
.judge.sick .pig img { filter: drop-shadow(0 3px 5px rgba(0,0,0,.3)) hue-rotate(78deg) saturate(.7) brightness(.96); }
@keyframes nod { 0%, 100% { transform: translateY(0); } 18% { transform: translateY(5px) scaleY(.92); } 36% { transform: translateY(-2px); } 56% { transform: translateY(5px) scaleY(.92); } 76% { transform: translateY(-1px); } }
@keyframes shake { 0%, 100% { transform: rotate(0); } 14% { transform: rotate(-16deg) translateX(-4px); } 32% { transform: rotate(14deg) translateX(4px); } 50% { transform: rotate(-11deg) translateX(-3px); } 68% { transform: rotate(8deg) translateX(2px); } 84% { transform: rotate(-3deg); } }
@keyframes fluster { 0% { transform: scale(1); } 15% { transform: scale(1.16) rotate(-7deg); } 30% { transform: scale(1.1) rotate(6deg); } 45% { transform: scale(1.16) rotate(-5deg); } 60% { transform: scale(1.1) rotate(3deg); } 100% { transform: scale(1); } }
@keyframes queasy { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(-9deg) translateY(2px) scaleX(1.05); } 45% { transform: rotate(7deg) translateY(3px) scaleY(.94); } 70% { transform: rotate(-5deg) translateY(2px); } }
.fx { position: absolute; inset: 0; pointer-events: none; }
.fx i { position: absolute; display: block; opacity: 0; }
.hearts i { width: 15px; height: 14px; background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 22'%3E%3Cpath fill='%23FF5C8A' d='M12 21s-9-5.6-9-12.2C3 5.6 5.4 3 8.4 3c1.6 0 2.9.8 3.6 2 .7-1.2 2-2 3.6-2C18.6 3 21 5.6 21 8.8 21 15.4 12 21 12 21z'/%3E%3C/svg%3E"); }
.stink i { width: 11px; height: 21px; background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 30'%3E%3Cpath d='M8 29c-6-4 6-8 0-12s6-8 0-12' fill='none' stroke='%237BC96F' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E"); }
.fx i:nth-child(1) { left: -12%; top: 26%; } .fx i:nth-child(2) { left: 40%; top: -22%; } .fx i:nth-child(3) { left: 92%; top: 20%; }
.judge.flustered .hearts i { animation: rise 1.5s ease-out both; }
.judge.sick .stink i { animation: rise 1.7s ease-out both; }
.fx i:nth-child(2) { animation-delay: .18s !important; } .fx i:nth-child(3) { animation-delay: .34s !important; }
@keyframes rise { 0% { opacity: 0; transform: translateY(6px) scale(.6); } 25% { opacity: 1; transform: translateY(-4px) scale(1); } 100% { opacity: 0; transform: translateY(-24px) scale(.9); } }
@media (prefers-reduced-motion: reduce) {
  .viewfinder.shake, .status.live::before, .done-list li, .leaving i::after { animation: none; }
  .judge[data-celebrate] .burst i { animation: none; opacity: 0; }
  .judge, .tick { transition: none; }
  .pig, .judge .pig, .fx i { animation: none !important; }
  .judge.flustered .hearts i, .judge.sick .stink i { opacity: 1; }
}

.text { display: grid; gap: 4px; max-width: 38ch; }
h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--pb-muted); letter-spacing: 0; }
p { margin: 0; }
.how { color: var(--pb-muted); font-size: 15px; }
/* Wide spaces: the lens on the left, everything else beside it, so the button stays within reach. */
@container (min-width: 620px) {
  /* Top-aligned with the lens, so the words don't jump when they change length. */
  .card { max-width: 740px; grid-template-columns: auto minmax(0, 1fr); align-items: start; justify-items: start; column-gap: 28px; }
  .side { padding-top: 40px; }
  .viewfinder { width: 250px; margin: 26px; }
  .side { justify-items: start; text-align: left; }
  .status, .actions { order: 0; }
  .actions { justify-content: flex-start; }
  .brand { grid-column: 1 / -1; justify-self: center; }
}
/* Same as ui/controls.css .pb-btn: a pill of tinted glass, a bright rim on top and a soft glow of its own colour. */
/* In the dark the accent is lightened for text and links; buttons take it back to a deep, saturated fill so white labels stay crisp. */
button { --fill: var(--pb-accent);
  appearance: none; position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 132px; min-height: 48px; padding: 0 22px;
  border: 1px solid rgba(255,255,255,.3); border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0) 55%), color-mix(in srgb, color-mix(in oklab, var(--fill), #fff var(--hi, 0%)) 94%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.6); backdrop-filter: blur(16px) saturate(1.6);
  color: var(--pb-accent-ink); font: 600 16px/1 var(--pb-font); letter-spacing: -.005em; cursor: pointer; -webkit-tap-highlight-color: transparent;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.32), 0 1px 2px var(--pb-btn-shadow), 0 8px 20px -10px color-mix(in srgb, var(--fill) 80%, transparent);
  transition: transform .18s cubic-bezier(.3,1.4,.5,1), box-shadow .18s ease, background-color .18s ease; }
button:hover { --hi: 9%; transform: translateY(-1px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 1px 2px var(--pb-btn-shadow), 0 12px 26px -12px color-mix(in srgb, var(--fill) 90%, transparent); }
button:active { --hi: 0%; transform: scale(.97); transition-duration: .06s;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 1px 1px var(--pb-btn-shadow), 0 4px 10px -8px color-mix(in srgb, var(--fill) 80%, transparent); }
button:focus-visible { outline: 2px solid var(--pb-accent); outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: .45; transform: none; }
/* Second choices: frosted glass, ink text, the same size as the main one. No sheen: the rim does the work. */
button.alt { border-color: var(--pb-glass-edge); background: var(--pb-btn-glass); color: var(--pb-ink);
  box-shadow: inset 0 1px 0 var(--pb-glass-edge), 0 0 0 1px var(--pb-glass-line), 0 6px 16px -12px var(--pb-btn-shadow); }
button.alt:hover { background: var(--pb-btn-glass-hover);
  box-shadow: inset 0 1px 0 var(--pb-glass-edge), 0 0 0 1px var(--pb-glass-line), 0 10px 22px -12px var(--pb-btn-shadow); }
button.alt:active { background: var(--pb-btn-glass); }
/* Small glyphs where they say something: Redo turns back, Next moves on, Finish ticks. They nudge on hover. */
.redo::before, .next::after { content: ""; flex: none; width: 18px; height: 18px; margin: 0 -2px; background: currentColor; transition: transform .25s cubic-bezier(.3,1.4,.5,1);
  -webkit-mask: var(--glyph) center/contain no-repeat; mask: var(--glyph) center/contain no-repeat; }
.redo { --glyph: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4.2h4.2' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
.next { --glyph: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12h13M13 6.5l5.5 5.5-5.5 5.5' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
.next.last { --glyph: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5' fill='none' stroke='black' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
.redo:hover::before { transform: rotate(-50deg); }
.next:hover::after { transform: translateX(3px); }
.next.last:hover::after { transform: scale(1.15); }
/* Narrow spaces: a little less padding so two choices still fit side by side; stacked only when there's truly no room. */
@supports (color: oklch(from red l c h)) { button { --fill: oklch(from var(--pb-accent) calc(l - .09 * var(--pb-btn-deepen)) calc(c * (1 + .3 * var(--pb-btn-deepen))) h); } }
@container (max-width: 400px) { button { min-width: 112px; padding: 0 16px; font-size: 15px; } }
@container (max-width: 320px) { .actions { grid-auto-flow: row; } }
@media (prefers-reduced-motion: reduce) {
  button, .redo::before, .next::after { transition: none; }
  button:hover, button:active, .redo:hover::before, .next:hover::after { transform: none; }
}
.save { color: var(--pb-accent); font-size: 13px; font-weight: 600; }
/* How to stop the browser asking for the camera every time: shown before the camera starts, until the site is allowed. */
.allow { order: -1; max-width: 36ch; margin: 0; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--pb-accent) 28%, transparent); border-radius: 14px;
  background: color-mix(in srgb, var(--pb-accent) 8%, var(--pb-glass)); color: var(--pb-ink); font-size: 13.5px; line-height: 1.45; text-align: left; }
.tip { max-width: 38ch; margin: 0; color: var(--pb-muted); font-size: 12.5px; line-height: 1.45; }
.brand { display: inline-flex; align-items: center; gap: 6px; color: var(--pb-muted); font-size: 12px; font-weight: 600; }
.brand img { width: 20px; height: 20px; }
`;
const PIG_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAwKADAAQAAAABAAAAwAAAAABNOznKAABAAElEQVR4Aey9CZhlV3Xfu+9Qc4/qQVNrVmtAohEIxGDAFjbYBjMEjLANTjwkwS8vduw8f8+J4yQk/mJ/JiY2+Qh27ORlcGwT7BjwAAYMwmIQoJaE5qmR1BpaPajnquqqunXvfb/ff59bkgLCGNQC4j5V555z9rD22mvaaw9nn1JOHCcocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAicocIICJyhwggInKHCCAico8C1Egda3EK5PiurbhsP2vyxlrOzYUVpbty4+acITEV8zBYbD4dj8HXds7MzPTx+Zm2uXsbHh+MxMf+309Oy/Ov/8/W9rtQZfM/BvYMZvSQVYuOWW80D8ue324PJOKReUVmsz5/QQQnIeaLXajwxa5a5+f3D98rB9/apLLtn9DaTxt2zR87fcckZ3OPzOdn/5ymEZPBOab2mV4apUqNMZtrqdQel0D/P84LDduWG5lE8slc4nVm/duu9bpdLfMgpw9IYbNk2MjX1/uzV8Hcbm+e1OZ23EXZEfHS2q02mX0mrO3nIZDoZ7hqV19fJg8J5de/d/+Jwrr1wYJT9x/fIU6N1w87e3Su/HW8Pl726PjW0uA0R70OccFFoCbA10bkvrbqV3l+vYOMDaxJed/WHnDwedzn+fOPfcm798Cd88od/0CnBk+/aNMzNTP1mWBz/S7pQzy2CplN5SGFHEnsDShvAyxSOXeu9vmCVzlmFeaV3XW+7/6vilz/pDwr8lm+zU8Tj9zF133bPH2+Vt7X7/Ve32sFMWF5D5PnTDyDyOvrSwCH6le8I1OvChRVirC60nJsuwX45hdP7b/MLSv123bdu9xwnlrxtsIzVfN5ynHACWprV0yy0/2G23/nW70z6vLMyWQQ/jHesjwdvcyghOLQ8WKYxCA/yrB4zDJNlStPqD0hpvrFSr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";
const PIGGY = `<img src="${PIG_SRC}" alt="">`;
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const b64 = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
async function packFrame(bytes, w, h, format, cue) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return { w, h, format, data: b64(buf), ...(cue != null && { cue }) };
}

// ---------- Analysis off the main thread ----------
// Looking at a frame takes 50–150 ms of pure JavaScript on a mid-range phone, and checking the frames to send takes
// several times that. Done on the main thread, it stalls the camera preview and the ring; done in a worker, the page
// stays smooth and a slow phone simply looks at fewer frames. The worker imports the same engine the page uses, from
// the service (which serves /core/* with CORS); where that isn't possible (a single-file bundle, an old browser), the
// same calls run inline, as before.
const WORKER_SRC = `
let eng, dec, prior = null, ref = null;
const ready = (async () => { [eng, dec] = await Promise.all([import(BASE + "/core/engine.js"), import(BASE + "/core/decide.js")]); })();
self.onmessage = async ({ data: m }) => {
  try {
    await ready;
    let r = true;
    if (m.op === "analyze") {
      r = eng.analyzePixels(m.rgba, m.w, m.h, { prior: m.usePrior && prior?.length === m.w * m.h ? prior : null, minToes: m.minToes, fit: m.fit, quick: m.quick });
      if (r.ok) prior = r.geo.mask;
    } else if (m.op === "reset") prior = null;
    else if (m.op === "order") r = dec.analyzeInOrder(m.frames);
    else if (m.op === "ref") ref = { R: m.R, w: m.w, h: m.h, zone: eng.zones(m.geo), pivot: m.pivot };
    else if (m.op === "motion") { const mo = eng.motionOf(m.G, ref.R, m.w, m.h, ref.zone, ref.pivot); r = { m: mo, state: eng.toeState(mo) }; }
    self.postMessage({ id: m.id, r });
  } catch (e) { self.postMessage({ id: m.id, error: String(e) }); }
};`;
const STALL = 5000;
let workerFailed = false;   // once a worker has failed on this page, later scanners don't wait for another one
class Analyst {
  constructor(base) {
    this.base = base;
    this.inline = !base || typeof Worker === "undefined" || workerFailed;
    this.prior = null;
    this.ref = null;
    this.calls = new Map();
    this.id = 0;
    if (!this.inline) {
      try {
        const url = URL.createObjectURL(new Blob([`const BASE = ${JSON.stringify(base)};${WORKER_SRC}`], { type: "text/javascript" }));
        this.worker = new Worker(url, { type: "module" });
        this.worker.onmessage = ({ data }) => {
          const c = this.calls.get(data.id);
          if (!c) return;
          clearTimeout(c.timer);
          this.calls.delete(data.id);
          data.error ? c.reject(new Error(data.error)) : c.resolve(data.r);
        };
        // The worker couldn't start (or import the engine): everything from now on runs inline.
        this.worker.onerror = e => { e.preventDefault?.(); this.fallback(); };
      } catch { this.inline = true; }
    }
  }
  fallback() {
    if (this.inline) return;
    this.inline = true;
    workerFailed = true;
    this.worker?.terminate();
    // Carry on where the worker was: the toe check's reference frame, then whatever was waiting.
    if (this.refMsg) this.run(this.refMsg);
    for (const [id, c] of this.calls) { clearTimeout(c.timer); this.calls.delete(id); c.resolve(this.run(c.m)); }
  }
  // The engine call itself, for the inline path.
  run(m) {
    if (m.op === "analyze") {
      const r = analyzePixels(m.rgba, m.w, m.h, { prior: m.usePrior && this.prior?.length === m.w * m.h ? this.prior : null, minToes: m.minToes, fit: m.fit, quick: m.quick });
      if (r.ok) this.prior = r.geo.mask;
      return r;
    }
    if (m.op === "reset") { this.prior = null; return true; }
    if (m.op === "order") return analyzeInOrder(m.frames);
    if (m.op === "ref") { this.ref = { R: m.R, w: m.w, h: m.h, zone: zones(m.geo), pivot: m.pivot }; return true; }
    if (m.op === "motion") { const mo = motionOf(m.G, this.ref.R, m.w, m.h, this.ref.zone, this.ref.pivot); return { m: mo, state: toeState(mo) }; }
    return true;
  }
  call(m, transfer = []) {
    if (m.op === "ref") this.refMsg = m;
    if (this.inline) return Promise.resolve(this.run(m));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      // A worker that never answers (an engine import that hangs, a browser that stalls module workers) would stall
      // the scanner: after STALL ms everything runs inline instead.
      const timer = setTimeout(() => { if (this.calls.has(id)) this.fallback(); }, STALL);
      this.calls.set(id, { resolve, reject, m, timer });
      try { this.worker.postMessage({ id, ...m }, transfer); } catch { this.calls.delete(id); this.fallback(); resolve(this.run(m)); }
    }).catch(e => { this.fallback(); return this.run(m); });
  }
  analyze(frame, opts) { return this.call({ op: "analyze", rgba: frame.rgba, w: frame.w, h: frame.h, ...opts }); }
  reset() { return this.call({ op: "reset" }); }
  order(frames) { return this.call({ op: "order", frames }); }
  setRef(ref) { return this.call({ op: "ref", ...ref }); }
  motion(G, w, h) { return this.call({ op: "motion", G, w, h }); }
  close() { this.worker?.terminate(); this.worker = null; this.inline = true; }
}

// Talks to the verification service with the session token.
export class HttpBackend {
  constructor(server, token) {
    this.server = server;
    this.token = token;
  }
  async call(method, path, body) {
    let res;
    try {
      res = await fetch(this.server + path, { method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error("Can't reach the verification service."), { code: "network" });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || "Request failed."), { code: data.error || "http_" + res.status, exitUrl: data.exit_url || null });
    return data;
  }
  getSession() { return this.call("GET", "/v1/session"); }
  async submitView(key, frames) {
    const packed = await Promise.all(frames.map(f => packFrame(f.px, f.w, f.h, f.format, f.cue)));
    return this.call("POST", `/v1/session/views/${key}`, { frames: packed });
  }
  complete() { return this.call("POST", "/v1/session/complete"); }
  resetView(key) { return this.call("POST", `/v1/session/views/${key}/reset`); }
  // `modes`: { debug, tester }, carried over to the phone.
  handoff(fresh = false, modes = {}) { return this.call("POST", "/v1/session/handoff", { ...(fresh && { fresh: true }), ...modes }); }
  tester(scan) { return this.call("POST", "/v1/session/tester", { scan }); }
}

export class PiggybackAuth extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<style>${CSS}</style>
      <div class="card">
        <div class="viewfinder">
          <canvas class="ring" aria-hidden="true"></canvas>
          <div class="lens"><video playsinline muted hidden></video><canvas aria-hidden="true"></canvas>
            <div class="which" hidden><b></b><span></span></div>
            <div class="judge" aria-hidden="true">
              <div class="pig"><img src="${PIG_SRC}" alt=""></div>
              <span class="fx hearts"><i></i><i></i><i></i></span>
              <span class="fx stink"><i></i><i></i><i></i></span>
              <span class="burst"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
              <span class="tick">${CHECK}</span>
            </div>
          </div>
        </div>
        <div class="side">
          <p class="status" aria-live="polite"><span class="st"></span></p>
          <div class="text"><p class="eyebrow" hidden></p><h2 class="title">Scan your feet</h2><p class="how"></p></div>
          <ul class="done-list" hidden></ul>
          <div class="leaving" hidden><span></span><i></i></div>
          <p class="allow" hidden></p>
          <p class="tip" hidden></p>
          <a class="save" href="#" hidden>Save this scan for debugging</a>
          <div class="actions">
            <button type="button" class="alt redo" hidden>Redo</button>
            <button type="button" class="next" hidden>Next</button>
            <button type="button" class="start">Start camera</button>
            <button type="button" class="alt camera" hidden>Use this computer</button>
            <button type="button" class="alt fresh" hidden>Show a code</button>
          </div>
        </div>
        <span class="brand">${PIGGY}Secured by Piggyback</span>
      </div>`;
    const $ = s => this.shadowRoot.querySelector(s);
    this.ui = { video: $("video"), canvas: $(".lens canvas"), ring: $(".ring"), vf: $(".viewfinder"), st: $(".st"), status: $(".status"), judge: $(".judge"), title: $(".title"), how: $(".how"), start: $(".start"), alt: $(".camera"), doneList: $(".done-list"), which: $(".which"), leaving: $(".leaving"), tip: $(".tip"), allow: $(".allow"), save: $(".save"), fresh: $(".fresh"), next: $(".next"), redo: $(".redo"), eyebrow: $(".eyebrow") };
    this.ui.start.addEventListener("click", () => {
      if (this.state.phase === "failed") return this.exitUrl && location.assign(this.exitUrl);
      return this.canHandOff ? this.handOff() : this.start();
    });
    this.ui.alt.addEventListener("click", () => this.start());
    this.ui.fresh.addEventListener("click", () => this.handOff({ fresh: true }));
    this.ui.next.addEventListener("click", () => this.nextView());
    this.ui.redo.addEventListener("click", () => this.redoView());
    this.ui.save.addEventListener("click", e => { e.preventDefault(); this.saveScan(); });
    this.views = [];
    this.state = { running: false, i: 0, phase: "idle", steady: [], wiggle: null, last: null, status: "Camera off", tone: "", meter: null };
    this.work = document.createElement("canvas");
    this.pigImg = new Image();
    this.pigImg.src = PIG_SRC;
    new ResizeObserver(() => this.draw()).observe(this.shadowRoot.querySelector(".viewfinder"));
  }
  get server() { return (this.getAttribute("server") || location.origin).replace(/\/$/, ""); }
  get token() { return this.getAttribute("session-token") || ""; }
  get api() {
    this.backend ||= this.token ? new HttpBackend(this.server, this.token) : null;
    return this.backend;
  }
  connectedCallback() {
    // On a computer, the phone is the main way in; this computer's camera is the fallback.
    this.ui.start.textContent = this.canHandOff ? "Use my phone" : "Start camera";
    this.ui.alt.hidden = !this.canHandOff;
    this.renderSide();
    // The analyst starts now, so its worker has loaded the engine by the time the camera is on.
    this.analyst ||= new Analyst(this.getAttribute("analysis") === "inline" ? null : this.server);
    this.loadSession().then(() => { if (this.hasAttribute("autostart")) this.start(); });
    this.adviseCamera();
  }
  // If this device's camera will be used and the browser hasn't been told to allow it for good, say how, before it asks.
  async adviseCamera() {
    if (this.canHandOff || this.getAttribute("source") === "sample" || !navigator.mediaDevices?.getUserMedia) return;
    const state = await cameraPermission();
    // iPhone browsers may not answer the question; there, an unknown state means it will ask.
    if (state === "granted" || state === "denied" || (state === null && !isIOS())) return;
    const tip = allowTip();
    if (tip) { this.ui.allow.textContent = tip; this.ui.allow.hidden = false; }
  }
  disconnectedCallback() { this.stop(); this.analyst?.close(); this.analyst = null; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
  // `exitUrl`: where to send the user when this sign-in can't go on (back to the app with access_denied).
  fail(code, message, exitUrl = null) {
    if (this.hasAttribute("tester")) this.sendTester({ failed: code });
    this.stop();
    clearTimeout(this.pollTimer);
    // The status chip carries the label; out of tries, the line turns red and the lens shakes, like a wrong passcode.
    const short = { camera_unavailable: this.cameraLabel || "Camera blocked", session_failed: "Too many tries", invalid_session: "Sign-in expired" }[code] || "Something went wrong";
    const closed = code === "session_failed" || code === "invalid_session";
    const detail = code === "camera_unavailable"
      ? `${this.cameraHelp || "Allow camera access in your browser."}${this.canHandOff ? " Or use your phone instead." : ""}`
      : closed ? null : message;
    this.setStatus(short, closed ? "bad" : "", null, detail);
    delete this.ui.judge.dataset.ok;
    this.qr = this.handoffUrl = null;
    this.ui.next.hidden = this.ui.redo.hidden = this.ui.alt.hidden = this.ui.fresh.hidden = true;
    if (closed) {
      // This sign-in is over: one way out, back to the app for a fresh one, plus tips for next time.
      this.state.phase = "failed";
      this.failCode = code;
      this.exitUrl = exitUrl;
      const app = this.appName || "the app";
      this.ui.start.hidden = !exitUrl;
      this.ui.start.textContent = `Back to ${app}`;
      this.ui.doneList.className = "done-list tips";
      this.ui.doneList.innerHTML = code === "session_failed"
        ? ["A floor lighter or darker than your skin", "The whole foot inside the frame, toes at the top", "Once it matches, keep your heel down and follow the prompts: curl your toes, relax, curl again"].map(t => `<li>${t}</li>`).join("")
        : "";
      this.ui.doneList.hidden = code !== "session_failed";
      this.ui.leaving.hidden = true;
    }
    this.renderSide();
    if (code === "session_failed") {
      this.ui.vf.classList.remove("shake");
      void this.ui.vf.offsetWidth;
      this.ui.vf.classList.add("shake");
    }
    this.draw();
    this.emit("piggyback-error", { error: code, message });
  }
  async loadSession() {
    if (!this.api) return;
    try {
      const s = await this.api.getSession();
      this.purpose = s.purpose;
      this.appName = s.app || null;
      // Enrollment covers both feet; a login asks for the one(s) the server picked.
      this.views = s.views.map(v => ({ ...viewByKey[v.key], ok: v.ok }));
      this.renderSide();
      // The phone that just did this user's previous step (say, enrolling) can take this one: no new code to scan.
      if (s.phone_ready && this.canHandOff && this.state.phase === "idle") this.handOff();
    } catch (e) {
      this.fail(e.code, e.message);
    }
  }

  // ---------- Camera ----------
  async start() {
    if (this.state.running) return;
    this.frozen = null;
    clearTimeout(this.pollTimer);
    this.qr = this.handoffUrl = null;
    this.ui.alt.hidden = this.ui.fresh.hidden = true;
    delete this.ui.judge.dataset.ok;
    this.ui.doneList.hidden = this.ui.leaving.hidden = true;
    if (!this.purpose) await this.loadSession();
    if (!this.purpose) return;
    if (this.getAttribute("source") === "sample") {
      const { createSampleCamera } = globalThis.PiggybackSample || (await import("./sample-camera.js"));
      this.sample = createSampleCamera({ who: this.getAttribute("sample-who") || "you" });
    } else {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error();
        this.stream = await openCamera();
        this.ui.video.srcObject = this.stream;
        this.ui.video.hidden = false;
        // A play() cut short by another load isn't a camera problem; the stream is there.
        await this.ui.video.play().catch(e => { if (e?.name !== "AbortError") throw e; });
      } catch (e) {
        [this.cameraLabel, this.cameraHelp] = cameraProblem(e);
        this.ui.allow.hidden = true;
        return this.fail("camera_unavailable", this.cameraHelp);
      }
    }
    if (this.hasAttribute("tester")) {
      const note = "Tester mode: what the camera sees during these scans is saved on the server for 30 days to improve foot detection.";
      this.ui.tip.textContent = note;
      this.ui.tip.hidden = false;
    }
    Object.assign(this.state, { running: true, i: this.views.findIndex(v => !v.ok) });
    this.ui.start.hidden = true;
    // A worker for the analysis, unless the element says not to (analysis="inline") or the engine can't be reached.
    this.analyst ||= new Analyst(this.getAttribute("analysis") === "inline" ? null : this.server);
    this.pending = null;
    this.beginView();
    this.loop();
    this.animate();
  }
  stop() {
    this.state.running = false;
    this.state.gen = (this.state.gen || 0) + 1;
    clearTimeout(this.pollTimer);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    // Keep the last camera frame in the lens rather than going dark (on a match, an error, a finished sign-in).
    if (this.stream && this.shown === this.ui.video && !this.frozen) this.frozen = this.snapshot();
    if (this.stream) releaseCamera();
    this.stream = null;
    this.ui.video.srcObject = null;
  }
  frameSource() {
    const view = this.views[this.state.i];
    if (this.sample) return this.sample.frame(view, this.state.phase === "wiggle" && CUES[this.state.wiggle.step], TICK / 1000);
    return this.ui.video.videoWidth ? this.ui.video : null;
  }
  // The guide area of the current frame, small, for the live check. The frames that are measured and sent are cut
  // from the full camera picture around the foot instead (cropAt), so the foot fills them the same way at any distance.
  grab() {
    const src = this.frameSource();
    if (!src) return null;
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const roi = roiFor(sw, sh), [w, h] = procSize(roi.w, roi.h);
    const c = this.work;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    // The whole picture is kept as it was at this moment, since the frame to measure is cut from it once the
    // analysis (which runs off the main thread, a few camera frames later) says where the foot is.
    const full = (this.workFull ||= document.createElement("canvas"));
    if (full.width !== sw || full.height !== sh) { full.width = sw; full.height = sh; }
    full.getContext("2d").drawImage(src, 0, 0);
    g.drawImage(full, roi.x, roi.y, roi.w, roi.h, 0, 0, w, h);
    this.shown = src;
    const sw2 = Math.max(16, Math.round(w * LIVE_SCALE)), sh2 = Math.max(16, Math.round(h * LIVE_SCALE));
    const s = (this.workSmall ||= document.createElement("canvas"));
    if (s.width !== sw2 || s.height !== sh2) { s.width = sw2; s.height = sh2; }
    const sg = s.getContext("2d", { willReadFrequently: true });
    sg.drawImage(c, 0, 0, sw2, sh2);
    return { src: full, sw, sh, roi, small: { rgba: new Uint8Array(sg.getImageData(0, 0, sw2, sh2).data.buffer), w: sw2, h: sh2 } };
  }
  // Where to cut the measured frame: around the foot the live check found, with the foot running FOOT_FILL of the
  // frame's height (as at enrollment, so it's measured at the same scale), in the guide's proportions.
  footBox(a, f) {
    const g = a.geo, c = g.contour, kx = f.roi.w / g.w, ky = f.roi.h / g.h;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] < x0) x0 = c[i];
      if (c[i] > x1) x1 = c[i];
      if (c[i + 1] < y0) y0 = c[i + 1];
      if (c[i + 1] > y1) y1 = c[i + 1];
    }
    const bw = (x1 - x0 + 1) * kx, bh = (y1 - y0 + 1) * ky;
    const h = Math.min(Math.max(bh / FOOT_FILL, bw / (GUIDE * 0.75)), f.sh, f.sw / GUIDE), w = h * GUIDE;
    const cx = f.roi.x + ((x0 + x1 + 1) / 2) * kx, cy = f.roi.y + ((y0 + y1 + 1) / 2) * ky;
    return { x: Math.max(0, Math.min(f.sw - w, cx - w / 2)), y: Math.max(0, Math.min(f.sh - h, cy - h / 2)), w, h };
  }
  // That part of the camera picture, at analysis size.
  cropAt(box, src) {
    const [w, h] = procSize(box.w, box.h), c = (this.workCrop ||= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, w, h);
    return { rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer), w, h, box };
  }

  // The ball of the foot in an outline: the widest slice of its front 60%, as a point on the axis and a width, in the
  // outline's own pixels. It barely moves when the toes curl or lift, so it's what the toe step keeps in place.
  footBall(g) {
    const c = g.contour, len = g.umax - g.umin || 1, N = 32, lo = new Float64Array(N).fill(Infinity), hi = new Float64Array(N).fill(-Infinity);
    for (let i = 0; i < c.length; i += 2) {
      const dx = c[i] - g.cx, dy = c[i + 1] - g.cy, u = dx * g.ex + dy * g.ey, v = -dx * g.ey + dy * g.ex;
      const b = Math.min(N - 1, Math.max(0, Math.floor(((u - g.umin) / len) * N)));
      if (v < lo[b]) lo[b] = v;
      if (v > hi[b]) hi[b] = v;
    }
    let best = Math.round(N * 0.4), width = 0;
    for (let b = best; b < N; b++) if (hi[b] - lo[b] > width) { width = hi[b] - lo[b]; best = b; }
    const u = g.umin + ((best + 0.5) / N) * len;
    return { x: g.cx + u * g.ex, y: g.cy + u * g.ey, width: width || 1 };
  }
  // During the toe step: where to cut this frame so the ball of the foot sits where it did in the matched frame, at
  // the same size. A phone that drifts closer, further or sideways after the match then cancels out, and only what the
  // toes do is left for the motion check; a box that stayed put would see the whole foot move and call it blocked.
  followBox(a, frame, w) {
    const b = this.footBall(a.geo), kx = frame.roi.w / a.geo.w, ky = frame.roi.h / a.geo.h;
    const scale = Math.max(0.5, Math.min(2, (b.width * kx) / (w.ball.width * (w.box.w / w.w))));
    const bw = Math.min(frame.sw, w.box.w * scale), bh = Math.min(frame.sh, w.box.h * scale);
    const bx = frame.roi.x + b.x * kx - (w.ball.x / w.w) * bw, by = frame.roi.y + b.y * ky - (w.ball.y / w.h) * bh;
    const box = { x: Math.max(0, Math.min(frame.sw - bw, bx)), y: Math.max(0, Math.min(frame.sh - bh, by)), w: bw, h: bh };
    // Half-way to the new place each frame: steady against jitter, quick enough to follow a hand.
    const p = w.box;
    return { x: (p.x + box.x) / 2, y: (p.y + box.y) / 2, w: (p.w + box.w) / 2, h: (p.h + box.h) / 2 };
  }

  // ---------- The scan loop ----------
  // The status chip stays short ("No match · 4 tries left"); `detail` explains, in place of the line under the heading.
  setStatus(text, tone = "", meter = null, detail = null) {
    Object.assign(this.state, { status: text, tone, meter, detail });
    if (this.ui.how.textContent !== (detail || this.baseHow || "")) this.ui.how.textContent = detail || this.baseHow || "";
  }
  // The judge: a steady mood (idle or watching) plus short reactions that play over it.
  mood(base) {
    this.baseMood = base;
    if (!this.reacting && this.ui.judge.className !== `judge ${base}`) this.ui.judge.className = `judge ${base}`;
  }
  react(kind, ms = 1800) {
    clearTimeout(this.reactTimer);
    this.reacting = true;
    const j = this.ui.judge;
    j.className = "judge";
    void j.offsetWidth;
    j.className = `judge ${kind}`;
    this.reactTimer = setTimeout(() => { this.reacting = false; j.className = `judge ${this.baseMood || ""}`; }, ms);
  }
  beginView() {
    // A short warm-up while the camera settles its exposure, so nothing seen in the first moment counts.
    Object.assign(this.state, { phase: "find", steady: [], wiggle: null, last: null, missSince: 0, missRun: 0, rejects: 0, nextSay: null, matchRef: null, findSince: performance.now(), testerSent: 0, warmUntil: performance.now() + 700, gen: (this.state.gen || 0) + 1 });
    this.pending = null;
    this.analyst?.reset();
    this.ui.next.hidden = this.ui.redo.hidden = true;
    delete this.ui.judge.dataset.ok;
    this.mood("");
    this.setStatus("Looking for your foot…");
    this.renderSide();
  }
  loop() {
    if (!this.state.running) return;
    this.timer = setTimeout(() => this.loop(), TICK);
    if (this.state.phase === "find" || this.state.phase === "wiggle") this.tick();
    this.draw();
  }
  // Smooth overlay animation between analysed frames.
  animate() {
    cancelAnimationFrame(this.raf);
    const step = t => {
      if (!this.state.running && this.state.phase !== "handoff") return;
      this.draw(t);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  // Hand the analyst a piece of work; `then` runs with its answer unless the view has moved on meanwhile. While one is
  // out, ticks are skipped: a slow phone looks at fewer frames rather than falling behind.
  defer(promise, then) {
    const st = this.state, gen = st.gen;
    this.pending = promise.then(r => { this.pending = null; if (st.running && st.gen === gen) then(r); }, () => { this.pending = null; });
  }
  tick() {
    const st = this.state;
    if (this.pending) return;
    const f = this.grab();
    if (!f) return;
    if (st.phase === "wiggle") return this.tickWiggle(f);
    if (performance.now() < st.warmUntil) {
      // Warm the analyst up on a frame that won't count, so the first real one isn't slowed by a cold start.
      if (!this.warmed) { this.warmed = true; this.defer(this.analyst.analyze(f.small, { minToes: 1, fit: LIVE_FIT_ENTER, quick: true }), () => this.analyst.reset()); }
      return this.setStatus("Getting ready…");
    }
    // The last good outline steadies this one (frame fusion); the analyst keeps it, and drops it once the frame size changes.
    // A hold starts inside LIVE_FIT_ENTER and then may drift out to the wider LIVE_FIT, so a foot right at the edge of the band
    // doesn't flicker between "Hold still" and "Move closer". `quick`: the slow learnt-colour method only when the quick ones fail.
    this.defer(this.analyst.analyze(f.small, { usePrior: true, minToes: 1, fit: st.steady.length ? LIVE_FIT : LIVE_FIT_ENTER, quick: true }), a => this.seen(f, a));
  }
  seen(f, a) {
    const st = this.state, fs = f.small;
    if (st.phase !== "find") return;
    st.missRun = a.ok ? 0 : (st.missRun || 0) + 1;
    if (this.collecting) this.trace(a, fs);
    // A long search in tester mode is worth seeing even if it never ends: send what there is so far every so often.
    if (this.hasAttribute("tester") && performance.now() - Math.max(st.findSince, st.testerSent) > TESTER_PARTIAL) { st.testerSent = performance.now(); this.sendTester({ partial: true }); }
    // A few odd frames in a row (a passing shadow, motion blur, a jolt) don't undo the hold or change the message.
    if (!a.ok && st.steady.length && st.missRun <= MISS_GRACE) return;
    st.last = a.ok ? a : null;
    this.mood(a.ok ? "watch" : "");
    if (!a.ok) {
      st.steady = [];
      st.box = null;
      st.missSince ||= performance.now();
      const missing = performance.now() - st.missSince;
      // Distance is said straight away, like Face ID's "Move closer"; other problems once they've lasted a moment.
      if (a.code === "far" || a.code === "close" || a.code === "dark") return this.say({ far: "Move closer", close: "Move back", dark: "Too dark" }[a.code], a.message);
      return this.say("Looking for your foot…", missing > 1500 && a.code !== "none" ? a.message
        : missing > 6000 ? "Still looking. A floor lighter or darker than your skin, and good light, help a lot." : null);
    }
    st.missSince = 0;
    // The frame to measure, cut around the foot; the cut follows the foot smoothly rather than jumping with it.
    const box = this.footBox(a, f), b0 = st.box;
    st.box = b0 && Math.abs(box.h / b0.h - 1) < 0.25 ? { x: (b0.x + box.x) / 2, y: (b0.y + box.y) / 2, w: (b0.w + box.w) / 2, h: (b0.h + box.h) / 2 } : box;
    // Hold still: the most recent frames that agree with one another (the same test the server makes on an
    // enrollment), so one shaky frame drops out of the count instead of starting it over.
    st.steady.push({ f: this.cropAt(st.box, f.src), a });
    const need = this.purpose === "enroll" ? ENROLL_HOLD : VERIFY_HOLD;
    if (st.steady.length > need + 4) st.steady.shift();
    let group = [];
    for (const c of st.steady) {
      const agree = st.steady.filter(x => x === c || compare(c.a.features, x.a.features).score >= STEADY);
      if (agree.length > group.length) group = agree;
    }
    this.say("Hold still…", null, Math.min(1, group.length / need));
    if (group.length < need) return;
    st.vibe = footVibe(group[0].a.features);
    this.submit(group);
  }
  // Show a find-phase message. A new message has to come up on two ticks running before it replaces another one,
  // so the status doesn't flicker; progress on the current one shows at once.
  say(text, detail = null, meter = null) {
    const st = this.state;
    if (text !== st.status && st.status !== "Getting ready…") {
      st.nextSay = st.nextSay?.text === text ? { text, n: st.nextSay.n + 1 } : { text, n: 1 };
      if (st.nextSay.n < 2) return;
    }
    st.nextSay = null;
    this.setStatus(text, "", meter, detail);
  }
  // The hold is done: check the frames with exactly the analysis the server runs, and send only those that pass.
  // If too few do (the quick live check and the full-size one disagree), keep holding: no try is used up.
  submit(group) {
    const st = this.state;
    const pick = this.purpose === "enroll"
      ? Array.from({ length: ENROLL_SEND }, (_, i) => group[Math.round((i * (group.length - 1)) / (ENROLL_SEND - 1))])
      : group.slice(-VERIFY_HOLD);
    this.defer(this.analyst.order(pick.map(x => ({ w: x.f.w, h: x.f.h, px: x.f.rgba }))), full => {
      if (st.phase !== "find") return;
      const ok = pick.map((x, i) => ({ ...x, full: full[i] })).filter(x => x.full.ok);
      if (ok.length < (this.purpose === "enroll" ? 2 : 1)) {
        st.steady = st.steady.filter(x => !pick.includes(x));
        st.rejects = (st.rejects || 0) + 1;
        if (st.rejects >= 3) this.setStatus("Hold still…", "", 0, (full.find(r => !r.ok) || {}).message || null);
        return;
      }
      st.rejects = 0;
      if (this.purpose === "enroll") return this.upload(ok.map(x => x.f));
      // Logging in: the still frames go off to be matched, and the toe prompts start at once rather than after the
      // reply. The server compares the toes against the first frame that passes, so the wiggle here is measured
      // against that same frame; the toe frames are only sent once the server has said the foot matches. If it
      // doesn't, the prompts stop and the usual "No match" shows.
      st.matchRef = ok[0];
      this.beginWiggle(ok[0]);
      this.upload(ok.map(x => x.f), [], null, null, { match: true });
    });
  }
  beginWiggle(ref) {
    const st = this.state, g = ref.full.geo;
    st.wiggle = { w: ref.f.w, h: ref.f.h, box: ref.f.box, ball: this.footBall(g), step: 0, run: 0, blocked: 0, frames: [], seen: [], started: performance.now() };
    st.matched = false;
    st.onMatched = null;
    this.analyst.setRef({ R: grayFromRGBA(ref.f.rgba, ref.f.w, ref.f.h), w: ref.f.w, h: ref.f.h, geo: g, pivot: [g.cx, g.cy] });
    st.phase = "wiggle";
    this.setStatus("Curl your toes", "good", 0, "Keep your heel on the floor and curl your toes under.");
    this.renderSide();
  }
  // After a match: the toes follow cues (curl, relax, curl), judged on each full-size frame against the matched one
  // by the same code the server runs, so what passes here passes there. Each frame is first cut around the foot where
  // the live look finds it now (followBox), so the phone may drift; when the look fails, the last cut stands.
  tickWiggle(frame) {
    const st = this.state, w = st.wiggle;
    const job = this.analyst.analyze(frame.small, { usePrior: true, minToes: 1, fit: LIVE_FIT, quick: true }).then(a => {
      if (a.ok) w.box = this.followBox(a, frame, w);
      const f = this.cropAt(w.box, frame.src);
      if (f.w !== w.w || f.h !== w.h) return null;
      const G = grayFromRGBA(f.rgba, f.w, f.h), cue = w.step;
      return this.analyst.motion(G, f.w, f.h).then(r => ({ G, cue, r, f }));
    });
    this.defer(job, x => { if (x) this.toesSeen(x.G, x.cue, x.r.m, x.r.state, x.f); });
  }
  toesSeen(G, cue, m, state, f) {
    const st = this.state, w = st.wiggle;
    if (st.phase !== "wiggle") return;
    w.frames.push({ G, cue });
    w.seen.push([cue, state, Math.round(m.rest * 10) / 10, Math.round(m.toes * 10) / 10, Math.round(m.guard * 10) / 10]);
    w.blocked = state === "blocked" ? w.blocked + 1 : 0;
    w.run = state === CUES[w.step] ? w.run + 1 : 0;
    if (w.run >= LIVE.run) { w.step++; w.run = 0; }
    const done = w.step >= CUES.length;
    if (done || performance.now() - w.started > WIGGLE_TIMEOUT) {
      // Send the last few frames of each cue, in order: each cue's run is at its end. Not before the server has
      // confirmed the match, though: until then, "Checking…".
      const keep = [];
      for (let c = 0; c < CUES.length; c++) keep.push(...w.frames.filter(x => x.cue === c).slice(-WIGGLE_PER_CUE));
      const send = () => this.upload([], keep, f.w, f.h);
      if (st.matched) return send();
      st.phase = "upload";
      st.onMatched = send;
      return this.setStatus("Checking…");
    }
    const [text, how] = [
      ["Curl your toes", "Keep your heel on the floor and curl your toes under."],
      ["Now relax them", "Toes flat on the floor again."],
      ["Curl them again", "Once more: heel down, toes curled."],
    ][w.step];
    this.setStatus(text, "good", (w.step + w.run / LIVE.run) / CUES.length, w.blocked >= 2 ? "Something's moving near your toes. Keep hands and things out of the frame." : how);
  }
  // `match`: a login's still frames, sent while the toe prompts carry on; the reply only says whether the foot matched.
  async upload(stills, grays = [], gw, gh, { match = false } = {}) {
    const st = this.state, view = this.views[st.i], gen = st.gen;
    if (!match) {
      st.phase = "upload";
      this.setStatus("Checking…");
    }
    let r;
    try {
      r = await this.api.submitView(view.key, [
        ...stills.map(f => ({ w: f.w, h: f.h, format: "rgba", px: f.rgba })),
        ...grays.map(x => ({ w: gw, h: gh, format: "gray", px: x.G, cue: x.cue })),
      ]);
    } catch (e) {
      return this.fail(e.code, e.message);
    }
    if (st.gen !== gen || !st.running) return;
    if (this.collecting) {
      this.record(view.key, stills, grays, gw, gh, r);
      if (this.hasAttribute("tester")) this.sendTester();
    }
    if (r.matched) {
      // Step 1 passed: it's the right foot. The toes are already being watched; if they've finished, send them now.
      st.matched = true;
      this.react("yes", 900);
      if (st.onMatched) { const send = st.onMatched; st.onMatched = null; return send(); }
      return;
    }
    this.emit("piggyback-view", { key: view.key, ok: r.ok, reason: r.reason, message: r.message });
    if (!r.ok) {
      this.react(st.vibe <= VIBE.ugly ? "sick" : "no");
      this.ui.vf.classList.remove("shake");
      void this.ui.vf.offsetWidth;
      this.ui.vf.classList.add("shake");
      if (r.session_failed) return this.fail("session_failed", "Too many failed attempts. Start again.", r.exit_url);
      const short = { no_match: "No match", wrong_foot: "Wrong foot", no_movement: "Toes didn't follow", no_foot: "No foot found", unsteady: "Too shaky" }[r.reason] || "Try again";
      this.setStatus(`${short} · ${r.attempts_left} ${r.attempts_left === 1 ? "try" : "tries"} left`, "bad", null, r.message);
      st.phase = "pause";
      setTimeout(() => { if (st.running) this.beginView(); }, 1600);
      return;
    }
    view.ok = true;
    const lovely = st.vibe >= VIBE.lovely;
    this.react(lovely ? "flustered" : "yes");
    this.renderSide();
    this.ui.judge.dataset.ok = "";
    const next = this.views.findIndex(v => !v.ok);
    if (this.purpose === "enroll") {
      // Show what was saved and let the user check it before moving on, or redo it.
      this.frozen = this.snapshot(stills[0]);
      st.phase = "review";
      this.setStatus(`${view.side === "L" ? "Left" : "Right"} foot saved`, "good", 1, lovely ? "What a gorgeous foot. This is what was saved: redo it if it's cut off, blurry or not the right one." : null);
      // The heading already names the foot, so the buttons can stay one word.
      this.ui.next.textContent = next < 0 ? "Finish" : "Next";
      this.ui.next.classList.toggle("last", next < 0);
      this.ui.redo.textContent = "Redo";
      this.ui.next.hidden = this.ui.redo.hidden = false;
      return this.renderSide();
    }
    this.setStatus("Matched", "good", 1, lovely ? "What a gorgeous foot." : null);
    st.phase = "pause";
    if (next < 0) return this.finish();
    setTimeout(() => { if (st.running) { st.i = next; this.beginView(); } }, 950);
  }
  // ---------- Debug and tester mode: what the scanner saw, to tune it on real feet ----------
  // The live check's verdicts, a few frames it couldn't make sense of, a frame a second whatever it decided, and every
  // upload with the server's answer. With `debug` they stay in memory until the user saves them as a file; with
  // `tester` they're also sent to the server after each try (POST /v1/session/tester), which keeps them for 30 days.
  get collecting() { return this.hasAttribute("debug") || this.hasAttribute("tester"); }
  get log() { return (this.scanLog ||= { trail: [], misses: [], samples: [], uploads: [] }); }
  trace(a, fs) {
    const d = this.log, now = Math.round(performance.now()), code = a.ok ? "ok" : a.code;
    d.trail.push([now, code, this.state.status, Math.round((this.state.meter || 0) * 100)]);
    if (d.trail.length > 600) d.trail.shift();
    if (!a.ok && a.code !== "none" && now - (d.lastMiss || 0) > 1000) {
      d.lastMiss = now;
      d.misses.push({ at: now, code, w: fs.w, h: fs.h, rgba: b64(fs.rgba) });
      if (d.misses.length > 8) d.misses.shift();
    }
    if (now - (d.lastSample || 0) > 1000) {
      d.lastSample = now;
      d.samples.push({ at: now, code, w: fs.w, h: fs.h, rgba: b64(fs.rgba) });
      if (d.samples.length > 12) d.samples.shift();
    }
  }
  sendTester(extra = {}) {
    const d = this.scanLog;
    if (!d || !this.api?.tester || !(d.trail.length || d.uploads.length)) return;
    const scan = { version: 1, ua: navigator.userAgent, mode: this.getAttribute("mode") || "page", view: this.views[this.state.i]?.key, ...extra, trail: d.trail, misses: d.misses, samples: d.samples, uploads: d.uploads };
    // Each try is sent once; a debug save afterwards still has everything.
    if (!this.hasAttribute("debug")) this.scanLog = null;
    else this.scanLog = { ...d, trail: [], misses: [], samples: [], uploads: [], sent: (d.sent || []).concat([scan]) };
    this.api.tester(scan).catch(() => {});
  }
  record(key, stills, grays, gw, gh, r) {
    const d = this.log;
    d.uploads.push({
      at: Math.round(performance.now()), key, purpose: this.purpose, result: r, toes: grays.length ? this.state.wiggle?.seen : undefined,
      stills: stills.map(f => ({ w: f.w, h: f.h, rgba: b64(f.rgba) })),
      grays: grays.map(x => ({ w: gw, h: gh, cue: x.cue, gray: b64(x.G) })),
    });
    if (d.uploads.length > 6) d.uploads.shift();
    if (this.hasAttribute("debug")) this.ui.save.hidden = false;
  }
  saveScan() {
    const { sent = [], ...now } = this.scanLog || {};
    const blob = new Blob([JSON.stringify({ version: 1, ua: navigator.userAgent, saved: new Date().toISOString(), ...now, earlier: sent })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `piggyback-scan-${Date.now()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  // The frame that was saved, kept on screen while the user reviews it.
  snapshot(f) {
    const c = document.createElement("canvas");
    const src = this.shown, sw = src?.videoWidth || src?.width, sh = src?.videoHeight || src?.height;
    if (!sw || !sh) return null;
    c.width = sw; c.height = sh;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }
  nextView() {
    this.ui.next.hidden = this.ui.redo.hidden = true;
    this.frozen = null;
    const next = this.views.findIndex(v => !v.ok);
    if (next < 0) return this.finish();
    this.state.i = next;
    this.beginView();
  }
  async redoView() {
    const st = this.state, view = this.views[st.i];
    this.ui.next.hidden = this.ui.redo.hidden = true;
    try { await this.api.resetView(view.key); } catch (e) { return this.fail(e.code, e.message); }
    view.ok = false;
    this.frozen = null;
    this.beginView();
  }
  async finish() {
    // A phone scanning for a computer stops here: the computer that showed the code finishes the sign-in.
    if (this.getAttribute("mode") === "phone") {
      this.showDone("All done");
      return this.emit("piggyback-handoff-done", {});
    }
    try {
      const r = await this.api.complete();
      this.showDone(this.purpose === "enroll" ? "Enrolled" : "Verified", { leaving: !!r.redirect_to });
      this.emit("piggyback-complete", { code: r.code, redirect_to: r.redirect_to });
    } catch (e) {
      this.fail(e.code, e.message);
    }
  }
  // The finished state holds: a full border and the judge keeps his check.
  showDone(status, { leaving = false } = {}) {
    this.stop();
    this.ui.alt.hidden = this.ui.fresh.hidden = this.ui.next.hidden = this.ui.redo.hidden = true;
    this.state.phase = "done";
    this.setStatus(status, "good done");
    this.renderSide();
    this.eased = 1;
    this.ui.judge.dataset.ok = "";
    // What happened, as a short checklist.
    const side = v => (v.side === "L" ? "Left" : "Right");
    const app = this.appName || "the app";
    const rows = this.purpose === "enroll"
      ? [...this.views.map(v => `${side(v)} foot saved`), this.getAttribute("mode") === "phone" ? "Handed back to your computer" : "Ready for your next sign-in"]
      : [...this.views.map(v => `${side(v)} foot matched`), "Toes moved", this.getAttribute("mode") === "phone" ? "Handed back to your computer" : `Sent to ${app}`];
    this.ui.doneList.className = "done-list";
    this.ui.doneList.innerHTML = rows.map(r => `<li>${r.replace(/[&<>]/g, c => `&#${c.charCodeAt(0)};`)}</li>`).join("");
    this.ui.doneList.hidden = false;
    this.ui.leaving.hidden = !leaving;
    if (leaving) this.ui.leaving.querySelector("span").textContent = `Taking you back to ${app}…`;
    // A burst of confetti from the judge.
    const j = this.ui.judge;
    j.querySelectorAll(".burst i").forEach((el, i) => {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4, d = 70 + Math.random() * 60;
      el.style.setProperty("--x", `${Math.cos(a) * d}px`);
      el.style.setProperty("--y", `${Math.sin(a) * d - 60}px`);
      el.style.setProperty("--r", `${Math.round(Math.random() * 540 - 270)}deg`);
    });
    delete j.dataset.celebrate;
    void j.offsetWidth;
    j.dataset.celebrate = "";
    this.draw();
  }

  // ---------- Continue on your phone ----------
  // A computer's webcam can't see feet. Show a QR code that opens this session on a phone, follow the phone's
  // progress, and finish here once every view has passed there.
  get canHandOff() {
    if (this.getAttribute("mode") === "phone" || this.getAttribute("handoff") === "off" || !(this.api?.canHandOff ?? typeof this.api?.handoff === "function")) return false;
    return this.getAttribute("handoff") === "on" || !(matchMedia("(pointer: coarse)").matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent));
  }
  async handOff({ fresh = false } = {}) {
    if (!this.purpose) await this.loadSession();
    if (!this.purpose) return;
    this.stop();
    this.frozen = null;
    delete this.ui.judge.dataset.ok;
    let h;
    try { h = await this.api.handoff(fresh, { debug: this.hasAttribute("debug"), tester: this.hasAttribute("tester") }); } catch (e) { return this.fail(e.code, e.message); }
    this.ui.start.hidden = true;
    this.ui.alt.hidden = false;
    this.ui.fresh.hidden = !h.attached;
    if (h.attached) {
      // Straight to the paired phone: it asks the user to continue, then scans.
      this.qr = this.handoffUrl = null;
      Object.assign(this.state, { phase: "handoff", handoff: "offered" });
      this.setStatus("Tap Continue on your phone");
      this.renderSide();
      this.animate();
      this.pollTimer = setTimeout(() => this.poll(), POLL);
      return;
    }
    // Demos pass the drawn sample feet along, so the phone page uses them too.
    const extra = [this.getAttribute("source") === "sample" && `source=sample&who=${encodeURIComponent(this.getAttribute("sample-who") || "you")}`, this.hasAttribute("debug") && "debug=1", this.hasAttribute("tester") && "tester=1"].filter(Boolean);
    const sample = extra.length ? `#${extra.join("&")}` : "";
    this.handoffUrl = h.url + sample;
    this.qr = qrEncode(this.handoffUrl);
    this.handoffExpires = Date.parse(h.expires_at);
    Object.assign(this.state, { phase: "handoff", handoff: "waiting" });
    this.setStatus("Waiting for your phone…");
    this.renderSide();
    this.animate();
    this.pollTimer = setTimeout(() => this.poll(), POLL);
  }
  async poll() {
    const st = this.state;
    if (st.phase !== "handoff") return;
    try {
      const s = await this.api.getSession();
      if (st.phase !== "handoff") return;
      for (const v of s.views) { const mine = this.views.find(x => x.key === v.key); if (mine) mine.ok = v.ok; }
      if (s.views.every(v => v.ok)) return this.finish();
      if (s.handoff?.state === "claimed" && st.handoff !== "claimed") {
        st.handoff = "claimed";
        this.qr = this.handoffUrl = null;
        this.setStatus("Scanning on your phone…");
      } else if (s.handoff?.state === "waiting" && Date.now() > this.handoffExpires - 5000) {
        return this.handOff();  // a fresh code before this one runs out
      }
      this.renderSide();
    } catch (e) {
      if (e.code === "session_failed" || e.code === "invalid_session") return this.fail(e.code, e.message, e.exitUrl);
    }
    this.pollTimer = setTimeout(() => this.poll(), POLL);
  }

  // ---------- Drawing ----------
  // The heading and the line under it, for where the user is.
  sideText(view) {
    const st = this.state, enroll = this.purpose === "enroll", phone = this.getAttribute("mode") === "phone";
    if (st.phase === "review") return [`Check your ${view.side === "L" ? "left" : "right"} foot`, "This is what was saved. Redo it if the foot is cut off, blurry or not the right one."];
    if (st.phase === "failed") {
      const app = this.appName || "the app";
      return this.failCode === "invalid_session"
        ? ["This sign-in has expired", `Sign-ins last 10 minutes. ${this.exitUrl ? `Head back to ${app}` : `Go back to ${app}`} and start a new one.`]
        : ["No luck this time", `Five tries without a match, so this sign-in is closed. ${this.exitUrl ? `Head back to ${app} for a fresh start.` : `Start again from ${app}.`} A few things that help:`];
    }
    if (st.phase === "done") {
      if (phone) return ["You can put your phone down", "Your computer is finishing the sign-in."];
      if (enroll) return ["You're all set", "Next time you sign in, show one foot, then curl your toes when asked."];
      return ["Welcome back", "Your feet checked out. Nice toes."];
    }
    if (st.phase === "handoff") {
      return ["Continue on your phone", st.handoff === "offered" ? "Your phone takes this step too: tap Continue on it. This page carries on by itself once it's done."
        : st.handoff === "claimed" ? "Follow the steps on your phone. This page carries on by itself once they're done."
        : "Point your phone's camera at the code and open the link. You'll scan your feet there, and this page carries on by itself."];
    }
    if (view) return [view.title, view.how];
    return enroll ? ["Enroll your feet", "The camera looks at the top of each foot, one after the other. Socks off, on a plain floor."]
      : ["Verify with your feet", `Show the camera ${this.views.length === 1 ? "the foot it asks for" : "the feet it asks for"}. When it matches, keep your heel down and curl your toes when asked.`];
  }
  renderSide() {
    const st = this.state, view = st.running ? this.views[st.i] : null;
    [this.ui.title.textContent, this.baseHow] = this.sideText(view);
    // In the lens: which foot to show now (or which one was just saved).
    const lensView = st.phase === "find" || st.phase === "wiggle" || st.phase === "upload" || st.phase === "review" ? view : null;
    this.ui.which.hidden = !lensView;
    if (lensView) {
      const side = lensView.side === "L" ? "Left" : "Right";
      this.ui.which.querySelector("b").textContent = lensView.side;
      this.ui.which.querySelector("span").innerHTML = st.phase === "review" ? `${side} foot <small>saved</small>` : `${side} foot <small>· top</small>`;
    }
    this.ui.how.textContent = st.detail || this.baseHow;
    // "Step 1 of 2" while there's more than one foot to show; the line round the lens carries the progress itself.
    const at = st.running ? st.i : this.views.findIndex(v => !v.ok);
    const showStep = this.views.length > 1 && at >= 0 && st.phase !== "done" && st.phase !== "failed" && !(st.phase === "handoff" && st.handoff !== "claimed");
    this.ui.eyebrow.hidden = !showStep;
    if (showStep) this.ui.eyebrow.textContent = `Step ${at + 1} of ${this.views.length}`;
  }
  // The lens shows the guide area of the camera, like Face ID's circle; the border around it (drawRing) does the talking.
  draw(t = performance.now()) {
    const { canvas, st: stEl, status } = this.ui, st = this.state;
    stEl.textContent = st.status;
    status.className = `status ${st.tone}${st.running || st.phase === "handoff" ? " live" : ""}`;
    const dt = Math.min(0.1, Math.max(0, (t - (this.lastT || t)) / 1000));
    this.lastT = t;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // While a phone scans for this computer, the line shows how many of the views have passed there.
    const target = st.phase === "handoff" ? this.views.filter(v => v.ok).length / (this.views.length || 1)
      : st.tone === "good" && st.phase !== "wiggle" && st.phase !== "find" ? 1 : st.running ? st.meter || 0 : 0;
    // Progress only ever moves forward. When it has to start over (the foot moved, or the wiggle begins),
    // the old fill fades out instead of running backwards.
    const now = this.eased || 0;
    if (still || st.phase === "done") { this.eased = target; this.fading = 0; }
    else if (this.fading) { this.fading = Math.max(0, this.fading - dt * 4); if (!this.fading) this.eased = 0; }
    else if (now > 0.02 && target < now - 0.15) this.fading = 1;
    else if (target > now) this.eased = now + (target - now) * Math.min(1, dt * 8);

    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight, W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (!w || !h) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const edge = screenShape(w, h);
    g.save();
    tracePath(g, edge.pts);
    g.clip();
    g.fillStyle = "#2B2F38";
    g.fillRect(0, 0, w, h);
    // The full guide frame fits the lens height; a little of the camera shows either side of it.
    const src = this.frozen || this.shown, gw = h * GUIDE, gx = (w - gw) / 2;
    let map = null;
    if (src) {
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      if (sw && sh) {
        const roi = roiFor(sw, sh), s = h / roi.h, ox = (w - roi.w * s) / 2;
        g.drawImage(src, ox - roi.x * s, -roi.y * s, sw * s, sh * s);
        map = geo => { const k = (roi.w / geo.w) * s; return [x => ox + x * k, y => y * k, k]; };
      }
    }
    // Soft vignette so the edge of the lens feels like glass.
    const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.6);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.28)");
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);

    const a = st.running ? st.last : null;
    if (this.qr) this.drawQr(g, w, h);
    else if (st.phase === "handoff") this.drawFootGuide(g, gx, h * 0.06, gw, h * 0.88, this.views[Math.max(0, this.views.findIndex(v => !v.ok))], still ? 0 : t);
    else if (!a && (st.running || !src)) this.drawFootGuide(g, gx, h * 0.06, gw, h * 0.88, this.views[st.i], st.running && !still ? t : 0);
    // Where to lift: soft pink ripples at the toes while the cue says up.
    // debug: the outline the scanner sees, and a dot where it thinks the toes are.
    if (this.hasAttribute("debug") && a?.geo && map) this.drawOutline(g, a.geo, map);
    const geo = st.phase === "wiggle" && CUES[st.wiggle.step] === "up" ? a?.geo : null;
    if (geo && map) {
      const [px, py, k] = map(geo), len = geo.umax - geo.umin, u = geo.umin + 0.9 * len;
      const cx = px(geo.cx + u * geo.ex), cy = py(geo.cy + u * geo.ey), base = len * k * 0.2;
      for (const off of still ? [0.5] : [0, 0.5]) {
        const ph = still ? 0.5 : (t / 1100 + off) % 1;
        g.globalAlpha = (1 - ph) * 0.8;
        g.lineWidth = 2.5;
        g.strokeStyle = "#FF8FB1";
        g.beginPath();
        g.arc(cx, cy, base * (0.7 + ph * 1.3), 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    g.restore();
    this.drawRing(t, still);
  }
  // A thin line a few px outside the lens, the same shape. It fills clockwise from the top as the foot holds still
  // (green) or the toes wiggle (pink), and turns all red on a miss.
  drawRing(t, still) {
    const st = this.state, c = this.ui.ring, lens = this.ui.canvas.parentElement;
    const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W / dpr, H / dpr);
    const lw = 3, gap = 6 + lw / 2, w = lens.clientWidth, h = lens.clientHeight;
    const ring = screenShape(w + gap * 2, h + gap * 2, w * 0.2 + gap);
    // The ring canvas overhangs the lens by RING px on every side.
    g.translate(RING - gap, RING - gap);
    // Theme colours, so the line always matches the status chip and the rest of the page.
    const css = getComputedStyle(this), color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const lit = st.tone === "bad" ? color("--pb-bad", "#D93A2B") : st.phase === "wiggle" ? color("--pb-pink", "#FF8FB1") : color("--pb-good", "#4CD992");
    const fill = st.tone === "bad" ? 1 : this.eased || 0;
    g.lineWidth = lw;
    g.lineCap = "round";
    g.lineJoin = "round";
    tracePath(g, ring.pts);
    g.strokeStyle = matchMedia("(prefers-color-scheme: dark)").matches ? "rgba(255,255,255,.14)" : "rgba(20,22,26,.1)";
    g.stroke();
    if (fill > 0.002) {
      g.setLineDash(fill >= 0.98 ? [] : [ring.total * fill, ring.total]);
      // Green and pink sit a little translucent so a thin line reads as light as the filled shapes; red stays full.
      g.globalAlpha = st.tone === "bad" ? 1 : 0.7 * (this.fading || 1);
      g.strokeStyle = lit;
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
  }
  // The handoff QR code on a white card in the middle of the lens: rounded finder corners, softly rounded modules,
  // and the pig in the middle (QR error correction covers the few modules it hides).
  drawQr(g, w, h) {
    const q = this.qr, n = q.size, side = Math.min(w * 0.78, h * 0.5), x = (w - side) / 2, y = h * 0.44 - side / 2;
    g.save();
    g.shadowColor = "rgba(0,0,0,.25)";
    g.shadowBlur = 18;
    g.shadowOffsetY = 6;
    g.fillStyle = "#FFFFFF";
    g.beginPath();
    g.roundRect(x, y, side, side, side * 0.09);
    g.fill();
    g.restore();
    const quiet = side * 0.08, m = (side - quiet * 2) / n, ox = x + quiet, oy = y + quiet;
    const finder = (c, r) => c < 7 && r < 7 ? [0, 0] : c >= n - 7 && r < 7 ? [n - 7, 0] : c < 7 && r >= n - 7 ? [0, n - 7] : null;
    // The logo covers a small square in the middle; keep it under 6% of the code.
    const logo = Math.max(5, Math.round(n * 0.22) | 1), l0 = (n - logo) / 2;
    g.fillStyle = "#14161A";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (!q.dark(c, r) || finder(c, r) || (c >= l0 && c < l0 + logo && r >= l0 && r < l0 + logo)) continue;
      g.beginPath();
      g.roundRect(ox + c * m + 0.15, oy + r * m + 0.15, m - 0.1, m - 0.1, m * 0.22);
      g.fill();
    }
    for (const [c, r] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      const fx = ox + c * m, fy = oy + r * m;
      g.beginPath();
      g.roundRect(fx, fy, 7 * m, 7 * m, m * 2);
      g.roundRect(fx + m, fy + m, 5 * m, 5 * m, m * 1.4);
      g.fill("evenodd");
      g.beginPath();
      g.roundRect(fx + 2 * m, fy + 2 * m, 3 * m, 3 * m, m * 0.9);
      g.fill();
    }
    const ls = logo * m, lx = ox + l0 * m, ly = oy + l0 * m;
    g.fillStyle = "#FFFFFF";
    g.beginPath();
    g.roundRect(lx, ly, ls, ls, ls * 0.28);
    g.fill();
    if (this.pigImg.complete) g.drawImage(this.pigImg, lx + ls * 0.08, ly + ls * 0.08, ls * 0.84, ls * 0.84);
  }
  drawOutline(g, geo, map) {
    const [px, py, k] = map(geo), c = geo.contour;
    g.fillStyle = "rgba(255,214,107,.9)";
    for (let i = 0; i < c.length; i += 2) g.fillRect(px(c[i] + 0.5) - k / 2, py(c[i + 1] + 0.5) - k / 2, k, k);
    const tip = geo.umax - 0.08 * (geo.umax - geo.umin);
    g.fillStyle = "#FF5C8A";
    g.beginPath();
    g.arc(px(geo.cx + tip * geo.ex), py(geo.cy + tip * geo.ey), 6, 0, Math.PI * 2);
    g.fill();
  }
  // Soft outline of the foot the step asks for, mirrored for left and right.
  // It breathes gently while the camera looks.
  drawFootGuide(g, rx, ry, rw, rh, view, t) {
    const fh = rh * 0.9, k = fh / 80, cx = rx + rw / 2, cy = ry + rh / 2;
    const flip = view?.side === "L";
    const breathe = t ? 0.5 + 0.5 * Math.sin(t / 700) : 0.5;
    g.save();
    g.translate(cx, cy);
    g.scale(flip ? -k : k, k);
    g.translate(-20, -40);
    g.lineWidth = 2 / k;
    g.lineJoin = "round";
    // Once everything has passed (say, on a phone), the outline turns green.
    const done = this.state.phase === "done", good = getComputedStyle(this).getPropertyValue("--pb-good").trim() || "#4CD992";
    g.shadowColor = done ? good : "rgba(255,255,255,.35)";
    g.shadowBlur = 10;
    g.strokeStyle = done ? good : `rgba(255,255,255,${0.45 + 0.25 * breathe})`;
    g.fillStyle = done ? withAlpha(good, 0.16) : `rgba(255,255,255,${0.06 + 0.04 * breathe})`;
    g.beginPath();
    g.moveTo(6, 23);
    g.bezierCurveTo(4, 33, 12, 41, 13, 50);
    g.bezierCurveTo(14, 58, 9, 64, 11, 71);
    g.bezierCurveTo(13, 79, 27, 80, 29, 72);
    g.bezierCurveTo(31, 64, 33, 58, 33, 50);
    g.bezierCurveTo(33, 42, 37, 36, 35, 29);
    g.bezierCurveTo(34, 21, 10, 16, 6, 23);
    g.closePath();
    for (const [x, y, rxx, ryy] of [[10.5, 12, 4.8, 6], [19, 10.5, 3.3, 4.1], [25.6, 12, 3, 3.7], [30.9, 15.6, 2.7, 3.3], [34.6, 21, 2.3, 2.8]]) {
      g.moveTo(x + rxx, y);
      g.ellipse(x, y, rxx, ryy, 0, 0, Math.PI * 2);
    }
    g.fill();
    g.stroke();
    g.restore();
  }
}
if (!customElements.get("piggyback-auth")) customElements.define("piggyback-auth", PiggybackAuth);
