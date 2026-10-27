// Shared state: two service instances behind one store, the way a load balancer would split a computer and a phone.
// Runs on the in-memory store; set PIGGYBACK_TEST_REDIS_URL=redis://localhost:6379 to run it on Redis as well.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { memoryState, redisState } from "../server/state.js";

const backends = [["memory", () => memoryState()]];
if (process.env.PIGGYBACK_TEST_REDIS_URL) backends.push(["redis", () => redisState(process.env.PIGGYBACK_TEST_REDIS_URL, { prefix: `pbtest:${process.pid}:` })]);
const cleanup = [];
after(() => cleanup.forEach(f => f()));

const basic = (id, secret) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
const call = async (base, method, p, { auth, body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(auth && { authorization: auth }), "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

for (const [name, make] of backends) {
  test(`${name}: values round-trip, expire, and take() is single-use`, async () => {
    const st = make();
    cleanup.push(() => st.close());
    const value = { text: "pied · 足 · 🦶", list: [1, 2.5, null], nested: { ok: true }, big: "x".repeat(200000) };
    await st.set("a", value, 5000);
    assert.deepEqual(await st.get("a"), value);
    assert.deepEqual(await st.take("a"), value);
    assert.equal(await st.take("a"), null);
    await st.set("b", 1, 40);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(await st.get("b"), null, "expired");
    await st.set("c", 1, 5000);
    await st.del("c", null);
    assert.equal(await st.get("c"), null);
    // Many commands in flight at once come back to the right callers.
    const got = await Promise.all(Array.from({ length: 50 }, async (_, i) => { await st.set(`k${i}`, { i }, 5000); return (await st.get(`k${i}`)).i; }));
    assert.deepEqual(got, Array.from({ length: 50 }, (_, i) => i));
  });

  test(`${name}: a computer on one instance, its phone on another`, async () => {
    const st = make();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-state-"));
    const a = createApp({ dataDir: dir, publicUrl: "http://feet.test", state: st });
    const b = createApp({ dataDir: dir, publicUrl: "http://feet.test", state: st });
    await Promise.all([a, b].map(x => new Promise(r => x.server.listen(0, r))));
    cleanup.push(() => { a.server.close(); b.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const A = `http://localhost:${a.server.address().port}`, B = `http://localhost:${b.server.address().port}`;
    const client = a.store.addClient({ name: "Piggy Bank", redirect_uris: ["https://app.test/cb"] });
    const auth = basic(client.client_id, client.client_secret);

    const { json: s } = await call(A, "POST", "/v1/sessions", { auth, body: { user_id: "dana", purpose: "enroll" } });
    const desk = `Bearer ${s.session_token}`;
    assert.equal((await call(B, "GET", "/v1/session", { auth: desk })).json.views.length, 2, "a session made on A is visible on B");
    const link = await call(A, "POST", "/v1/session/handoff", { auth: desk });
    const code = link.json.url.split("/m/")[1];
    assert.equal((await call(B, "GET", `/v1/handoff/${code}`)).json.app, "Piggy Bank");
    const claim = await call(B, "POST", `/v1/handoff/${code}/claim`);
    assert.equal(claim.status, 200);
    assert.equal((await call(A, "POST", `/v1/handoff/${code}/claim`)).status, 404, "single use across instances");
    assert.equal((await call(A, "GET", "/v1/session", { auth: desk })).json.handoff.state, "claimed");
    assert.equal((await call(A, "POST", "/v1/session/complete", { auth: `Bearer ${claim.json.session_token}` })).json.error, "phone_session");

    // The user's next step goes straight to the paired phone, whichever instance each side reaches.
    const { json: s2 } = await call(B, "POST", "/v1/sessions", { auth, body: { user_id: "dana", purpose: "enroll" } });
    const desk2 = `Bearer ${s2.session_token}`;
    assert.ok((await call(A, "GET", "/v1/session", { auth: desk2 })).json.phone_ready, "the paired phone is offered");
    const pair = `Bearer ${claim.json.pairing_token}`;
    assert.equal((await call(A, "GET", "/v1/pairing/next", { auth: pair })).json.waiting, true);
    const attached = await call(B, "POST", "/v1/session/handoff", { auth: desk2 });
    assert.equal(attached.json.attached, true);
    const next = await call(A, "GET", "/v1/pairing/next", { auth: pair });
    assert.equal(next.json.purpose, "enroll");
    assert.equal((await call(B, "GET", "/v1/session", { auth: `Bearer ${next.json.session_token}` })).json.views.length, 2);
    assert.equal((await call(A, "GET", "/v1/pairing/next", { auth: pair })).json.waiting, true, "each step is handed over once");
    // Another user's session is never offered to dana's phone.
    const { json: other } = await call(A, "POST", "/v1/sessions", { auth, body: { user_id: "eve", purpose: "enroll" } });
    assert.equal((await call(B, "GET", "/v1/session", { auth: `Bearer ${other.session_token}` })).json.phone_ready, null);
    // Asking for a fresh code skips the paired phone.
    const { json: s3 } = await call(A, "POST", "/v1/sessions", { auth, body: { user_id: "dana", purpose: "enroll" } });
    const fresh = await call(A, "POST", "/v1/session/handoff", { auth: `Bearer ${s3.session_token}`, body: { fresh: true } });
    assert.match(fresh.json.url, /\/m\/[2-9A-HJ-NP-Z]{10}$/);
  });
}
