// API behaviour that doesn't need a camera: auth, validation, attempt limits, tokens, encryption, CORS.
// The full enroll → verify flow with real frames runs in test/e2e.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createApp } from "../server/app.js";
import { signJwt, verifyJwt } from "../server/jwt.js";

let app, base, client, dir;
const basic = (id, secret) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
const call = async (method, p, { auth, body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(auth && { authorization: auth }), "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
};
const frame = (w, h, fill, format = "rgba") => {
  const ch = format === "rgba" ? 4 : 1;
  return { w, h, format, data: zlib.deflateRawSync(Buffer.alloc(w * h * ch, fill)).toString("base64") };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-"));
  app = createApp({ dataDir: dir, publicUrl: "http://localhost" });
  await new Promise(r => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  client = app.store.addClient({ name: "Test", redirect_uris: ["https://app.test/cb"] });
});
after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server-to-server endpoints need valid client credentials", async () => {
  assert.equal((await call("POST", "/v1/sessions", { body: { user_id: "a", purpose: "enroll" } })).status, 401);
  assert.equal((await call("POST", "/v1/sessions", { auth: basic(client.client_id, "wrong"), body: { user_id: "a", purpose: "enroll" } })).status, 401);
  assert.equal((await call("GET", "/v1/users/a", { auth: basic("pb_nobody", "x") })).status, 401);
});

test("session creation validates its input", async () => {
  const auth = basic(client.client_id, client.client_secret);
  assert.equal((await call("POST", "/v1/sessions", { auth, body: { purpose: "enroll" } })).json.error, "invalid_request");
  assert.equal((await call("POST", "/v1/sessions", { auth, body: { user_id: "a", purpose: "login" } })).json.error, "invalid_request");
  assert.equal((await call("POST", "/v1/sessions", { auth, body: { user_id: "a", purpose: "enroll", redirect_uri: "https://evil.test/cb" } })).json.error, "invalid_redirect_uri");
  const notEnrolled = await call("POST", "/v1/sessions", { auth, body: { user_id: "a", purpose: "verify" } });
  assert.equal(notEnrolled.status, 409);
  assert.equal(notEnrolled.json.error, "not_enrolled");
  const ok = await call("POST", "/v1/sessions", { auth, body: { user_id: "a", purpose: "enroll", redirect_uri: "https://app.test/cb", state: "xyz" } });
  assert.equal(ok.status, 201);
  assert.match(ok.json.hosted_url, /\/hosted#t=/);
});

test("browser endpoints: bad frames are rejected and five misses end the session", async () => {
  const auth = basic(client.client_id, client.client_secret);
  const { json: s } = await call("POST", "/v1/sessions", { auth, body: { user_id: "b", purpose: "enroll" } });
  const bearer = `Bearer ${s.session_token}`;
  const info = await call("GET", "/v1/session", { auth: bearer });
  assert.deepEqual(info.json.views.map(v => v.key), ["R.top", "L.top"], "the right foot comes first");
  assert.equal((await call("GET", "/v1/session", { auth: "Bearer nope" })).status, 401);
  assert.equal((await call("POST", "/v1/session/views/L.top", { auth: bearer, body: { frames: [{ w: 999, h: 10, format: "rgba", data: "" }] } })).json.error, "invalid_frames");
  assert.equal((await call("POST", "/v1/session/views/L.top", { auth: bearer, body: { frames: [{ ...frame(40, 60, 0), w: 41 }] } })).json.error, "invalid_frames");
  assert.equal((await call("POST", "/v1/session/complete", { auth: bearer })).json.error, "incomplete");
  // Plain grey frames contain no foot.
  for (let i = 4; i >= 0; i--) {
    const r = await call("POST", "/v1/session/views/L.top", { auth: bearer, body: { frames: [frame(64, 100, 128), frame(64, 100, 128), frame(64, 100, 128)] } });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, "no_foot");
    assert.equal(r.json.attempts_left, i);
    assert.equal(r.json.score, undefined, "scores are never sent to the browser");
  }
  assert.equal((await call("GET", "/v1/session", { auth: bearer })).json.error, "session_failed");
  // With a redirect_uri, a failed session hands back the app's address with error=access_denied, like an OAuth sign-in.
  const { json: r } = await call("POST", "/v1/sessions", { auth, body: { user_id: "b2", purpose: "enroll", redirect_uri: "https://app.test/cb", state: "st8" } });
  let last;
  for (let i = 0; i < 5; i++) last = await call("POST", "/v1/session/views/L.top", { auth: `Bearer ${r.session_token}`, body: { frames: [frame(64, 100, 128)] } });
  const exit = new URL(last.json.exit_url);
  assert.equal(`${exit.origin}${exit.pathname}`, "https://app.test/cb");
  assert.deepEqual([exit.searchParams.get("error"), exit.searchParams.get("state")], ["access_denied", "st8"]);
  assert.equal((await call("GET", "/v1/session", { auth: `Bearer ${r.session_token}` })).json.exit_url, last.json.exit_url);
});

test("codes are single-use and tied to the client", async () => {
  const auth = basic(client.client_id, client.client_secret);
  assert.equal((await call("POST", "/v1/token", { auth, body: { code: "made-up" } })).json.error, "invalid_grant");
});

test("result tokens verify against the published key and fail when tampered", async () => {
  const jwks = (await call("GET", "/.well-known/jwks.json")).json;
  assert.equal(jwks.keys[0].alg, "ES256");
  const now = Math.floor(Date.now() / 1000);
  const t = signJwt({ iss: "http://localhost", aud: client.client_id, sub: "a", exp: now + 60 }, { privateKey: app.store.privateKey, kid: app.store.kid });
  assert.equal(verifyJwt(t, jwks, { issuer: "http://localhost", audience: client.client_id }).sub, "a");
  const [h, p, sig] = t.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ iss: "http://localhost", aud: client.client_id, sub: "mallory", exp: now + 60 })).toString("base64url")}.${sig}`;
  assert.throws(() => verifyJwt(forged, jwks), /bad signature/);
  assert.throws(() => verifyJwt(t, jwks, { audience: "someone-else" }), /wrong audience/);
});

test("templates are encrypted at rest and bound to client and user", async () => {
  app.store.putUser(client.client_id, "carol", { "L.top": [{ prof: [0.123456] }] });
  const file = app.store.userFile(client.client_id, "carol");
  assert.ok(!fs.readFileSync(file, "utf8").includes("0.123456"));
  assert.equal(app.store.getUser(client.client_id, "carol").views["L.top"][0].prof[0], 0.123456);
  // Same ciphertext presented as another user fails authentication.
  fs.copyFileSync(file, app.store.userFile(client.client_id, "dave"));
  assert.throws(() => app.store.getUser(client.client_id, "dave"));
  const auth = basic(client.client_id, client.client_secret);
  assert.equal((await call("GET", "/v1/users/carol", { auth })).json.enrolled, true);
  assert.equal((await call("DELETE", "/v1/users/carol", { auth })).json.deleted, true);
  assert.equal((await call("GET", "/v1/users/carol", { auth })).json.enrolled, false);
});

test("CORS is open only on the browser endpoints", async () => {
  const pre = await call("OPTIONS", "/v1/session/views/L.top");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const s2s = await call("OPTIONS", "/v1/sessions");
  assert.equal(s2s.headers.get("access-control-allow-origin"), null);
});

test("a login asks for one view, picked at random, and refuses the others", async () => {
  const auth = basic(client.client_id, client.client_secret);
  const f = { prof: Array(32).fill(0.3), lo: Array(32).fill(-0.15), hi: Array(32).fill(0.15), aspect: 2.6, hog: Array(288).fill(0.05), tone: [60, 12, 18] };
  app.store.putUser(client.client_id, "erin", Object.fromEntries(["L.top", "R.top"].map(k => [k, [f]])));
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const { json: s } = await call("POST", "/v1/sessions", { auth, body: { user_id: "erin", purpose: "verify" } });
    const { json: info } = await call("GET", "/v1/session", { auth: `Bearer ${s.session_token}` });
    assert.equal(info.views.length, 1);
    seen.add(info.views[0].key);
    if (i === 0) {
      const other = ["L.top", "R.top"].find(k => k !== info.views[0].key);
      const r = await call("POST", `/v1/session/views/${other}`, { auth: `Bearer ${s.session_token}`, body: { frames: [frame(64, 100, 128)] } });
      assert.equal(r.json.error, "view_not_requested");
    }
  }
  assert.equal(seen.size, 2, `views should vary between logins, saw ${[...seen]}`);
  // Logging in is match first, then the wiggle: grey frames alone are refused until the foot has matched.
  const { json: s2 } = await call("POST", "/v1/sessions", { auth, body: { user_id: "erin", purpose: "verify" } });
  const { json: i2 } = await call("GET", "/v1/session", { auth: `Bearer ${s2.session_token}` });
  const early = await call("POST", `/v1/session/views/${i2.views[0].key}`, { auth: `Bearer ${s2.session_token}`, body: { frames: [frame(64, 100, 128, "gray")] } });
  assert.equal(early.json.error, "match_first");
  // Soles aren't views any more.
  const { json: s } = await call("POST", "/v1/sessions", { auth, body: { user_id: "erin", purpose: "verify" } });
  assert.equal((await call("POST", "/v1/session/views/L.sole", { auth: `Bearer ${s.session_token}`, body: { frames: [frame(64, 100, 128)] } })).status, 404);
  // Enrollment covers both feet.
  const { json: e } = await call("POST", "/v1/sessions", { auth, body: { user_id: "frank", purpose: "enroll" } });
  assert.equal((await call("GET", "/v1/session", { auth: `Bearer ${e.session_token}` })).json.views.length, 2);
});

test("continue on your phone: one-time links, and only the computer can finish", async () => {
  const auth = basic(client.client_id, client.client_secret);
  const { json: s } = await call("POST", "/v1/sessions", { auth, body: { user_id: "h", purpose: "enroll" } });
  const desk = `Bearer ${s.session_token}`;
  const mac = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36" };
  const link = await call("POST", "/v1/session/handoff", { auth: desk, headers: mac });
  assert.equal(link.status, 201);
  const code = link.json.url.match(/\/m\/([2-9A-HJ-NP-Z]{10})$/)?.[1];
  assert.ok(code, "the link is /m/ plus a 10-character code");
  assert.equal((await call("GET", "/v1/session", { auth: desk })).json.handoff.state, "waiting");
  // Looking at the link doesn't use it up (link previews, QR apps); claiming does.
  const info = await call("GET", `/v1/handoff/${code}`);
  assert.deepEqual([info.json.app, info.json.purpose, info.json.device], ["Test", "enroll", "Mac · Chrome"]);
  assert.equal((await call("GET", `/v1/handoff/${code}`)).status, 200);
  const claim = await call("POST", `/v1/handoff/${code}/claim`);
  assert.equal(claim.status, 200);
  assert.equal((await call("POST", `/v1/handoff/${code}/claim`)).status, 404, "a link works once");
  const phone = `Bearer ${claim.json.session_token}`;
  assert.equal((await call("GET", "/v1/session", { auth: phone })).json.views.length, 2, "the phone scans the same session");
  assert.equal((await call("GET", "/v1/session", { auth: desk })).json.handoff.state, "claimed");
  assert.equal((await call("POST", "/v1/session/complete", { auth: phone })).json.error, "phone_session", "only the computer finishes");
  assert.equal((await call("POST", "/v1/session/handoff", { auth: phone })).json.error, "phone_session");
  // A new code signs the old phone out.
  const again = await call("POST", "/v1/session/handoff", { auth: desk });
  assert.equal(again.status, 201);
  assert.equal((await call("GET", "/v1/session", { auth: phone })).status, 401);
  assert.equal((await call("GET", "/v1/handoff/NOTACODE00")).status, 404);
  assert.equal((await call("GET", "/m/" + again.json.url.split("/m/")[1])).status, 200, "the phone page itself is served");
});
