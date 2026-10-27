// OpenID Connect provider front door, so identity platforms can use Piggyback as an external factor:
// Okta (IdP authenticator), Microsoft Entra ID (External Authentication Methods), Ping, Keycloak and Auth0 (OIDC connections).
//
// The platform has already identified the user and sends them here with login_hint or a signed id_token_hint.
// We run the foot check (enrolling first if needed) and send back an id_token whose sub is that user.
// Supports response_type=code (with PKCE) and response_type=id_token with response_mode=form_post|fragment.
import crypto from "node:crypto";
import { signJwt, verifyJwt, decodeJwt } from "./jwt.js";

const REQUEST_TTL = 15 * 60 * 1000;
const CODE_TTL = 60 * 1000;
const TOKEN_TTL = 5 * 60;
const token = () => crypto.randomBytes(32).toString("base64url");
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function createOidc({ store, issuer, newSession, state, log, allowSample }) {
  // Shared state (see state.js): oreq:<id> pending authorization request · ocancel:<id> request id ·
  // oret:<id> final response to deliver · ocode:<sha256(code)> grant · oat:<sha256(access token)> userinfo
  const jwksCache = new Map();  // jwks_uri → { keys, at }; a per-instance cache is fine


  const discovery = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code", "id_token"],
    response_modes_supported: ["query", "fragment", "form_post"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["openid", "profile"],
    claims_supported: ["sub", "amr", "acr", "auth_time", "nonce", "preferred_username"],
    code_challenge_methods_supported: ["S256"],
    claims_parameter_supported: true,
  });

  // ---------- Responses ----------
  function page(res, status, title, body, { nonce } = {}) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self'; form-action *; ${nonce ? `script-src 'nonce-${nonce}';` : ""} frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
    });
    // Built from the shared ui/ styles, like the hosted page. Brand: brand/BRAND.md.
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)} · Piggyback</title>
<link rel="icon" href="/brand/favicon-32.png" type="image/png"><link rel="stylesheet" href="/ui/tokens.css"><link rel="stylesheet" href="/ui/controls.css"><link rel="stylesheet" href="/ui/page.css"></head>
<body class="pb-backdrop"><main class="pb-page middle"><span class="pb-lockup"><img src="/brand/logo-128.png" alt="">Piggyback</span><div class="pb-panel">${body}</div></main></body></html>`);
  }
  // Deliver params to the platform's redirect_uri the way it asked for.
  function deliver(res, { redirect_uri, mode, params }) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
    if (mode === "form_post") {
      const nonce = token().slice(0, 16);
      const inputs = Object.entries(clean).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
      return page(res, 200, "Signing you in", `<span class="pb-check" role="img" aria-label="Verified"></span><h1 class="pb-title">Verified. Signing you in…</h1><form method="post" action="${esc(redirect_uri)}">${inputs}<noscript><button class="pb-btn block">Continue</button></noscript></form>
        <script nonce="${nonce}">document.forms[0].submit()</script>`, { nonce });
    }
    const u = new URL(redirect_uri);
    const q = new URLSearchParams(clean);
    if (mode === "fragment") u.hash = q.toString();
    else for (const [k, v] of q) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.toString(), "cache-control": "no-store" });
    res.end();
  }
  const hostedUrl = (secret, purpose, sample) =>
    `${issuer}/hosted?step=${purpose}#t=${secret}${sample ? `&source=sample&who=${encodeURIComponent(sample)}` : ""}`;

  // ---------- id_token_hint: a token from the platform that names the user ----------
  async function jwksFor(uri) {
    const hit = jwksCache.get(uri);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.keys;
    const keys = await (await fetch(uri)).json();
    jwksCache.set(uri, { keys, at: Date.now() });
    return keys;
  }
  async function readHint(client, hint) {
    const { claims } = decodeJwt(hint);
    const trusted = (client.oidc.hint_issuers || []).find(h => h.issuer === claims.iss);
    if (!trusted) throw new Error(`issuer ${claims.iss} isn't trusted for this client`);
    // Hints may be a little old by the time the user arrives; the foot check is what authenticates.
    return verifyJwt(hint, await jwksFor(trusted.jwks_uri), { issuer: trusted.issuer, now: Math.floor(Date.now() / 1000) - 600 });
  }

  // ---------- Endpoints ----------
  async function authorize(req, res, params) {
    const client = params.client_id ? store.client(params.client_id) : null;
    const redirect_uri = params.redirect_uri;
    if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      // Never redirect to an address we can't vouch for.
      return page(res, 400, "Sign-in error", `<h1 class="pb-title">This sign-in link isn't valid</h1><p class="pb-text">The app or its return address isn't registered with Piggyback.</p>`);
    }
    const rt = params.response_type;
    // Without a response type we understand, errors go back in the query string.
    const mode = params.response_mode || (rt === "id_token" ? "fragment" : "query");
    const back = (error, error_description) => deliver(res, { redirect_uri, mode: ["query", "fragment", "form_post"].includes(mode) ? mode : "query", params: { error, error_description, state: params.state } });
    if (rt !== "code" && rt !== "id_token") return back("unsupported_response_type", "Use response_type=code or id_token.");
    if (!["query", "fragment", "form_post"].includes(mode) || (rt === "id_token" && mode === "query")) return back("invalid_request", "Unsupported response_mode.");
    if (!String(params.scope || "").split(/\s+/).includes("openid")) return back("invalid_scope", "scope must include openid.");
    if (rt === "id_token" && !params.nonce) return back("invalid_request", "nonce is required for id_token responses.");
    if (params.code_challenge && (params.code_challenge_method || "plain") !== "S256") return back("invalid_request", "Only S256 PKCE is supported.");
    if (params.prompt === "none") return back("interaction_required", "The user has to scan their feet.");

    let user_id = null, hint = null;
    if (params.id_token_hint) {
      try { hint = await readHint(client, params.id_token_hint); } catch (e) { return back("invalid_request", `id_token_hint: ${e.message}`); }
      user_id = hint.sub;
    } else if (params.login_hint) {
      user_id = String(params.login_hint).trim();
    }
    if (!user_id && client.oidc.username_prompt) {
      const hidden = Object.entries(params).filter(([k]) => k !== "login_hint").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
      return page(res, 200, "Who's signing in?", `<h1 class="pb-title">Who's signing in?</h1><p class="pb-text">Enter the account name you use with ${esc(client.name)}.</p>
        <form method="post" action="/oauth2/authorize">${hidden}<label class="pb-label">Account name<input class="pb-input" name="login_hint" autocomplete="username" placeholder="you@company.com" required></label><button class="pb-btn block">Continue</button></form>`);
    }
    if (!user_id || user_id.length > 256) return back("login_required", "Send login_hint or id_token_hint naming the user.");

    const enrolled = !!store.getUser(client.client_id, user_id);
    if (!enrolled && !client.oidc.enroll_on_first_use) return back("access_denied", "This user hasn't enrolled their feet.");
    const rid = token();
    const sample = allowSample && params.pb_sample ? String(params.pb_sample) : null;
    const cancel = token();
    await state.set(`oreq:${rid}`, {
      rid, client_id: client.client_id, redirect_uri, mode, response_type: rt, state: params.state || null, nonce: params.nonce || null,
      code_challenge: params.code_challenge || null, user_id, hint, sample, cancel, expires: Date.now() + REQUEST_TTL,
    }, REQUEST_TTL);
    await state.set(`ocancel:${cancel}`, rid, REQUEST_TTL);
    const { secret } = await newSession({ client, user_id, purpose: enrolled ? "verify" : "enroll", areq: rid });
    log(`oidc ${client.name}: ${enrolled ? "verify" : "enroll"} ${rt}/${mode}`);
    res.writeHead(302, { location: hostedUrl(secret, enrolled ? "verify" : "enroll", sample), "cache-control": "no-store" });
    res.end();
  }

  function idToken(r, client, auth_time, views) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer, sub: r.user_id, aud: client.client_id, iat: now, exp: now + TOKEN_TTL, auth_time,
      amr: client.oidc.amr, acr: client.oidc.acr, piggyback_views: views,
    };
    if (r.nonce) claims.nonce = r.nonce;
    if (r.hint?.preferred_username) claims.preferred_username = r.hint.preferred_username;
    if (r.hint?.tid) claims.tid = r.hint.tid;
    if (r.hint?.oid) claims.oid = r.hint.oid;
    return signJwt(claims, { privateKey: store.rsaKey, kid: store.rsaKid, alg: "RS256" });
  }

  // Called when a hosted session tied to an authorization request finishes. Returns where the browser goes next.
  async function onSessionComplete(s) {
    const r = await state.get(`oreq:${s.areq}`);
    if (!r) return null;
    const client = store.client(r.client_id);
    if (s.purpose === "enroll") {
      // Enrolled; now prove it with a real verification before signing anything.
      const { secret } = await newSession({ client, user_id: r.user_id, purpose: "verify", areq: r.rid });
      return hostedUrl(secret, "verify", r.sample);
    }
    await state.del(`oreq:${r.rid}`, `ocancel:${r.cancel}`);
    const auth_time = Math.floor(Date.now() / 1000);
    const views = Object.fromEntries(s.required.map(k => [k, Math.round((s.views[k]?.score || 0) * 100) / 100]));
    let params;
    if (r.response_type === "code") {
      const code = token();
      await state.set(`ocode:${sha256(code)}`, { ...r, auth_time, views, expires: Date.now() + CODE_TTL }, CODE_TTL);
      params = { code, state: r.state };
    } else {
      params = { id_token: idToken(r, client, auth_time, views), state: r.state };
    }
    const once = token();
    await state.set(`oret:${once}`, { redirect_uri: r.redirect_uri, mode: r.mode, params, expires: Date.now() + 2 * 60 * 1000 }, 2 * 60 * 1000);
    return `${issuer}/oauth2/return/${once}`;
  }
  // The hosted page offers a way out ("use another method"), which tells the platform access_denied.
  async function cancelUrl(s) {
    const r = s.areq && (await state.get(`oreq:${s.areq}`));
    return r ? `${issuer}/oauth2/cancel/${r.cancel}` : null;
  }

  async function tokenEndpoint(req, res, body) {
    const fail = (status, error, error_description) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" });
      res.end(JSON.stringify({ error, error_description }));
    };
    let id = body.client_id, secret = body.client_secret;
    const m = /^Basic (.+)$/i.exec(req.headers.authorization || "");
    if (m) [id, secret] = Buffer.from(m[1], "base64").toString("utf8").split(":").map(decodeURIComponent);
    const client = store.authenticate(id, secret);
    if (!client) return fail(401, "invalid_client", "Unknown client or wrong secret.");
    if (body.grant_type !== "authorization_code") return fail(400, "unsupported_grant_type", "Only authorization_code.");
    const g = await state.take(`ocode:${sha256(String(body.code || ""))}`);
    if (!g || g.expires < Date.now() || g.client_id !== client.client_id) return fail(400, "invalid_grant", "The code is unknown, used or expired.");
    if (body.redirect_uri !== g.redirect_uri) return fail(400, "invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (g.code_challenge) {
      const v = String(body.code_verifier || "");
      if (crypto.createHash("sha256").update(v).digest("base64url") !== g.code_challenge) return fail(400, "invalid_grant", "PKCE check failed.");
    }
    const at = token();
    await state.set(`oat:${sha256(at)}`, { sub: g.user_id, amr: client.oidc.amr, acr: client.oidc.acr, expires: Date.now() + TOKEN_TTL * 1000 }, TOKEN_TTL * 1000);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" });
    res.end(JSON.stringify({ access_token: at, token_type: "Bearer", expires_in: TOKEN_TTL, scope: "openid", id_token: idToken(g, client, g.auth_time, g.views) }));
  }

  // Returns true when it handled the request.
  async function handle(req, res, url, readForm) {
    const p = url.pathname;
    if (req.method === "GET" && p === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      res.end(JSON.stringify(discovery()));
      return true;
    }
    if (p === "/oauth2/authorize" && (req.method === "GET" || req.method === "POST")) {
      const params = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readForm(req);
      await authorize(req, res, params);
      return true;
    }
    if (p === "/oauth2/token" && req.method === "POST") {
      await tokenEndpoint(req, res, await readForm(req));
      return true;
    }
    if (p === "/oauth2/userinfo" && (req.method === "GET" || req.method === "POST")) {
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
      const u = m && (await state.get(`oat:${sha256(m[1])}`));
      res.writeHead(u && u.expires > Date.now() ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store", ...(u ? {} : { "www-authenticate": 'Bearer error="invalid_token"' }) });
      res.end(JSON.stringify(u ? { sub: u.sub, amr: u.amr, acr: u.acr } : { error: "invalid_token" }));
      return true;
    }
    let m = /^\/oauth2\/return\/([\w-]+)$/.exec(p);
    if (m && req.method === "GET") {
      const r = await state.take(`oret:${m[1]}`);
      if (!r || r.expires < Date.now()) page(res, 400, "Sign-in error", `<h1 class="pb-title">This sign-in has expired</h1><p class="pb-text">Go back to the app and start again.</p>`);
      else deliver(res, r);
      return true;
    }
    m = /^\/oauth2\/cancel\/([\w-]+)$/.exec(p);
    if (m && req.method === "GET") {
      const rid = await state.take(`ocancel:${m[1]}`);
      const r = rid && (await state.get(`oreq:${rid}`));
      if (!r) page(res, 400, "Sign-in error", `<h1 class="pb-title">This sign-in has expired</h1><p class="pb-text">Go back to the app and start again.</p>`);
      else {
        await state.del(`oreq:${r.rid}`);
        deliver(res, { redirect_uri: r.redirect_uri, mode: r.mode, params: { error: "access_denied", error_description: "The user chose another method or couldn't complete the foot check.", state: r.state } });
      }
      return true;
    }
    return false;
  }

  return { handle, onSessionComplete, cancelUrl };
}
