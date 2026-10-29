// The Piggyback verification service.
// Relying parties (your apps, or an IdP like Auth0/Okta) create a session server-to-server, send the user
// through the hosted page or the embedded <piggyback-auth> element, then swap the one-time code for a signed token.
// The browser only collects frames: every match and liveness decision is made here.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { signJwt } from "./jwt.js";
import { createOidc } from "./oidc.js";
import { createState } from "./state.js";
import { VIEWS, POSES, viewByKey, PROC } from "../core/engine.js";
import { decideEnroll, decideVerify, decideMatch, decideLive } from "../core/decide.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;
const TOKEN_TTL = 5 * 60;
const MAX_ATTEMPTS = 5;        // per view, then the whole session fails
const MAX_BODY = 8 * 1024 * 1024;
const MAX_FRAMES = 16;
const HANDOFF_TTL = 2 * 60 * 1000;  // a phone link must be opened within this
const PAIR_TTL = 30 * 60 * 1000;    // after a phone scans, it can take the user's next step without a new code (or a new camera question)
const HANDOFF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";  // no 0/O or 1/I, in case someone types it

const token = () => crypto.randomBytes(32).toString("base64url");
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const handoffCode = () => Array.from({ length: 10 }, () => HANDOFF_ALPHABET[crypto.randomInt(HANDOFF_ALPHABET.length)]).join("");
// "Mac · Chrome", shown on the phone so the user knows which computer they're approving.
function deviceOf(ua = "") {
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux computer" : "computer";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}

class HttpError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message || error);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

// `tester`: accept tester-mode scans (POST /v1/session/tester). `adminKey`: lets GET /v1/admin/tester-scans export them.
export function createApp({ dataDir, publicUrl, dataKey, allowSample = false, tester = true, adminKey = null, redisUrl = null, state = createState(redisUrl), log = () => {} }) {
  const store = new Store(dataDir, { dataKey });
  // Short-lived state lives in `state` (memory, or Redis shared between instances). Keys:
  //   ses:<id> session · tok:<sha256(token)> session id · code:<sha256(code)> result to exchange
  //   link:<sha256(phone code)> session id · pair:<sha256(phone pairing token)> pairing · pairfor:<client>|<user> pairing hash
  const issuer = publicUrl.replace(/\/$/, "");
  const saveSession = s => state.set(`ses:${s.id}`, s, s.expires - Date.now());

  // Views a session asks for: both to enroll; to verify, one picked at random (or both, with verify_views 2),
  // so nobody knows in advance which foot or side to fake.
  function pickViews(client, purpose) {
    if (purpose === "enroll") return VIEWS.map(v => v.key);
    const n = Math.max(1, Math.min(VIEWS.length, Number(client.verify_views) || 1));
    const keys = VIEWS.map(v => v.key);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    return VIEWS.map(v => v.key).filter(k => keys.slice(0, n).includes(k));
  }
  // One pass through the requested views for one user. `areq` links it to an OpenID Connect authorization request.
  async function newSession({ client, user_id, purpose, redirect_uri = null, state: rpState = null, areq = null }) {
    const id = `ses_${token().slice(0, 16)}`, secret = token();
    const s = {
      id, tokenHash: sha256(secret), client_id: client.client_id, user_id, purpose, redirect_uri, state: rpState, areq,
      required: pickViews(client, purpose),
      expires: Date.now() + SESSION_TTL, views: {}, pending: {}, failed: false, done: false,
      handoff: null, phoneHash: null,  // "continue on your phone": the open link, and the phone's own token once claimed
    };
    await saveSession(s);
    await state.set(`tok:${s.tokenHash}`, id, SESSION_TTL);
    return { s, secret };
  }
  const oidc = createOidc({ store, issuer, newSession, state, log, allowSample });

  // ---------- Helpers ----------
  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
    res.writeHead(status, {
      "content-type": isJson ? "application/json" : headers["content-type"] || "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, "too_large", "Request body is too large.")); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        if (!size) return resolve({});
        const text = Buffer.concat(chunks).toString("utf8");
        // OAuth endpoints receive forms; the rest of the API speaks JSON.
        if (/application\/x-www-form-urlencoded/i.test(req.headers["content-type"] || "")) return resolve(Object.fromEntries(new URLSearchParams(text)));
        try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, "invalid_json")); }
      });
      req.on("error", reject);
    });
  }
  // Server-to-server calls authenticate with HTTP Basic client_id:client_secret.
  function clientAuth(req) {
    const m = /^Basic (.+)$/i.exec(req.headers.authorization || "");
    if (!m) throw new HttpError(401, "invalid_client", "Client credentials required.");
    const [id, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    const client = store.authenticate(decodeURIComponent(id), decodeURIComponent(rest.join(":")));
    if (!client) throw new HttpError(401, "invalid_client", "Unknown client or wrong secret.");
    return client;
  }
  // Browser calls carry the short-lived session token.
  async function sessionAuth(req) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    const id = m && (await state.get(`tok:${sha256(m[1])}`));
    const s = id && (await state.get(`ses:${id}`));
    if (!s || s.expires < Date.now()) throw new HttpError(401, "invalid_session", "This session has expired. Start again.");
    if (s.failed) throw new HttpError(403, "session_failed", "Too many failed attempts. Start again.", { exit_url: await exitUrl(s) });
    if (s.done) throw new HttpError(409, "session_done", "This session is already finished.");
    return s;
  }
  // Where a failed session sends the user: back to the app with error=access_denied, the way OAuth sign-ins end,
  // so the app can offer a fresh try. Identity platforms get their own cancel address; embedded sessions have none.
  async function exitUrl(s, why = "Too many failed attempts.") {
    if (s.areq) return oidc.cancelUrl(s);
    if (!s.redirect_uri) return null;
    const u = new URL(s.redirect_uri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", why);
    if (s.state) u.searchParams.set("state", s.state);
    return u.toString();
  }
  // The phone in a handoff scans with its own token; only the device that started the session may finish it.
  const fromPhone = (req, s) => !!s.phoneHash && sha256(/^Bearer (.+)$/i.exec(req.headers.authorization || "")?.[1] || "") === s.phoneHash;
  // An open phone link, looked up by the code in /m/<code>.
  async function openHandoff(code) {
    const id = /^[2-9A-HJ-NP-Z]{10}$/.test(code) && (await state.get(`link:${sha256(code)}`));
    const s = id && (await state.get(`ses:${id}`));
    if (!s || !s.handoff || s.handoff.claimed || s.handoff.expires < Date.now() || s.expires < Date.now() || s.failed || s.done) {
      throw new HttpError(404, "handoff_invalid", "This code has expired or was already used. Show a new one on your computer.");
    }
    return s;
  }
  // A phone that finished a step for this user and app recently, ready to take the next one without a new code.
  async function pairingFor(s) {
    const hash = await state.get(`pairfor:${s.client_id}|${s.user_id}`);
    const pairing = hash && (await state.get(`pair:${hash}`));
    return pairing && pairing.session !== s.id ? { hash, pairing } : null;
  }
  // Give the phone its own token for session s.
  // `offered`: sent to a paired phone, which still has to pick it up; otherwise the phone has it now.
  async function attachPhone(s, device, { offered = false } = {}) {
    const secret = token();
    await state.del(s.phoneHash && `tok:${s.phoneHash}`);
    s.phoneHash = sha256(secret);
    Object.assign(s.handoff, { claimed: !offered, offered, phone: device });
    await state.set(`tok:${s.phoneHash}`, s.id, s.expires - Date.now());
    await saveSession(s);
    return secret;
  }
  function decodeFrames(list) {
    if (!Array.isArray(list) || !list.length || list.length > MAX_FRAMES) throw new HttpError(400, "invalid_frames", `Send 1 to ${MAX_FRAMES} frames.`);
    return list.map(f => {
      const { w, h, format, data, cue } = f || {};
      const ch = format === "rgba" ? 4 : format === "gray" ? 1 : 0;
      if (!ch || !Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > PROC || h > PROC || typeof data !== "string") {
        throw new HttpError(400, "invalid_frames", "Each frame needs w, h (16–256), format rgba|gray and deflate-raw base64 data.");
      }
      let raw;
      try { raw = zlib.inflateRawSync(Buffer.from(data, "base64"), { maxOutputLength: w * h * ch }); } catch { throw new HttpError(400, "invalid_frames", "A frame didn't decompress."); }
      if (raw.length !== w * h * ch) throw new HttpError(400, "invalid_frames", "A frame has the wrong number of bytes.");
      // `cue`: on a grey frame, which toe cue the scanner was showing when it was taken (0, 1, 2…).
      return { w, h, format, px: new Uint8Array(raw.buffer, raw.byteOffset, raw.length), ...(Number.isInteger(cue) && cue >= 0 && cue < 8 && { cue }) };
    });
  }
  const viewStatus = s => VIEWS.filter(v => s.required.includes(v.key)).map(v => ({ key: v.key, title: v.title, sub: v.sub, how: v.how, ok: !!s.views[v.key]?.ok, attempts_left: MAX_ATTEMPTS - (s.views[v.key]?.attempts || 0) }));

  // ---------- Routes ----------
  async function route(req, res, url) {
    const p = url.pathname;
    if (await oidc.handle(req, res, url, readBody)) return;

    if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && p === "/.well-known/jwks.json") return send(res, 200, { keys: [store.publicJwk, store.rsaJwk] }, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    if (req.method === "GET" && p === "/.well-known/piggyback-configuration") {
      return send(res, 200, {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        session_endpoint: `${issuer}/v1/sessions`,
        token_endpoint: `${issuer}/v1/token`,
        hosted_page: `${issuer}/hosted`,
        sdk: `${issuer}/sdk/piggyback.js`,
        views: VIEWS.map(v => v.key),
        token_signing_alg_values_supported: ["ES256"],
      });
    }

    // Create a session (server-to-server).
    if (req.method === "POST" && p === "/v1/sessions") {
      const client = clientAuth(req);
      const body = await readBody(req);
      const user_id = typeof body.user_id === "string" ? body.user_id.trim() : "";
      const purpose = body.purpose === "enroll" ? "enroll" : body.purpose === "verify" ? "verify" : null;
      if (!user_id || user_id.length > 256) throw new HttpError(400, "invalid_request", "user_id is required (up to 256 characters).");
      if (!purpose) throw new HttpError(400, "invalid_request", "purpose must be enroll or verify.");
      if (body.redirect_uri && !client.redirect_uris.includes(body.redirect_uri)) throw new HttpError(400, "invalid_redirect_uri", "redirect_uri isn't registered for this client.");
      if (purpose === "verify" && !store.getUser(client.client_id, user_id)) throw new HttpError(409, "not_enrolled", "This user hasn't enrolled their feet.");
      const { s, secret } = await newSession({
        client, user_id, purpose, redirect_uri: body.redirect_uri || null,
        state: typeof body.state === "string" ? body.state.slice(0, 512) : null,
      });
      log(`session ${s.id} ${purpose} for ${client.name}`);
      return send(res, 201, {
        session_id: s.id,
        session_token: secret,
        purpose,
        expires_at: new Date(s.expires).toISOString(),
        // The token rides in the fragment, which browsers never send to servers or logs.
        hosted_url: `${issuer}/hosted#t=${secret}`,
      });
    }

    // Exchange a one-time code for a signed result (server-to-server).
    if (req.method === "POST" && p === "/v1/token") {
      const client = clientAuth(req);
      const body = await readBody(req);
      const c = typeof body.code === "string" ? await state.take(`code:${sha256(body.code)}`) : null;
      if (!c || c.expires < Date.now() || c.client_id !== client.client_id) throw new HttpError(400, "invalid_grant", "The code is unknown, used or expired.");
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer, aud: client.client_id, sub: c.user_id, iat: now, exp: now + TOKEN_TTL, auth_time: c.auth_time,
        jti: token().slice(0, 22), sid: c.session_id, purpose: c.purpose,
        amr: c.purpose === "verify" ? ["feet", "liveness"] : ["feet_enrolled"],
        acr: c.purpose === "verify" ? "urn:piggyback:mfa" : "urn:piggyback:enrolled",
        views: c.views,
      };
      return send(res, 200, { token_type: "piggyback_result", result_token: signJwt(claims, { privateKey: store.privateKey, kid: store.kid }), expires_in: TOKEN_TTL, claims });
    }

    // Enrollment status and deletion (server-to-server).
    const um = /^\/v1\/users\/([^/]+)$/.exec(p);
    if (um && (req.method === "GET" || req.method === "DELETE")) {
      const client = clientAuth(req);
      const userId = decodeURIComponent(um[1]);
      if (req.method === "DELETE") {
        const removed = store.deleteUser(client.client_id, userId);
        return send(res, removed ? 200 : 404, { deleted: removed });
      }
      const user = store.getUser(client.client_id, userId);
      return send(res, 200, { user_id: userId, enrolled: !!user, enrolled_at: user?.enrolled_at || null, views: user ? Object.keys(user.views) : [] });
    }

    // ---------- Browser side (session token) ----------
    if (req.method === "GET" && p === "/v1/session") {
      const s = await sessionAuth(req);
      const handoff = s.handoff && { state: s.handoff.claimed ? "claimed" : s.handoff.offered ? "offered" : "waiting", device: s.handoff.phone || null, expires_at: new Date(s.handoff.expires).toISOString() };
      // A phone that just did this user's previous step can take this one too.
      const phone_ready = !s.handoff && !fromPhone(req, s) ? (await pairingFor(s))?.pairing.device || null : null;
      return send(res, 200, { app: store.client(s.client_id)?.name || null, purpose: s.purpose, expires_at: new Date(s.expires).toISOString(), views: viewStatus(s), cancel_url: await exitUrl(s, "The user cancelled."), platform: !!s.areq, handoff, phone_ready });
    }
    // "Continue on your phone": a one-time link for a QR code. A new one replaces the old one and signs out any phone.
    if (req.method === "POST" && p === "/v1/session/handoff") {
      const s = await sessionAuth(req);
      if (fromPhone(req, s)) throw new HttpError(403, "phone_session", "The phone can't hand off again.");
      const body = await readBody(req);
      const device = deviceOf(req.headers["user-agent"]);
      // Debug and tester mode follow the user from the computer to the phone.
      s.modes = { debug: !!body.debug, tester: !!body.tester };
      // The phone that did the previous step takes this one: no new code to scan (it still asks before scanning).
      const paired = !body.fresh && !s.handoff && (await pairingFor(s));
      if (paired) {
        const { hash, pairing } = paired;
        s.handoff = { codeHash: null, expires: s.expires, claimed: false, device };
        const secret = await attachPhone(s, pairing.device, { offered: true });
        Object.assign(pairing, { session: s.id, next: { session_id: s.id, session_token: secret, purpose: s.purpose, app: store.client(s.client_id)?.name || "the app", device, modes: s.modes } });
        await state.set(`pair:${hash}`, pairing, pairing.expires - Date.now());
        log(`session ${s.id} handed to the paired phone`);
        return send(res, 201, { url: null, attached: true, device: pairing.device, expires_at: new Date(s.expires).toISOString() });
      }
      // A fresh code replaces the old one and signs out any phone.
      await state.del(s.handoff?.codeHash && `link:${s.handoff.codeHash}`, s.phoneHash && `tok:${s.phoneHash}`);
      const code = handoffCode();
      s.handoff = { codeHash: sha256(code), expires: Date.now() + HANDOFF_TTL, claimed: false, device };
      s.phoneHash = null;
      await state.set(`link:${s.handoff.codeHash}`, s.id, HANDOFF_TTL);
      await saveSession(s);
      log(`session ${s.id} handoff link`);
      return send(res, 201, { url: `${issuer}/m/${code}`, expires_at: new Date(s.handoff.expires).toISOString() });
    }
    // The phone page: what it's for (shown before anything is claimed), then the claim itself.
    const hm = /^\/v1\/handoff\/([^/]+)(\/claim)?$/.exec(p);
    if (hm && req.method === (hm[2] ? "POST" : "GET")) {
      const s = await openHandoff(hm[1]);
      const app = store.client(s.client_id)?.name || "the app";
      if (!hm[2]) return send(res, 200, { app, purpose: s.purpose, device: s.handoff.device, views: s.required.map(k => viewByKey[k].title), modes: s.modes || {}, expires_at: new Date(s.handoff.expires).toISOString() });
      // Single use: whoever takes the link first gets it.
      if (!(await state.take(`link:${s.handoff.codeHash}`))) throw new HttpError(404, "handoff_invalid", "This code has expired or was already used. Show a new one on your computer.");
      const phone = deviceOf(req.headers["user-agent"]);
      const secret = await attachPhone(s, phone);
      // Pair the phone with this user and app for a few minutes, so the next step can come straight to it.
      const pairToken = token(), pairHash = sha256(pairToken);
      await state.set(`pair:${pairHash}`, { client_id: s.client_id, user_id: s.user_id, device: phone, session: s.id, next: null, expires: Date.now() + PAIR_TTL }, PAIR_TTL);
      await state.set(`pairfor:${s.client_id}|${s.user_id}`, pairHash, PAIR_TTL);
      log(`session ${s.id} handoff claimed`);
      return send(res, 200, { session_token: secret, pairing_token: pairToken, purpose: s.purpose, app, modes: s.modes || {} });
    }
    // The paired phone asks whether the user's next step is waiting for it.
    if (req.method === "GET" && p === "/v1/pairing/next") {
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      const hash = m && sha256(m[1]);
      const pairing = hash && (await state.get(`pair:${hash}`));
      if (!pairing) throw new HttpError(401, "pairing_expired", "This phone isn't paired any more.");
      if (!pairing.next) return send(res, 200, { waiting: true });
      const { session_id, ...next } = pairing.next;
      pairing.next = null;
      await state.set(`pair:${hash}`, pairing, pairing.expires - Date.now());
      // Now the computer can say the phone has it.
      const s = await state.get(`ses:${session_id}`);
      if (s?.handoff) { s.handoff.claimed = true; await saveSession(s); }
      return send(res, 200, next);
    }
    // Tester mode: what the scanner saw during this sign-in (frames, its live verdicts, the server's answers), kept
    // encrypted for a while to improve detection. Allowed until the session expires, failed or finished included,
    // since the failures are what matter most.
    if (p === "/v1/session/tester" && req.method === "POST") {
      if (!tester) throw new HttpError(404, "not_found", "No such endpoint.");
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      const id = m && (await state.get(`tok:${sha256(m[1])}`));
      const s = id && (await state.get(`ses:${id}`));
      if (!s || s.expires < Date.now()) throw new HttpError(401, "invalid_session", "This session has expired.");
      if ((s.testerScans = (s.testerScans || 0) + 1) > 40) throw new HttpError(429, "too_many", "This session has sent enough tester scans.");
      await saveSession(s);
      const body = await readBody(req);
      if (!body?.scan || typeof body.scan !== "object" || Array.isArray(body.scan)) throw new HttpError(400, "invalid_request", "Send { scan: { … } }.");
      const name = store.putTesterScan({
        received_at: new Date().toISOString(),
        client: store.client(s.client_id)?.name || null,
        // The same person across scans, without their user id.
        person: sha256(`${s.client_id}:${s.user_id}`).slice(0, 16),
        purpose: s.purpose,
        views: Object.fromEntries(Object.entries(s.views).map(([k, v]) => [k, { ok: !!v.ok, attempts: v.attempts || 0, score: v.score ?? v.matched?.score ?? null }])),
        scan: body.scan,
      });
      if (!name) throw new HttpError(507, "storage_full", "Tester storage is full.");
      log(`session ${s.id} tester scan ${name}`);
      return send(res, 200, { ok: true });
    }
    // Export of the tester scans, one JSON object per line, for whoever holds PIGGYBACK_ADMIN_KEY.
    if (p === "/v1/admin/tester-scans" && req.method === "GET") {
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      if (!adminKey) throw new HttpError(404, "not_found", "No such endpoint.");
      const a = Buffer.from(sha256(m?.[1] || "")), b = Buffer.from(sha256(adminKey));
      if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, "unauthorized", "Wrong admin key.");
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      for (const x of store.testerScans()) res.write(JSON.stringify(x) + "\n");
      return res.end();
    }
    const vm = /^\/v1\/session\/views\/([LR]\.top)$/.exec(p);
    if (vm && req.method === "POST") {
      const s = await sessionAuth(req), view = viewByKey[vm[1]];
      if (!s.required.includes(view.key)) throw new HttpError(400, "view_not_requested", "This session doesn't ask for that view.");
      const st = (s.views[view.key] ||= { ok: false, attempts: 0 });
      if (st.ok) return send(res, 200, { ok: true, key: view.key });
      const body = await readBody(req);
      const frames = decodeFrames(body.frames);
      const user = s.purpose === "verify" ? store.getUser(s.client_id, s.user_id) : null;
      // Logging in is two steps: still frames first (does the foot match?), then grey frames (did the toes move?).
      // A request with both does both at once, for older clients.
      const stills = frames.some(f => f.format === "rgba"), grays = frames.some(f => f.format === "gray");
      let r;
      // Enrollment takes POSES.length poses of each foot, one upload each (`pose`); a client that sends none is done in one.
      const pose = Number.isInteger(body.pose) && body.pose >= 0 && body.pose < POSES.length ? body.pose : null;
      if (s.purpose === "enroll") r = decideEnroll(view, frames, s.pending[view.otherKey], pose ?? 0, s.pending[view.key]);
      else if (stills && grays) r = decideVerify(view, frames, user);
      else if (stills) {
        r = decideMatch(view, frames, user);
        if (r.ok) {
          // Matched: no try used yet. Keep the matched frame for the wiggle, for a minute.
          st.matched = { score: r.score, ref: r.ref, until: Date.now() + 60 * 1000 };
          await saveSession(s);
          log(`session ${s.id} ${view.key} matched ${r.score.toFixed(2)}`);
          return send(res, 200, { ok: false, matched: true, key: view.key, attempts_left: MAX_ATTEMPTS - st.attempts });
        }
      } else {
        if (!st.matched || st.matched.until < Date.now()) throw new HttpError(409, "match_first", "Show the foot again before wiggling.");
        r = { ...decideLive(st.matched.ref, frames), score: st.matched.score };
        delete st.matched;
      }
      if (r.ok && r.templates) {
        s.pending[view.key] = [...(s.pending[view.key] || []).filter(t => t.pose !== (pose ?? 0)), ...r.templates];
        if (pose !== null && pose + 1 < POSES.length) {
          // This pose is saved; the view isn't done until every pose is. No try used.
          await saveSession(s);
          log(`session ${s.id} ${view.key} pose ${pose} saved`);
          return send(res, 200, { ok: true, key: view.key, pose, next_pose: pose + 1, poses: POSES.length });
        }
      }
      st.attempts++;
      if (r.ok) Object.assign(st, { ok: true, score: r.score ?? null, live: !!r.live });
      else if (st.attempts >= MAX_ATTEMPTS) s.failed = true;
      await saveSession(s);
      log(`session ${s.id} ${view.key} ${r.ok ? "ok" : r.reason} ${r.score != null ? r.score.toFixed(2) : ""}`);
      // Scores stay on the server so the browser can't be used to hill-climb towards a match.
      return send(res, 200, { ok: r.ok, key: view.key, reason: r.reason, message: r.message, attempts_left: MAX_ATTEMPTS - st.attempts, session_failed: s.failed, ...(s.failed && !fromPhone(req, s) && { exit_url: await exitUrl(s) }) });
    }
    // Enrollment only: take a view again before finishing (the user didn't like what was saved). Tries still count.
    const rm = /^\/v1\/session\/views\/([LR]\.top)\/reset$/.exec(p);
    if (rm && req.method === "POST") {
      const s = await sessionAuth(req);
      if (s.purpose !== "enroll") throw new HttpError(400, "invalid_request", "Only enrollment views can be redone.");
      if (s.views[rm[1]]) s.views[rm[1]].ok = false;
      delete s.pending[rm[1]];
      await saveSession(s);
      return send(res, 200, { ok: true, key: rm[1] });
    }
    if (req.method === "POST" && p === "/v1/session/complete") {
      const s = await sessionAuth(req);
      if (fromPhone(req, s)) throw new HttpError(403, "phone_session", "Finish on the computer that showed the code.");
      if (!s.required.every(k => s.views[k]?.ok)) throw new HttpError(409, "incomplete", "Not every view has passed yet.");
      if (s.purpose === "enroll") store.putUser(s.client_id, s.user_id, s.pending);
      s.done = true;
      s.pending = {};
      await saveSession(s);
      if (s.areq) {
        // Started by an identity platform over OpenID Connect: hand the browser to the next step.
        const redirect_to = await oidc.onSessionComplete(s);
        if (!redirect_to) throw new HttpError(410, "request_expired", "The sign-in request expired. Go back to the app and start again.");
        return send(res, 200, { code: null, redirect_to });
      }
      const code = token();
      await state.set(`code:${sha256(code)}`, {
        client_id: s.client_id, user_id: s.user_id, purpose: s.purpose, session_id: s.id,
        auth_time: Math.floor(Date.now() / 1000), expires: Date.now() + CODE_TTL,
        views: Object.fromEntries(s.required.map(k => [k, s.purpose === "verify" ? { score: Math.round(s.views[k].score * 100) / 100, live: s.views[k].live } : { enrolled: true }])),
      }, CODE_TTL);
      let redirect_to = null;
      if (s.redirect_uri) {
        const u = new URL(s.redirect_uri);
        u.searchParams.set("code", code);
        if (s.state) u.searchParams.set("state", s.state);
        redirect_to = u.toString();
      }
      return send(res, 200, { code, redirect_to });
    }

    // ---------- Hosted page and static SDK files ----------
    // The service's own front page: what this address is, for anyone who lands on it.
    if (req.method === "GET" && p === "/") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "server", "home.html")), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
      });
    }
    if (req.method === "GET" && p === "/hosted") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "server", "hosted.html")), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
        "permissions-policy": "camera=(self)",
        "referrer-policy": "no-referrer",
      });
    }
    if (req.method === "GET" && /^\/m\/[2-9A-HJ-NP-Z]{10}$/.test(p)) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "server", "handoff.html")), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
        "permissions-policy": "camera=(self)",
        "referrer-policy": "no-referrer",
      });
    }
    if (req.method === "GET" && p === "/favicon.ico") {
      res.writeHead(301, { location: "/brand/favicon-32.png" });
      return res.end();
    }
    const sm = /^\/(sdk|core|ui|brand)\/([\w.-]+\.(js|svg|css|png))$/.exec(p);
    if (req.method === "GET" && sm) {
      const file = path.join(ROOT, sm[1], sm[2]);
      if (!fs.existsSync(file)) throw new HttpError(404, "not_found");
      const type = { js: "text/javascript; charset=utf-8", svg: "image/svg+xml; charset=utf-8", css: "text/css; charset=utf-8", png: "image/png" }[sm[3]];
      return send(res, 200, fs.readFileSync(file), { "content-type": type, "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    }
    throw new HttpError(404, "not_found", "No such endpoint.");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    // Session endpoints are called from the relying party's pages; they use a bearer token, never cookies.
    if (url.pathname === "/v1/session" || url.pathname.startsWith("/v1/session/")) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") return send(res, 204, "");
    }
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.error, message: err.message, ...err.extra });
      else { log(`error ${err.stack || err}`); send(res, 500, { error: "server_error" }); }
    }
  });
  server.on("close", () => state.close());
  return { server, store, state };
}
