// A stand-in for the verification service that runs inside the page, for demos with no server.
// It uses the same decision code as the server (core/decide.js) and keeps templates in this browser.
// Never use it for real logins: anyone can edit what a page stores and decides.
//
//   const el = document.createElement("piggyback-auth");
//   el.backend = new LocalBackend({ purpose: "enroll" });
//   el.backend.onHandoff = phone => …   // optional: "Use my phone" hands `phone` (a backend for a simulated phone) to you
import { VIEWS, POSES, viewByKey, validFeature } from "../core/engine.js";
import { decideEnroll, decideVerify, decideMatch, decideLive } from "../core/decide.js";

const MAX_ATTEMPTS = 5;
const memory = new Map(); // used when the browser refuses storage

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch (_) { /* fall back to memory */ }
  return memory.get(key) || {};
}
function write(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* memory only */ }
}
function shuffled(list) {
  const a = [...list], r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class LocalBackend {
  constructor({ purpose, userId = "demo", storageKey = "piggyback.demo", verifyViews = 1 } = {}) {
    Object.assign(this, { purpose, userId, storageKey });
    const all = VIEWS.map(v => v.key);
    const picked = shuffled(all).slice(0, Math.max(1, Math.min(all.length, verifyViews)));
    this.required = purpose === "enroll" ? all : all.filter(k => picked.includes(k));
    this.state = {};
    this.pending = {};
    this.failed = false;
  }
  static user(userId = "demo", storageKey = "piggyback.demo") {
    const u = read(storageKey)[userId];
    return u && VIEWS.every(v => Array.isArray(u.views?.[v.key]) && u.views[v.key].every(validFeature)) ? u : null;
  }
  static forget(userId = "demo", storageKey = "piggyback.demo") {
    const all = read(storageKey);
    delete all[userId];
    write(storageKey, all);
  }

  async getSession() {
    return { app: "the demo", purpose: this.purpose, views: this.required.map(k => ({ key: k, ok: !!this.state[k]?.ok })), handoff: this.handoffState ? { state: this.handoffState } : null };
  }
  // "Continue on your phone" without a server: the phone is simulated in the same page and shares this session.
  // The page offers it only when it sets onHandoff.
  get canHandOff() { return typeof this.onHandoff === "function"; }
  async handoff() {
    this.handoffState = "waiting";
    this.onHandoff({
      claim: () => { this.handoffState = "claimed"; },
      getSession: () => this.getSession(),
      submitView: (key, frames) => this.submitView(key, frames),
      complete: async () => { throw Object.assign(new Error("Finish on the computer that showed the code."), { code: "phone_session" }); },
    });
    // A stand-in for the QR code: with the real service it opens the phone page; here it opens the project.
    return { url: "https://github.com/felixgonthier/two-feet-auth#how-it-works", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  }
  async submitView(key, frames, { pose = null } = {}) {
    if (this.failed) throw Object.assign(new Error("Too many failed attempts. Start again."), { code: "session_failed" });
    if (!this.required.includes(key)) throw Object.assign(new Error("This session doesn't ask for that view."), { code: "view_not_requested" });
    const view = viewByKey[key], st = (this.state[key] ||= { ok: false, attempts: 0 });
    let r;
    if (this.purpose === "enroll") {
      r = decideEnroll(view, frames, this.pending[view.otherKey], pose ?? 0);
      if (r.ok) {
        this.pending[key] = [...(this.pending[key] || []).filter(t => t.pose !== (pose ?? 0)), ...r.templates];
        if (pose !== null && pose + 1 < POSES.length) return { ok: true, key, pose, next_pose: pose + 1, poses: POSES.length };
      }
    } else {
      const user = LocalBackend.user(this.userId, this.storageKey);
      if (!user) throw Object.assign(new Error("Enroll first."), { code: "not_enrolled" });
      // Same two steps as the server: match first, then the wiggle.
      const stills = frames.some(f => f.format === "rgba"), grays = frames.some(f => f.format === "gray");
      if (stills && grays) r = decideVerify(view, frames, user);
      else if (stills) {
        r = decideMatch(view, frames, user);
        if (r.ok) { st.matched = { score: r.score, ref: r.ref }; return { ok: false, matched: true, key, attempts_left: MAX_ATTEMPTS - st.attempts }; }
      } else {
        if (!st.matched) throw Object.assign(new Error("Show the foot again before wiggling."), { code: "match_first" });
        r = { ...decideLive(st.matched.ref, frames), score: st.matched.score };
        delete st.matched;
      }
    }
    st.attempts++;
    if (r.ok) Object.assign(st, { ok: true, score: r.score ?? null });
    else if (st.attempts >= MAX_ATTEMPTS) this.failed = true;
    return { ok: r.ok, key, reason: r.reason, message: r.message, attempts_left: MAX_ATTEMPTS - st.attempts, session_failed: this.failed };
  }
  async resetView(key) {
    if (this.purpose !== "enroll") throw Object.assign(new Error("Only enrollment views can be redone."), { code: "invalid_request" });
    if (this.state[key]) this.state[key].ok = false;
    delete this.pending[key];
    return { ok: true, key };
  }
  async complete() {
    if (!this.required.every(k => this.state[k]?.ok)) throw Object.assign(new Error("Not every view has passed yet."), { code: "incomplete" });
    if (this.purpose === "enroll") {
      const all = read(this.storageKey);
      all[this.userId] = { views: this.pending, enrolled_at: new Date().toISOString() };
      write(this.storageKey, all);
    }
    // No code to exchange: the result is right here (and that's why this is only for demos).
    this.result = Object.fromEntries(this.required.map(k => [k, this.state[k].score]));
    return { code: null, redirect_to: null };
  }
}
