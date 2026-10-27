// "Piggy Bank": a pretend app that adds Piggyback as its second factor, password first, then feet.
// It shows both integrations: redirect to the hosted page (/mfa) and the embedded element (/mfa/embedded).
//
//   FEET_URL=http://localhost:8787 CLIENT_ID=… CLIENT_SECRET=… node examples/demo-app/server.js
//   Sign in with any username and the password "demo". Add ?sample=you|impostor|photo to /mfa to use drawn feet,
//   ?debug to the sign-in page for the scanner's debug mode, ?tester for tester mode (scans sent to improve detection).
import http from "node:http";
import crypto from "node:crypto";
import { verifyJwt } from "../../server/jwt.js";

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const FEET_URL = (process.env.FEET_URL || "http://localhost:8787").replace(/\/$/, "");
const { CLIENT_ID, CLIENT_SECRET } = process.env;
const COOKIE = `HttpOnly; SameSite=Lax; Path=/${APP_URL.startsWith("https:") ? "; Secure" : ""}`;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Set CLIENT_ID and CLIENT_SECRET (node server/cli.js add-client …).");

const sessions = new Map(); // cookie → { user, mfa, state, sample, claims }
const visits = new Map();   // user → sign-ins with feet since this app started, for the dashboard
const basic = "Basic " + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64");

// ---------- Calls to the Piggyback service ----------
async function feet(method, path, body) {
  const res = await fetch(FEET_URL + path, { method, headers: { authorization: basic, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  // A web page instead of JSON usually means the feet service is restarting (a host's error page) or FEET_URL is wrong.
  const data = await res.json().catch(() => {
    throw new Error(`Piggyback didn't answer properly (HTTP ${res.status} from ${FEET_URL}). It may be restarting: try again in a minute.`);
  });
  if (!res.ok && res.status !== 404) throw new Error(`${path}: ${data.error} ${data.message || ""}`);
  return data;
}
let jwks = null;
async function checkResult(code, user) {
  const { result_token } = await feet("POST", "/v1/token", { code });
  jwks ||= await (await fetch(`${FEET_URL}/.well-known/jwks.json`)).json();
  const claims = verifyJwt(result_token, jwks, { issuer: FEET_URL, audience: CLIENT_ID });
  if (claims.sub !== user) throw new Error("The result is for a different user.");
  return claims;
}
const startSession = (user, purpose, redirect) =>
  feet("POST", "/v1/sessions", { user_id: user, purpose, ...(redirect && { redirect_uri: `${APP_URL}/mfa/callback`, state: redirect }) });

// ---------- Tiny web app ----------
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Piggy Bank borrows Piggyback's ui/ kit and pig from the feet service, so the whole flow looks of a piece.
const LOGO = `<svg viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="pbk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF9BBC"/><stop offset="1" stop-color="#E5578A"/></linearGradient></defs><rect width="36" height="36" rx="11" fill="url(#pbk)"/><circle cx="18" cy="13.5" r="6.5" fill="#FFD36B" stroke="#E0A93A" stroke-width="1.6"/><path d="M18 10.5v6" stroke="#E0A93A" stroke-width="1.6" stroke-linecap="round"/><rect x="9.5" y="23" width="17" height="3.6" rx="1.8" fill="#fff" opacity=".92"/></svg>`;
const page = (title, body, { wide = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · Piggy Bank</title>
<link rel="stylesheet" href="${FEET_URL}/ui/tokens.css"><link rel="stylesheet" href="${FEET_URL}/ui/controls.css"><link rel="stylesheet" href="${FEET_URL}/ui/page.css">
<style>
.brand{display:inline-flex;align-items:center;gap:10px;font-size:20px;font-weight:700;letter-spacing:-.01em;color:var(--pb-ink);text-decoration:none}
.brand svg{width:36px;height:36px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.who{display:flex;align-items:center;gap:10px;color:var(--pb-muted);font-size:14px}
.row{display:flex;flex-wrap:wrap;gap:8px}.row form{margin:0}
.lead{margin:6px 0 0;color:var(--pb-muted)}
/* Dashboard: cards on the left, the pig on the right pointing at them. */
.dash{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:18px;align-items:center}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.card{display:grid;gap:8px;align-content:start;padding:18px}
.card h2{margin:0;color:var(--pb-muted);font-size:13px;font-weight:600}
.big{font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1}
.big small{font-size:15px;font-weight:600;color:var(--pb-muted);letter-spacing:0}
.bar{height:8px;border-radius:99px;background:var(--pb-glass-line);overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--pb-green),#2FC46F)}
.muted{color:var(--pb-muted);font-size:13px}
.pig{position:relative;display:grid;justify-items:center}
.pig img{width:210px;margin-left:-28px;filter:drop-shadow(0 18px 24px rgba(20,22,26,.22))}
.bubble{position:relative;margin-bottom:10px;padding:10px 14px;border:1px solid var(--pb-glass-edge);border-radius:18px;background:var(--pb-paper);box-shadow:0 0 0 1px var(--pb-glass-line),var(--pb-lift);font-weight:600;font-size:14px;text-align:center}
/* The bubble sits over the pig's head, its tail down towards it; the pig's hoof does the pointing. */
.bubble::after{content:"";position:absolute;left:50%;bottom:-9px;width:16px;height:16px;background:var(--pb-paper);border-right:1px solid var(--pb-glass-line);border-bottom:1px solid var(--pb-glass-line);transform:translateX(-50%) rotate(45deg)}
details summary{cursor:pointer;color:var(--pb-muted);font-size:14px;font-weight:600}
details .pb-code{margin-top:10px}
@media (max-width:700px){.dash{grid-template-columns:1fr}.pig{order:-1}.pig img{width:140px;margin-left:0}.cards{grid-template-columns:1fr}}
</style></head><body class="pb-backdrop"><main class="pb-page${wide ? " wide" : ""}">${body}</main></body></html>`;
const brand = `<a class="brand" href="/">${LOGO}Piggy Bank</a>`;
const problem = (title, text, href, label, extra = "") => `${brand}<div class="pb-panel"><h1 class="pb-title">${title}</h1><p class="pb-text">${text}</p><div class="row"><a class="pb-btn${extra ? "" : " secondary"}" href="${href}">${label}</a>${extra}</div></div>`;
const switchUser = `<a class="pb-btn secondary" href="/logout">Sign in as someone else</a>`;
const html = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(body); };
const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
const readForm = req => new Promise(r => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => r(Object.fromEntries(new URLSearchParams(b)))); });
const readJson = req => new Promise(r => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { try { r(JSON.parse(b)); } catch { r({}); } }); });

// The signed-in page: what Piggyback verified, in cards, with the pig pointing at them. The savings are made up.
async function dashboard(s) {
  const c = s.claims, info = await feet("GET", `/v1/users/${encodeURIComponent(s.user)}`);
  const [key, view] = Object.entries(c.views)[0] || [];
  const foot = key ? `${key.startsWith("L") ? "Left" : "Right"} foot` : "Your foot";
  const score = Math.round((view?.score || 0) * 100);
  const since = info.enrolled_at ? new Date(info.enrolled_at).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }) : "today";
  const at = new Date(c.auth_time * 1000).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
  const oinks = 1000 + (parseInt(crypto.createHash("sha256").update(s.user).digest("hex").slice(0, 4), 16) % 9000);
  return `<div class="top">${brand}<div class="who">Signed in as <b>${esc(s.user)}</b><a class="pb-btn secondary small" href="/logout">Sign out</a></div></div>
    <div><p class="pb-eyebrow">Dashboard</p><h1 class="pb-title">Welcome back, ${esc(s.user)}</h1><p class="lead">Your password and your feet both checked out.</p></div>
    <div class="dash">
      <div class="cards">
        <section class="pb-panel card"><h2>This sign-in</h2>
          <div class="big">${score}%<small> match</small></div>
          <div class="bar"><i style="width:${score}%"></i></div>
          <div class="row"><span class="pb-chip good dot">${foot}</span>${view?.live ? `<span class="pb-chip good dot">Toes wiggled</span>` : ""}</div>
          <span class="muted">Checked at ${at}</span></section>
        <section class="pb-panel card"><h2>Your feet on file</h2>
          <div class="big">${info.views.length}<small> ${info.views.length === 1 ? "foot" : "feet"}</small></div>
          <div class="row">${info.views.map(k => `<span class="pb-chip dot">${k.startsWith("L") ? "Left" : "Right"} top</span>`).join("")}</div>
          <span class="muted">Enrolled ${esc(since)}</span>
          <form method="post" action="/account/remove-feet"><button class="pb-btn danger small">Remove my enrolled feet</button></form></section>
        <section class="pb-panel card"><h2>Security</h2>
          <div class="row"><span class="pb-chip good dot">Password</span><span class="pb-chip good dot">Feet</span>${c.amr.includes("liveness") ? `<span class="pb-chip good dot">Toe wiggle</span>` : ""}</div>
          <span class="muted">${visits.get(s.user) || 1} sign-in${(visits.get(s.user) || 1) === 1 ? "" : "s"} with your feet. Level: ${esc(c.acr)}</span></section>
        <section class="pb-panel card"><h2>Savings (pretend)</h2>
          <div class="big">${oinks.toLocaleString("en-CA")}<small> oinks</small></div>
          <span class="muted">Safe and sound, guarded by ten little toes.</span></section>
      </div>
      <div class="pig"><div class="bubble">Look, ${score}% match!<br>Those feet are yours.</div><img src="${FEET_URL}/brand/mascot-point.png" alt="The Piggyback pig, pointing at your feet data"></div>
    </div>
    <details><summary>Verified result token</summary><pre class="pb-code" id="claims">${esc(JSON.stringify(c, null, 2))}</pre></details>`;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL);
  const sid = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || "")?.[1];
  const s = sid && sessions.get(sid);
  // ?debug anywhere turns on the scanner's debug mode (outline, "Save this scan for debugging") for this sign-in;
  // ?tester, tester mode (what the camera sees is sent to Piggyback to improve detection).
  if (s && url.searchParams.has("debug")) s.debug = true;
  if (s && url.searchParams.has("tester")) s.tester = true;
  try {
    if (req.method === "POST" && url.pathname === "/login") {
      const f = await readForm(req);
      if (!f.username || f.password !== "demo") return html(res, 401, page("Sign in", problem("Wrong password", `It's "demo".`, "/", "Try again")));
      const id = crypto.randomBytes(18).toString("base64url");
      sessions.set(id, { user: f.username.trim().toLowerCase(), mfa: false, debug: !!f.debug, tester: !!f.tester });
      const next = f.sample ? `/mfa?sample=${encodeURIComponent(f.sample)}` : "/mfa";
      return redirect(res, next, { "set-cookie": `sid=${id}; ${COOKIE}` });
    }
    if (url.pathname === "/logout") { sessions.delete(sid); return redirect(res, "/", { "set-cookie": `sid=; Max-Age=0; ${COOKIE}` }); }
    if (!s) return html(res, 200, page("Sign in", `${brand}<form class="pb-panel" method="post" action="/login"><p class="pb-eyebrow">Step 1 of 2 · Password</p><h1 class="pb-title">Sign in to Piggy Bank</h1>
      <p class="pb-text">A pretend bank that asks for your feet after your password. Any name works.</p>
      <label class="pb-label">Username<input class="pb-input" name="username" placeholder="Enter anything" autocomplete="username" required></label>
      <label class="pb-label">Password<input class="pb-input" name="password" type="password" placeholder="Enter demo" autocomplete="current-password" required></label>
      ${url.searchParams.has("debug") ? `<input type="hidden" name="debug" value="1"><p class="pb-chip dot">Debug mode</p>` : ""}
      ${url.searchParams.has("tester") ? `<input type="hidden" name="tester" value="1"><p class="pb-chip dot">Tester mode</p>` : ""}
      ${url.searchParams.get("sample") ? `<input type="hidden" name="sample" value="${esc(url.searchParams.get("sample"))}"><p class="pb-chip dot">Using sample feet: ${esc(url.searchParams.get("sample"))}</p>` : ""}
      <button class="pb-btn block">Continue</button></form>`));

    // Second factor, redirect flow: send the user to the hosted page, come back to /mfa/callback.
    if (url.pathname === "/mfa") {
      if (url.searchParams.get("sample")) s.sample = url.searchParams.get("sample");
      const { enrolled } = await feet("GET", `/v1/users/${encodeURIComponent(s.user)}`);
      s.state = crypto.randomBytes(16).toString("base64url");
      const r = await startSession(s.user, enrolled ? "verify" : "enroll", s.state);
      return redirect(res, r.hosted_url + (s.sample ? `&source=sample&who=${encodeURIComponent(s.sample)}` : "") + (s.debug ? "&debug=1" : "") + (s.tester ? "&tester=1" : ""));
    }
    if (url.pathname === "/mfa/callback") {
      // Piggyback sends people back with error=access_denied after too many tries (or if they cancel).
      if (url.searchParams.get("error")) {
        s.state = null;
        const cancelled = /cancel/i.test(url.searchParams.get("error_description") || "");
        return html(res, 200, page("Try again", cancelled
          ? problem("Sign-in cancelled", `You stopped the feet check for ${esc(s.user)}.`, "/mfa", "Try again", switchUser)
          : problem("No luck with those feet", "Too many tries without a match. Have another go: a contrasting floor and good light help.", "/mfa", "Try again", switchUser)));
      }
      if (!s.state || url.searchParams.get("state") !== s.state) return html(res, 400, page("Error", problem("Something didn't line up", "The sign-in state doesn't match. Start the second step again.", "/mfa", "Start again")));
      s.state = null;
      const claims = await checkResult(url.searchParams.get("code"), s.user);
      // A fresh enrollment is followed by a real verification.
      if (claims.purpose === "enroll") return redirect(res, "/mfa");
      Object.assign(s, { mfa: true, claims });
      visits.set(s.user, (visits.get(s.user) || 0) + 1);
      return redirect(res, "/");
    }
    // Second factor, embedded flow: the element runs inside this page and posts the code back here.
    if (url.pathname === "/mfa/embedded") {
      const { enrolled } = await feet("GET", `/v1/users/${encodeURIComponent(s.user)}`);
      const r = await startSession(s.user, enrolled ? "verify" : "enroll");
      const sample = url.searchParams.get("sample");
      return html(res, 200, page("Second step", `${brand}<div><p class="pb-eyebrow">Step 2 of 2 · Feet</p><h1 class="pb-title">${enrolled ? "Verify" : "Enroll"} with your feet</h1><p class="pb-text">Signed in as ${esc(s.user)}.</p></div>
        <script type="module" src="${FEET_URL}/sdk/piggyback.js"></script>
        <piggyback-auth server="${FEET_URL}" session-token="${esc(r.session_token)}" ${sample ? `source="sample" sample-who="${esc(sample)}"` : ""}${s.debug ? " debug" : ""}${s.tester ? " tester" : ""}></piggyback-auth>
        <script>
          document.querySelector("piggyback-auth").addEventListener("piggyback-complete", async e => {
            const res = await fetch("/mfa/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: e.detail.code }) });
            const { purpose } = await res.json();
            // After enrolling, reload to verify for real; after verifying, go in.
            if (purpose === "verify") location.href = "/";
            else location.reload();
          });
        </script>`));
    }
    if (req.method === "POST" && url.pathname === "/mfa/exchange") {
      const { code } = await readJson(req);
      const claims = await checkResult(code, s.user);
      if (claims.purpose === "verify") { Object.assign(s, { mfa: true, claims }); visits.set(s.user, (visits.get(s.user) || 0) + 1); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ purpose: claims.purpose }));
    }
    if (req.method === "POST" && url.pathname === "/account/remove-feet") {
      await feet("DELETE", `/v1/users/${encodeURIComponent(s.user)}`);
      sessions.delete(sid);
      return redirect(res, "/", { "set-cookie": `sid=; Max-Age=0; ${COOKIE}` });
    }
    // Halfway signed in (password done, feet not yet): carry on, or start over as someone else.
    if (!s.mfa) {
      if (url.pathname !== "/") return redirect(res, "/mfa");
      return html(res, 200, page("Sign in", problem(`Continue as ${esc(s.user)}?`, "Your password is done. The last step is your feet.", "/mfa", "Continue with my feet", switchUser)));
    }
    return html(res, 200, page("Dashboard", await dashboard(s), { wide: true }));
  } catch (err) {
    console.error(err);
    return html(res, 502, page("Error", problem("Something went wrong", esc(err.message), "/mfa", "Try again")));
  }
}).listen(PORT, () => console.log(`Demo app on ${APP_URL} (feet service ${FEET_URL})`));
