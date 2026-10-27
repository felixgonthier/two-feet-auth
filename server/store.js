// Persistent state: registered clients (the enterprises' apps), encrypted foot templates, and the signing key.
// Files on disk keep this dependency-free; swap in a database and a KMS for production (see docs/INTEGRATION.md).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

export const TESTER_DAYS = 30;
const TESTER_MAX_BYTES = 400 * 1024 * 1024;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const b64url = buf => Buffer.from(buf).toString("base64url");

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dir, { dataKey } = {}) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true, mode: 0o700 });
    this.keysFile = path.join(dir, "keys.json");
    this.clientsFile = path.join(dir, "clients.json");
    if (!fs.existsSync(this.keysFile)) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeAtomic(this.keysFile, JSON.stringify({
        kid: b64url(crypto.randomBytes(8)),
        signing_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        data_key: crypto.randomBytes(32).toString("base64"),
      }, null, 2));
    }
    const keys = JSON.parse(fs.readFileSync(this.keysFile, "utf8"));
    if (!keys.rsa_key) {
      // RS256 key for OpenID Connect id_tokens, added to older data directories on first start.
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      Object.assign(keys, { rsa_kid: b64url(crypto.randomBytes(8)), rsa_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
      writeAtomic(this.keysFile, JSON.stringify(keys, null, 2));
    }
    this.kid = keys.kid;
    this.privateKey = crypto.createPrivateKey(keys.signing_key);
    this.publicJwk = { ...crypto.createPublicKey(this.privateKey).export({ format: "jwk" }), kid: this.kid, alg: "ES256", use: "sig" };
    this.rsaKid = keys.rsa_kid;
    this.rsaKey = crypto.createPrivateKey(keys.rsa_key);
    this.rsaJwk = { ...crypto.createPublicKey(this.rsaKey).export({ format: "jwk" }), kid: this.rsaKid, alg: "RS256", use: "sig" };
    // An env-provided key (from your KMS or secret store) wins over the generated one.
    this.dataKey = Buffer.from(dataKey || keys.data_key, "base64");
    if (this.dataKey.length !== 32) throw new Error("The data key must be 32 bytes, base64-encoded.");
  }

  // ---------- Clients ----------
  clients() {
    try { return JSON.parse(fs.readFileSync(this.clientsFile, "utf8")); } catch { return []; }
  }
  // `oidc` settings apply when the client calls the OpenID Connect endpoints (an IdP such as Okta or Entra ID):
  //   enroll_on_first_use  enroll users the first time they're sent here (default true)
  //   username_prompt      ask for the account name when the request carries no login_hint/id_token_hint (default false)
  //   amr, acr             values put in id_tokens (some IdPs require specific ones)
  //   hint_issuers         [{ issuer, jwks_uri }] whose signed id_token_hint is trusted to name the user
  // verify_views: how many of the two views (left and right top) a login asks for, picked at random (default 1).
  addClient({ name, redirect_uris = [], allowed_origins = [], oidc = {}, verify_views = 1 }) {
    const client_id = `pb_${b64url(crypto.randomBytes(9))}`;
    const client_secret = b64url(crypto.randomBytes(32));
    const list = this.clients();
    list.push({ client_id, name, secret_hash: sha256(client_secret), redirect_uris, allowed_origins, oidc, verify_views, created_at: new Date().toISOString() });
    writeAtomic(this.clientsFile, JSON.stringify(list, null, 2));
    return { client_id, client_secret };
  }
  client(id) {
    const c = this.clients().find(c => c.client_id === id);
    if (!c) return null;
    c.verify_views ??= 1;
    c.oidc = { enroll_on_first_use: true, username_prompt: false, amr: ["feet", "mfa"], acr: "urn:piggyback:mfa", hint_issuers: [], ...c.oidc };
    return c;
  }
  authenticate(id, secret) {
    const c = this.client(id);
    if (!c || typeof secret !== "string") return null;
    const a = Buffer.from(c.secret_hash, "hex"), b = Buffer.from(sha256(secret), "hex");
    return crypto.timingSafeEqual(a, b) ? c : null;
  }

  // ---------- Templates (AES-256-GCM, bound to the client and user) ----------
  userFile(clientId, userId) {
    const d = path.join(this.dir, "templates", clientId.replace(/[^\w-]/g, ""));
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return path.join(d, `${sha256(`${clientId}:${userId}`)}.json`);
  }
  getUser(clientId, userId) {
    const file = this.userFile(clientId, userId);
    if (!fs.existsSync(file)) return null;
    const box = JSON.parse(fs.readFileSync(file, "utf8"));
    const d = crypto.createDecipheriv("aes-256-gcm", this.dataKey, Buffer.from(box.iv, "base64"));
    d.setAAD(Buffer.from(`${clientId}:${userId}`));
    d.setAuthTag(Buffer.from(box.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString("utf8"));
  }
  putUser(clientId, userId, views) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.dataKey, iv);
    c.setAAD(Buffer.from(`${clientId}:${userId}`));
    const ct = Buffer.concat([c.update(JSON.stringify({ views, enrolled_at: new Date().toISOString() })), c.final()]);
    writeAtomic(this.userFile(clientId, userId), JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }));
  }
  deleteUser(clientId, userId) {
    const file = this.userFile(clientId, userId);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  // ---------- Tester scans ----------
  // What the scanner saw in tester mode (frames, its live verdicts, the server's answers), kept to improve detection.
  // Each scan is gzipped and encrypted with the data key; scans older than TESTER_DAYS are deleted, and nothing new is
  // kept once TESTER_MAX_BYTES are used.
  testerDir() {
    const d = path.join(this.dir, "tester");
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  putTesterScan(scan) {
    const d = this.testerDir(), now = Date.now();
    let used = 0;
    for (const f of fs.readdirSync(d)) {
      const file = path.join(d, f), st = fs.statSync(file);
      if (now - st.mtimeMs > TESTER_DAYS * 864e5) fs.unlinkSync(file);
      else used += st.size;
    }
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.dataKey, iv);
    c.setAAD(Buffer.from("tester"));
    const ct = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(scan))), c.final()]);
    if (used + ct.length > TESTER_MAX_BYTES) return false;
    const name = `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.bin`;
    fs.writeFileSync(path.join(d, name), Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 });
    return name;
  }
  // Every kept scan, oldest first: { name, scan }.
  *testerScans() {
    const d = this.testerDir();
    for (const name of fs.readdirSync(d).filter(f => f.endsWith(".bin")).sort()) {
      const buf = fs.readFileSync(path.join(d, name));
      const dc = crypto.createDecipheriv("aes-256-gcm", this.dataKey, buf.subarray(0, 12));
      dc.setAAD(Buffer.from("tester"));
      dc.setAuthTag(buf.subarray(12, 28));
      yield { name, scan: JSON.parse(zlib.gunzipSync(Buffer.concat([dc.update(buf.subarray(28)), dc.final()]))) };
    }
  }
  deleteTesterScans() {
    const d = this.testerDir(), files = fs.readdirSync(d);
    for (const f of files) fs.unlinkSync(path.join(d, f));
    return files.length;
  }
}
