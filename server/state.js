// Short-lived shared state: sessions, one-time codes, phone links and OpenID Connect requests, as JSON with a TTL.
// In memory by default, which is right for one instance. With PIGGYBACK_REDIS_URL, every instance shares it,
// so a computer and a phone can land on different servers. The Redis client is built in (no dependencies).
//
//   const state = createState(process.env.PIGGYBACK_REDIS_URL);
//   await state.set("ses:abc", { … }, 60_000); await state.get("ses:abc"); await state.take("code:…");
import net from "node:net";
import tls from "node:tls";

export const createState = url => (url ? redisState(url) : memoryState());

export function memoryState() {
  const m = new Map();  // key → { v: JSON text, exp: ms }
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, e] of m) if (e.exp < now) m.delete(k); }, 30000);
  sweep.unref();
  const get = k => {
    const e = m.get(k);
    if (!e || e.exp < Date.now()) { m.delete(k); return null; }
    return JSON.parse(e.v);
  };
  return {
    kind: "memory",
    async get(k) { return get(k); },
    async set(k, v, ttl) { m.set(k, { v: JSON.stringify(v), exp: Date.now() + Math.max(1, ttl) }); },
    async del(...keys) { keys.forEach(k => k && m.delete(k)); },
    async take(k) { const v = get(k); m.delete(k); return v; },
    close() { clearInterval(sweep); },
  };
}

// redis://[user:password@]host[:port][/db], or rediss:// for TLS. Needs Redis 6.2+ (GETDEL).
export function redisState(url, { prefix = "pb:" } = {}) {
  const u = new URL(url);
  let sock = null, buf = Buffer.alloc(0);
  const queue = [];  // replies are matched to commands in order

  const encode = args => Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.map(a => { const b = Buffer.from(String(a)); return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")]); })]);
  // One reply starting at byte i: [value, next index], or null when it hasn't fully arrived.
  function parse(i) {
    const end = buf.indexOf("\r\n", i);
    if (end < 0) return null;
    const type = String.fromCharCode(buf[i]), line = buf.toString("utf8", i + 1, end);
    if (type === "+") return [line, end + 2];
    if (type === "-") return [new Error(`Redis: ${line}`), end + 2];
    if (type === ":") return [Number(line), end + 2];
    if (type === "$") {
      const n = Number(line);
      if (n < 0) return [null, end + 2];
      return buf.length < end + 4 + n ? null : [buf.toString("utf8", end + 2, end + 2 + n), end + 4 + n];
    }
    if (type === "*") {
      const n = Number(line), items = [];
      let j = end + 2;
      for (let k = 0; k < n; k++) { const r = parse(j); if (!r) return null; items.push(r[0]); j = r[1]; }
      return [n < 0 ? null : items, j];
    }
    throw new Error(`Redis: unexpected reply ${JSON.stringify(type)}`);
  }
  function drain() {
    for (let r; buf.length && (r = parse(0)); ) {
      buf = buf.subarray(r[1]);
      const p = queue.shift();
      if (p) r[0] instanceof Error ? p.reject(r[0]) : p.resolve(r[0]);
    }
  }
  function connect() {
    const opts = { host: u.hostname, port: Number(u.port) || 6379 };
    sock = u.protocol === "rediss:" ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
    sock.setNoDelay(true);
    sock.on("data", d => { buf = Buffer.concat([buf, d]); drain(); });
    const down = err => {
      sock = null;
      buf = Buffer.alloc(0);
      while (queue.length) queue.shift().reject(err || new Error("Redis: connection closed"));
    };
    sock.on("error", down);
    sock.on("close", () => down());
    // Sign in and pick the database before anything else goes out.
    if (u.password) command(u.username ? ["AUTH", decodeURIComponent(u.username), decodeURIComponent(u.password)] : ["AUTH", decodeURIComponent(u.password)]).catch(() => {});
    if (u.pathname.length > 1) command(["SELECT", u.pathname.slice(1)]).catch(() => {});
  }
  function command(args) {
    if (!sock) connect();
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
      sock.write(encode(args));
    });
  }
  const parseJson = v => (v == null ? null : JSON.parse(v));
  return {
    kind: "redis",
    command,
    async get(k) { return parseJson(await command(["GET", prefix + k])); },
    async set(k, v, ttl) { await command(["SET", prefix + k, JSON.stringify(v), "PX", Math.max(1, Math.ceil(ttl))]); },
    async del(...keys) { const ks = keys.filter(Boolean); if (ks.length) await command(["DEL", ...ks.map(k => prefix + k)]); },
    async take(k) { return parseJson(await command(["GETDEL", prefix + k])); },
    close() { sock?.end(); sock = null; },
  };
}
