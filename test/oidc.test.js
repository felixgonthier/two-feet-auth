// OpenID Connect front door: discovery, request validation and token endpoint errors.
// Full sign-ins through it (code + PKCE, form_post with a signed hint) run in test/e2e.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

let app, base, client, dir;
const RP = "https://idp.test/callback";
const get = (p, opts = {}) => fetch(base + p, { redirect: "manual", ...opts });
const authorize = q => get(`/oauth2/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: RP, response_type: "code", scope: "openid", state: "s1", ...q })}`);
const locParams = res => new URL(res.headers.get("location")).searchParams;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-oidc-"));
  app = createApp({ dataDir: dir, publicUrl: "http://localhost" });
  await new Promise(r => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  client = app.store.addClient({ name: "IdP", redirect_uris: [RP] });
});
after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discovery document and RS256 key", async () => {
  const d = await (await get("/.well-known/openid-configuration")).json();
  assert.equal(d.issuer, "http://localhost");
  assert.equal(d.authorization_endpoint, "http://localhost/oauth2/authorize");
  assert.deepEqual(d.id_token_signing_alg_values_supported, ["RS256"]);
  const jwks = await (await get("/.well-known/jwks.json")).json();
  assert.ok(jwks.keys.some(k => k.alg === "RS256" && k.kty === "RSA"));
});

test("unknown client or unregistered redirect_uri gets an error page, never a redirect", async () => {
  const r1 = await get(`/oauth2/authorize?client_id=nope&redirect_uri=${encodeURIComponent(RP)}&response_type=code&scope=openid`);
  assert.equal(r1.status, 400);
  const r2 = await authorize({ redirect_uri: "https://evil.test/cb" });
  assert.equal(r2.status, 400);
  assert.equal(r2.headers.get("location"), null);
});

test("bad requests are bounced back to the platform with OAuth errors", async () => {
  assert.equal(locParams(await authorize({ scope: "profile" })).get("error"), "invalid_scope");
  assert.equal(locParams(await authorize({ response_type: "token" })).get("error"), "unsupported_response_type");
  assert.equal(locParams(await authorize({ prompt: "none", login_hint: "a" })).get("error"), "interaction_required");
  assert.equal(locParams(await authorize({ code_challenge: "x", code_challenge_method: "plain", login_hint: "a" })).get("error"), "invalid_request");
  const noUser = locParams(await authorize({}));
  assert.equal(noUser.get("error"), "login_required");
  assert.equal(noUser.get("state"), "s1");
  // id_token responses need a nonce.
  const r = await authorize({ response_type: "id_token", response_mode: "fragment", login_hint: "a" });
  assert.equal(new URLSearchParams(new URL(r.headers.get("location")).hash.slice(1)).get("error"), "invalid_request");
});

test("an untrusted id_token_hint is refused", async () => {
  const fake = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from('{"iss":"https://evil.test","sub":"x"}').toString("base64url")}.sig`;
  const p = locParams(await authorize({ id_token_hint: fake }));
  assert.equal(p.get("error"), "invalid_request");
  assert.match(p.get("error_description"), /isn't trusted/);
});

test("a valid request sends the user to the hosted page to enroll first", async () => {
  const r = await authorize({ login_hint: "new.user@example.com" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^http:\/\/localhost\/hosted\?step=enroll#t=/);
});

test("token endpoint checks the client, grant type and code", async () => {
  const form = (body, headers = {}) => get("/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  assert.equal((await form({ grant_type: "authorization_code", code: "x", client_id: client.client_id, client_secret: "wrong" })).status, 401);
  const basic = { authorization: "Basic " + Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64") };
  assert.equal((await (await form({ grant_type: "password" }, basic)).json()).error, "unsupported_grant_type");
  assert.equal((await (await form({ grant_type: "authorization_code", code: "made-up", redirect_uri: RP }, basic)).json()).error, "invalid_grant");
  assert.equal((await get("/oauth2/userinfo", { headers: { authorization: "Bearer nope" } })).status, 401);
});
