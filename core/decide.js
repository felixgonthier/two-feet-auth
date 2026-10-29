// Pass/fail decisions for one view, on decoded frames: { w, h, format: "rgba" | "gray", px }.
// The server runs these; the local demo backend runs the same code in the browser.
import { MATCH, STEADY, LIVE, analyzePixels, compare, bestOf, meanFeatures, zones, motionOf, toeState, showsLife, grayFromRGBA } from "./engine.js";

// Frames of one view, each steadied by the last good outline before it (frame fusion). The scanner runs this on the
// frames it is about to send, so it knows exactly which ones will pass here.
export function analyzeInOrder(frames) {
  let prior = null;
  return frames.map(f => {
    const a = analyzePixels(f.px, f.w, f.h, { prior: prior?.length === f.w * f.h ? prior : null });
    if (a.ok) prior = a.geo.mask;
    return a;
  });
}
const otherSide = view => (view.side === "L" ? "right" : "left");

// Enrollment: two or more steady still frames of the right foot, for one pose of it (POSES in engine.js).
// `others` are templates just enrolled for the opposite foot's same view, to catch the same foot shown twice;
// `mine` the ones already taken of this foot, since a pose that looks more like the other foot than like this foot's
// earlier poses is the other foot again (a tilt alone never moves a foot that far).
export function decideEnroll(view, frames, others, pose = 0, mine = null) {
  const shots = analyzeInOrder(frames.filter(f => f.format === "rgba"));
  const good = shots.filter(a => a.ok);
  if (good.length < 2) return { ok: false, reason: "no_foot", message: (shots.find(a => !a.ok) || {}).message || "No foot found." };
  // Steady enough: at least two frames that agree with the frame most of the others agree with. A hand drifting a
  // little over two seconds is fine; a different pose or a blurred frame is left out instead of failing the lot.
  let keep = [];
  for (const c of good) {
    const agree = good.filter(a => a === c || compare(c.features, a.features).score >= STEADY);
    if (agree.length > keep.length) keep = agree;
  }
  if (keep.length < 2) return { ok: false, reason: "unsteady", message: "Hold the foot still inside the frame." };
  const vsOther = others?.length ? bestOf(others, keep[0].features) : 0;
  if (vsOther >= 0.86 || (mine?.length && vsOther >= 0.7 && vsOther > bestOf(mine, keep[0].features) + 0.1)) {
    return { ok: false, reason: "wrong_foot", message: `That looks like your ${otherSide(view)} foot. Show the ${view.side === "L" ? "left" : "right"} one.` };
  }
  return { ok: true, templates: keep.map(a => ({ ...a.features, pose })) };
}
// Templates of one view, grouped by the pose they were taken in (older templates have none: one group).
const byPose = list => Object.values((list || []).reduce((g, t) => ((g[t.pose ?? 0] ||= []).push(t), g), {}));
// How well a probe matches a view's templates: against the closest pose's average.
const matchScore = (list, probe) => Math.max(0, ...byPose(list).map(group => compare(meanFeatures(group), probe).score));

// Logging in, step 1: still frames that match the enrolled view. On a match, `ref` is what the toes are compared
// against in step 2: the first frame that passes (the scanner measures against the same one), in grey, with the foot's
// outline, in a form that can be stored as JSON.
export function decideMatch(view, frames, user) {
  const stills = frames.filter(f => f.format === "rgba");
  const shots = analyzeInOrder(stills).map((a, i) => ({ f: stills[i], a })).filter(x => x.a.ok);
  if (!shots.length) return { ok: false, reason: "no_foot", message: "No foot found. Fit the whole foot inside the frame." };
  // The frames that agree with most of the others, averaged, against the average of the enrolled templates.
  let keep = [];
  for (const c of shots) {
    const agree = shots.filter(x => x === c || compare(c.a.features, x.a.features).score >= STEADY);
    if (agree.length > keep.length) keep = agree;
  }
  const probe = meanFeatures(keep.map(x => x.a.features));
  const against = list => matchScore(list, probe);
  const score = against(user.views[view.key]), alt = against(user.views[view.otherKey]);
  if (score < MATCH) {
    return alt >= MATCH && alt > score
      ? { ok: false, reason: "wrong_foot", message: `That's your ${otherSide(view)} foot.`, score }
      : { ok: false, reason: "no_match", message: "That foot doesn't match.", score };
  }
  const { f, a } = shots[0], g = a.geo;
  const b64 = arr => {
    if (typeof Buffer !== "undefined") return Buffer.from(arr).toString("base64");
    let s = "";
    for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return { ok: true, score, ref: { w: f.w, h: f.h, gray: b64(grayFromRGBA(f.px, f.w, f.h)), mask: b64(g.mask), cx: g.cx, cy: g.cy, ex: g.ex, ey: g.ey, umin: g.umin, umax: g.umax } };
}
const NOT_LIVE = { ok: false, reason: "no_movement", message: "Your toes didn't move. Keep your heel down and wiggle your toes when asked." };
// Logging in, step 2: grey frames taken, in order, while the scanner asked for a toe wiggle. Each is compared with the
// frame LIVE.lag before it, in the matched frame's geometry: the toes must move, on their own, while the ring of floor
// around them stays put. A photo, however it's moved, tilted or lit, changes as one flat picture, and a finger crosses
// the ring. `ref` still says where the foot and its toes are.
export function decideLive(ref, frames) {
  const unb64 = s => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), ch => ch.charCodeAt(0)));
  const geo = { ...ref, mask: unb64(ref.mask) }, zone = zones(geo), pivot = [ref.cx, ref.cy];
  const grays = frames.filter(f => f.format === "gray" && f.w === ref.w && f.h === ref.h);
  const states = grays.map((g, i) => (i < LIVE.lag ? "between" : toeState(motionOf(g.px, grays[i - LIVE.lag].px, g.w, g.h, zone, pivot))));
  if (!showsLife(states)) return NOT_LIVE;
  return { ok: true, live: true };
}

// Both steps in one request (older clients): the match, then the same toe check on the frames that follow.
export function decideVerify(view, frames, user) {
  const m = decideMatch(view, frames, user);
  if (!m.ok) return m;
  return { ...decideLive(m.ref, frames), score: m.score };
}
