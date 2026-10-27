// Tester mode: scans are kept encrypted and exported only with the admin key; debug and tester mode follow the user
// from the computer to the phone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tester-"));
const app = createApp({ dataDir: dir, publicUrl: "http://feet.test", adminKey: "admin-secret" });
await new Promise(r => app.server.listen(0, r));
const base = `http://localhost:${app.server.address().port}`;
after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const client = app.store.addClient({ name: "Piggy Bank", redirect_uris: ["https://app.test/cb"] });
const basic = "Basic " + Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
const call = async (method, p, { auth, body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(auth && { authorization: auth }), "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const json = r => JSON.parse(r.text);

test("tester scans are kept, encrypted, and exported only with the admin key", async () => {
  const s = json(await call("POST", "/v1/sessions", { auth: basic, body: { user_id: "dana", purpose: "enroll" } }));
  const bearer = `Bearer ${s.session_token}`;
  assert.equal((await call("POST", "/v1/session/tester", { body: { scan: {} } })).status, 401);
  assert.equal((await call("POST", "/v1/session/tester", { auth: bearer, body: { scan: [] } })).status, 400);
  assert.equal((await call("POST", "/v1/session/tester", { auth: bearer, body: { scan: { trail: [[1, "far", "Move closer", 0]], marker: "pied 🦶" } } })).status, 200);
  const files = fs.readdirSync(path.join(dir, "tester"));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(dir, "tester", files[0])).includes("pied"), "stored encrypted");
  assert.equal((await call("GET", "/v1/admin/tester-scans")).status, 401);
  assert.equal((await call("GET", "/v1/admin/tester-scans", { auth: "Bearer nope" })).status, 401);
  const out = await call("GET", "/v1/admin/tester-scans", { auth: "Bearer admin-secret" });
  const lines = out.text.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].scan.scan.marker, "pied 🦶");
  assert.equal(lines[0].scan.purpose, "enroll");
  assert.equal(lines[0].scan.client, "Piggy Bank");
  assert.ok(!out.text.includes("dana"), "no user id in the export");
});

test("debug and tester mode follow the user to the phone", async () => {
  const s = json(await call("POST", "/v1/sessions", { auth: basic, body: { user_id: "eve", purpose: "enroll" } }));
  const link = json(await call("POST", "/v1/session/handoff", { auth: `Bearer ${s.session_token}`, body: { debug: true, tester: true } }));
  const code = link.url.split("/m/")[1];
  assert.deepEqual(json(await call("GET", `/v1/handoff/${code}`)).modes, { debug: true, tester: true });
  const claim = json(await call("POST", `/v1/handoff/${code}/claim`));
  assert.deepEqual(claim.modes, { debug: true, tester: true });
  // The phone can send tester scans with its own token.
  assert.equal((await call("POST", "/v1/session/tester", { auth: `Bearer ${claim.session_token}`, body: { scan: { from: "phone" } } })).status, 200);
});

test("without an admin key there is no export", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tester2-"));
  const a2 = createApp({ dataDir: d2, publicUrl: "http://feet.test" });
  await new Promise(r => a2.server.listen(0, r));
  const res = await fetch(`http://localhost:${a2.server.address().port}/v1/admin/tester-scans`, { headers: { authorization: "Bearer anything" } });
  assert.equal(res.status, 404);
  a2.server.close();
  fs.rmSync(d2, { recursive: true, force: true });
});
