// End to end in a real browser, the way a customer would integrate:
// the demo app (password + Piggyback) talks to the service; sample feet stand in for a camera.
//   npm install && npm run test:e2e        (set CHROME=/path/to/chrome if it isn't in the default place)
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { Store } from "../server/store.js";
import { signJwt, verifyJwt } from "../server/jwt.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEET = "http://localhost:8799", APP = "http://localhost:3999", IDP = "http://localhost:3997";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-e2e-"));
const store = new Store(dir);
const { client_id, client_secret } = store.addClient({ name: "Piggy Bank", redirect_uris: [`${APP}/mfa/callback`] });

// A stand-in identity platform (think Okta or Entra ID) that sends users to Piggyback over OpenID Connect.
const okta = store.addClient({ name: "Okta-like IdP", redirect_uris: [`${IDP}/cb`] });
const entraKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const entraJwk = { ...crypto.createPublicKey(entraKey).export({ format: "jwk" }), kid: "entra-1", alg: "RS256" };
const entra = store.addClient({
  name: "Entra-like IdP", redirect_uris: [`${IDP}/cb`],
  oidc: { acr: "possessionorinherence", hint_issuers: [{ issuer: `${IDP}/tenant`, jwks_uri: `${IDP}/jwks` }] },
});
const received = [];
const idp = http.createServer((req, res) => {
  const url = new URL(req.url, IDP);
  if (url.pathname === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [entraJwk] })); }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (url.pathname !== "/cb") { res.writeHead(404); return res.end(); }
    received.push({ method: req.method, query: Object.fromEntries(url.searchParams), form: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("received");
  });
}).listen(3997);
const lastReceived = () => received[received.length - 1];

const procs = [];
const start = (file, env) => {
  const p = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env } });
  p.stderr.on("data", d => process.stderr.write(`[${path.basename(file)}] ${d}`));
  procs.push(p);
  return new Promise(r => p.stdout.on("data", d => { if (/listening|Demo app/i.test(d)) r(); }));
};
await start("server/index.js", { PORT: "8799", PUBLIC_URL: FEET, DATA_DIR: dir, PIGGYBACK_ALLOW_SAMPLE: "1" });
await start("examples/demo-app/server.js", { PORT: "3999", APP_URL: APP, FEET_URL: FEET, CLIENT_ID: client_id, CLIENT_SECRET: client_secret });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--disable-background-timer-throttling"] });
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); if (!ok) failures++; };
const shadow = (page, sel) => page.evaluate(s => document.querySelector("piggyback-auth")?.shadowRoot.querySelector(s)?.textContent || "", sel);
// Scan with this browser's camera: on a computer that's the "Use this computer's camera" button under "Use my phone".
// Enrollment stops after each foot so the user can check it; tests click "Next" unless a test reviews it by hand.
const AUTO_NEXT = () => setInterval(() => {
  const next = document.querySelector("piggyback-auth")?.shadowRoot?.querySelector(".next:not([hidden])");
  if (next && (!window.__manualReview || next.textContent === "Go")) next.click();
}, 250);
const newPage = async (ctx = null) => {
  const page = await (ctx || (await browser.createBrowserContext())).newPage();
  await page.evaluateOnNewDocument(AUTO_NEXT);
  return page;
};
const pressStart = async page => {
  await page.waitForFunction(() => document.querySelector("piggyback-auth")?.shadowRoot.querySelector(".start"), { timeout: 15000 });
  await page.evaluate(() => { const r = document.querySelector("piggyback-auth").shadowRoot; (r.querySelector(".alt:not([hidden])") || r.querySelector(".start")).click(); });
};
// Wait for a login to be refused; on a timeout, say what the scanner was showing instead.
const untilRefused = page => page.waitForFunction(() => /tries left|Too many/.test(document.querySelector("piggyback-auth").shadowRoot.querySelector(".st").textContent), { timeout: 60000 })
  .catch(async e => { throw new Error(`${e.message}; the scanner said "${await shadow(page, ".st")}"`); });
async function login(user, sample, path = "/") {
  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx);
  await page.goto(`${APP}${path}?sample=${sample}`);
  await page.type("input[name=username]", user);
  await page.type("input[name=password]", "demo");
  await Promise.all([page.waitForNavigation(), page.click("button")]);
  return { ctx, page };
}

try {
  // 1. Redirect flow: enroll, then verify, then land in the app.
  let t0 = Date.now();
  const a = await login("alice@example.com", "you");
  check("redirected to the hosted page", a.page.url().startsWith(`${FEET}/hosted`), a.page.url().replace(/#.*/, ""));
  check("session token removed from the address bar", !a.page.url().includes("#t="));
  // The first foot is reviewed by hand: the user sees what was saved and can redo it before moving on.
  await a.page.evaluate(() => { window.__manualReview = true; });
  await pressStart(a.page);                                                     // enrollment
  const review = () => a.page.evaluate(() => document.querySelector("piggyback-auth").shadowRoot.querySelector(".next:not([hidden])")?.textContent || "");
  await a.page.waitForFunction(() => document.querySelector("piggyback-auth").state.phase === "review", { timeout: 90000 });
  check("after the left foot, enrollment waits for the user to check it", (await review()) === "Next", await review());
  await a.page.evaluate(() => document.querySelector("piggyback-auth").shadowRoot.querySelector(".redo").click());
  await a.page.waitForFunction(() => document.querySelector("piggyback-auth").state.phase === "find", { timeout: 15000 });
  await a.page.waitForFunction(() => document.querySelector("piggyback-auth").state.phase === "review", { timeout: 60000 });
  check("Redo takes the left foot again", (await review()) === "Next" && (await a.page.evaluate(() => document.querySelector("piggyback-auth").state.i)) === 0);
  await a.page.evaluate(() => { window.__manualReview = false; });
  await a.page.waitForFunction(u => location.href.startsWith(u), { timeout: 90000 }, `${FEET}/hosted`);
  await a.page.waitForNavigation({ timeout: 90000 });                           // → callback → new verify session
  await pressStart(a.page);                                                     // verification
  await a.page.waitForSelector("#claims", { timeout: 90000 });
  const claims = JSON.parse(await a.page.$eval("#claims", el => el.textContent));
  check("alice enrolled and verified through the redirect flow", claims.sub === "alice@example.com" && claims.amr.includes("liveness"), `${((Date.now() - t0) / 1000).toFixed(0)}s, scores ${Object.values(claims.views).map(v => v.score).join(" ")}`);
  check("result token is audience-bound to the app", claims.aud === client_id && claims.iss === FEET);

  // 1b. Cancelling on the hosted page goes back to the app, which offers to try again or to sign in as someone else.
  const x = await login("dana@example.com", "you");
  await x.page.waitForSelector("#exit a", { timeout: 15000 });
  check("the hosted page offers a way back to the app", /Cancel and go back to Piggy Bank/.test(await x.page.$eval("#exit a", a => a.textContent)));
  await Promise.all([x.page.waitForNavigation(), x.page.click("#exit a")]);
  const back = await x.page.evaluate(() => document.body.textContent);
  await Promise.all([x.page.waitForNavigation(), x.page.click("a[href='/logout']")]);
  check("cancelling lands on the app, which lets you sign in as someone else", /Sign-in cancelled/.test(back) && !!(await x.page.$("input[name=username]")));

  // 2. An impostor at alice's password prompt.
  const b = await login("alice@example.com", "impostor");
  await pressStart(b.page);
  await untilRefused(b.page);
  check("impostor's feet are refused", /No match|Wrong foot|Too many/.test(await shadow(b.page, ".st")), await shadow(b.page, ".st"));

  // 3. Someone holding up a photo of alice's feet.
  const c = await login("alice@example.com", "photo");
  await pressStart(c.page);
  await untilRefused(c.page);
  check("a still photo fails the toe check", /didn't follow/.test(await shadow(c.page, ".st")), await shadow(c.page, ".st"));

  // 4. Embedded flow for a second user, inside the app's own page.
  t0 = Date.now();
  const d = await login("bob@example.com", "you");
  await d.page.goto(`${APP}/mfa/embedded?sample=you`);
  await pressStart(d.page);                                                     // enrollment
  await d.page.waitForNavigation({ timeout: 120000 });                          // reload → verify
  await pressStart(d.page);
  await d.page.waitForSelector("#claims", { timeout: 90000 });
  const bob = JSON.parse(await d.page.$eval("#claims", el => el.textContent));
  check("bob enrolled and verified through the embedded element", bob.sub === "bob@example.com" && bob.purpose === "verify", `${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 4b. Continue on your phone: the computer shows a code, a phone scans, the computer finishes by itself.
  const hand = await login("carol@example.com", "you");
  await hand.page.waitForFunction(() => document.querySelector("piggyback-auth")?.shadowRoot.querySelector(".start")?.textContent === "Use my phone", { timeout: 15000 });
  await hand.page.evaluate(() => document.querySelector("piggyback-auth").shadowRoot.querySelector(".start").click());
  await hand.page.waitForFunction(() => document.querySelector("piggyback-auth").handoffUrl, { timeout: 15000 });
  const link = await hand.page.evaluate(() => document.querySelector("piggyback-auth").handoffUrl);
  check("the computer shows a one-time phone link", /^http:\/\/localhost:8799\/m\/[2-9A-HJ-NP-Z]{10}#source=sample/.test(link), link.replace(/m\/\w+/, "m/…"));
  const phoneCtx = await browser.createBrowserContext();
  const phone = await newPage(phoneCtx);
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await phone.goto(link);
  await phone.waitForSelector("#go", { timeout: 15000 });
  const asked = await phone.$eval(".pb-panel", el => el.textContent);
  check("the phone says which app and computer it's for before claiming", /Piggy Bank/.test(asked) && /Started on a/.test(asked));
  await phone.click("#go");
  await pressStart(phone);
  const reuse = await fetch(`${link.replace(/#.*/, "").replace("/m/", "/v1/handoff/")}/claim`, { method: "POST" });
  check("a phone link works only once", reuse.status === 404);
  // Enrolled on the phone; the computer moves on to the first login and hands it to the same phone: no second code.
  await hand.page.waitForFunction(() => document.querySelector("piggyback-auth")?.purpose === "verify", { timeout: 90000 });
  await phone.waitForFunction(() => document.getElementById("go")?.textContent === "Continue", { timeout: 30000 });
  check("the first login goes straight to the same phone, no second code", !(await hand.page.evaluate(() => document.querySelector("piggyback-auth").handoffUrl)));
  await phone.click("#go");
  await pressStart(phone);
  await hand.page.waitForSelector("#claims", { timeout: 90000 });
  const carol = JSON.parse(await hand.page.$eval("#claims", el => el.textContent));
  check("carol enrolled and signed in from her phone; the computer finished by itself", carol.sub === "carol@example.com" && carol.amr.includes("liveness"));
  await phoneCtx.close();

  // 5. Removing enrolled feet.
  await Promise.all([d.page.waitForNavigation(), d.page.click("form[action='/account/remove-feet'] button")]);
  const e = await login("bob@example.com", "you");
  await e.page.waitForFunction(() => document.querySelector("piggyback-auth")?.shadowRoot.querySelector(".title")?.textContent.includes("Enroll"), { timeout: 15000 });
  check("after removal, bob is asked to enroll again", true);

  // ---------- OpenID Connect: identity platforms sending users here ----------
  const jwks = await (await fetch(`${FEET}/.well-known/jwks.json`)).json();
  const untilUrl = async (page, prefix, ms = 90000) => {
    const t = Date.now();
    while (!page.url().startsWith(prefix)) {
      if (Date.now() - t > ms) throw new Error(`timed out waiting for ${prefix}, at ${page.url()}`);
      await new Promise(r => setTimeout(r, 250));
    }
  };
  // Enroll on first use, then verify, then return to the platform.
  async function scanThrough(page) {
    await pressStart(page);
    await page.waitForNavigation({ timeout: 120000 });   // enrolled (three poses a foot) → verify step
    await pressStart(page);
    await untilUrl(page, `${IDP}/cb`);
  }

  // 6. Okta-style: authorization code with PKCE, user named by login_hint.
  t0 = Date.now();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const f = await newPage();
  await f.goto(`${FEET}/oauth2/authorize?${new URLSearchParams({
    client_id: okta.client_id, redirect_uri: `${IDP}/cb`, response_type: "code", scope: "openid", state: "okta-state", nonce: "okta-nonce",
    login_hint: "frank@example.com", code_challenge: challenge, code_challenge_method: "S256", pb_sample: "you",
  })}`);
  await scanThrough(f);
  const cb = lastReceived().query;
  check("code flow returns a code and the platform's state", !!cb.code && cb.state === "okta-state");
  const tok = await (await fetch(`${FEET}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${okta.client_id}:${okta.client_secret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: cb.code, redirect_uri: `${IDP}/cb`, code_verifier: verifier }),
  })).json();
  const idt = verifyJwt(tok.id_token, jwks, { issuer: FEET, audience: okta.client_id });
  check("id_token is RS256-signed for frank with the nonce and feet amr", idt.sub === "frank@example.com" && idt.nonce === "okta-nonce" && idt.amr.includes("feet"), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const ui = await (await fetch(`${FEET}/oauth2/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  check("userinfo answers for the access token", ui.sub === "frank@example.com");
  const replay = await (await fetch(`${FEET}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: cb.code, redirect_uri: `${IDP}/cb`, code_verifier: verifier, client_id: okta.client_id, client_secret: okta.client_secret }),
  })).json();
  check("the code can't be used twice", replay.error === "invalid_grant");

  // 7. Entra-style: id_token via form_post, user named by a signed id_token_hint from the platform.
  t0 = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const hint = signJwt({ iss: `${IDP}/tenant`, sub: "oid-7f3a", aud: entra.client_id, iat: now, exp: now + 600, preferred_username: "erin@example.com", tid: "tenant-1", oid: "oid-7f3a" },
    { privateKey: entraKey, kid: "entra-1", alg: "RS256" });
  const g = await newPage();
  await g.goto(`${FEET}/oauth2/authorize?${new URLSearchParams({
    client_id: entra.client_id, redirect_uri: `${IDP}/cb`, response_type: "id_token", response_mode: "form_post", scope: "openid",
    state: "entra-state", nonce: "entra-nonce", id_token_hint: hint, pb_sample: "you",
  })}`);
  await scanThrough(g);
  const post = lastReceived();
  const eid = verifyJwt(post.form.id_token, jwks, { issuer: FEET, audience: entra.client_id });
  check("form_post delivers an id_token for the hinted user", post.method === "POST" && post.form.state === "entra-state" && eid.sub === "oid-7f3a" && eid.nonce === "entra-nonce", `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  check("id_token carries the acr the platform needs and echoes oid/tid", eid.acr === "possessionorinherence" && eid.oid === "oid-7f3a" && eid.tid === "tenant-1" && eid.preferred_username === "erin@example.com");

  // 8. A forged hint (signed by the wrong key) is refused.
  const forged = signJwt({ iss: `${IDP}/tenant`, sub: "oid-7f3a", exp: now + 600 }, { privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, kid: "entra-1", alg: "RS256" });
  const h = await newPage();
  await h.goto(`${FEET}/oauth2/authorize?${new URLSearchParams({ client_id: entra.client_id, redirect_uri: `${IDP}/cb`, response_type: "id_token", response_mode: "form_post", scope: "openid", state: "x", nonce: "n", id_token_hint: forged })}`);
  await untilUrl(h, `${IDP}/cb`, 15000);
  check("a hint signed by the wrong key is refused", lastReceived().form.error === "invalid_request", lastReceived().form.error_description);

  // 9. The user backs out to another method.
  const k = await newPage();
  await k.goto(`${FEET}/oauth2/authorize?${new URLSearchParams({ client_id: okta.client_id, redirect_uri: `${IDP}/cb`, response_type: "code", scope: "openid", state: "bail", login_hint: "frank@example.com", pb_sample: "you" })}`);
  await k.waitForSelector("#exit a", { timeout: 15000 });
  await k.click("#exit a");
  await untilUrl(k, `${IDP}/cb`, 15000);
  check("'Use another sign-in method' returns access_denied", lastReceived().query.error === "access_denied" && lastReceived().query.state === "bail");
} catch (err) {
  failures++;
  console.log("FAIL ", err.message);
} finally {
  await browser.close();
  procs.forEach(p => p.kill());
  idp.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
