// A simulated camera that draws feet, for demos and automated tests (<piggyback-auth source="sample">).
// "you" and "impostor" are two fixed pairs of feet; "photo" films a still photo of "you", which the toe check rejects.
export const PEOPLE = {
  you: { ball: 0.38, heel: 0.25, arch: 0.05, toes: [0.13, 0.1, 0.085, 0.07, 0.055], toeW: [0.11, 0.068, 0.063, 0.058, 0.052], skin: [212, 160, 130] },
  impostor: { ball: 0.44, heel: 0.3, arch: 0.015, toes: [0.11, 0.125, 0.1, 0.08, 0.065], toeW: [0.12, 0.075, 0.07, 0.066, 0.06], skin: [150, 102, 76] },
};
const FLOORS = [[88, 98, 112], [58, 84, 132], [66, 112, 92], [224, 226, 222], [44, 48, 54]];
// Things that get in the shot: a wooden floor edge, a beige couch, a tan slipper.
const CLUTTER = [[150, 105, 70], [205, 180, 150], [196, 150, 118], [120, 124, 130], [230, 206, 170]];
export const SW = 480;
export const SH = 640;
const shade = (rgb, f) => rgb.map(v => Math.max(0, Math.min(255, Math.round(v * f))));
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

function smoothClosed(g, pts) {
  const n = pts.length;
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    g.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]
    );
  }
  g.closePath();
}
// A pose fixes everything about a shot except the toes, so a live sequence reuses it frame to frame.
export function samplePose(rand = Math.random) {
  const jit = () => rand() - 0.5;
  const clutter = [];
  for (let k = 0, nC = 1 + Math.floor(rand() * 3); k < nC; k++) {
    clutter.push({ edge: Math.floor(rand() * 4), along: rand(), size: 0.14 + rand() * 0.16, color: CLUTTER[Math.floor(rand() * CLUTTER.length)], round: rand() < 0.5, rot: jit() });
  }
  return {
    floor: FLOORS[Math.floor(rand() * FLOORS.length)],
    split: rand() < 0.4 ? { at: 0.08 + rand() * 0.1, edge: Math.floor(rand() * 4), color: CLUTTER[Math.floor(rand() * CLUTTER.length)] } : null,
    clutter,
    len: 0.54 + rand() * 0.1,
    x: jit() * 0.06,
    y: jit() * 0.04,
    rot: jit() * 0.4,
    stretch: 0.96 + rand() * 0.08,
    toes: [0, 1, 2, 3, 4].map(() => [jit() * 0.008, jit() * 0.06, jit() * 0.05]),
    light: { ang: rand() * Math.PI * 2, gain: 0.85 + rand() * 0.3, slope: 0.12 + rand() * 0.12 },
    // Half the shots have a hard shadow on the floor next to the foot, like a leg in lamplight.
    cast: rand() < 0.5 ? { side: rand() < 0.5 ? -1 : 1, ang: 0.2 + rand() * 0.7, len: 0.5 + rand() * 0.5, alpha: 0.25 + rand() * 0.3, blur: 2 + rand() * 8 } : null,
  };
}
function drawScene(g, pose) {
  g.fillStyle = `rgb(${pose.floor})`;
  g.fillRect(0, 0, SW, SH);
  if (pose.split) {
    // A second floor tone along one edge, like a rug border.
    const s = pose.split, a = s.at;
    g.fillStyle = `rgb(${s.color})`;
    if (s.edge === 0) g.fillRect(0, 0, SW, SH * a);
    if (s.edge === 1) g.fillRect(SW * (1 - a), 0, SW * a, SH);
    if (s.edge === 2) g.fillRect(0, SH * (1 - a), SW, SH * a);
    if (s.edge === 3) g.fillRect(0, 0, SW * a, SH);
  }
  for (const c of pose.clutter) {
    const sz = c.size * SW, inset = sz * 0.25;
    const pos = [[c.along * SW, inset], [SW - inset, c.along * SH], [c.along * SW, SH - inset], [inset, c.along * SH]][c.edge];
    g.save();
    g.translate(pos[0], pos[1]);
    g.rotate(c.rot);
    g.fillStyle = `rgb(${c.color})`;
    g.beginPath();
    if (c.round) g.ellipse(0, 0, sz * 0.6, sz * 0.4, 0, 0, Math.PI * 2);
    else g.rect(-sz * 0.6, -sz * 0.35, sz * 1.2, sz * 0.7);
    g.fill();
    g.restore();
  }
}
// Uneven room light plus sensor noise.
function light(g, l, rand) {
  const img = g.getImageData(0, 0, SW, SH), d = img.data;
  const lx = Math.cos(l.ang), ly = Math.sin(l.ang);
  for (let y = 0, i = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++, i += 4) {
      const f = l.gain * (1 + l.slope * ((x / SW - 0.5) * lx + (y / SH - 0.5) * ly) * 2);
      const nz = (rand() - 0.5) * 14;
      d[i] = d[i] * f + nz;
      d[i + 1] = d[i + 1] * f + nz;
      d[i + 2] = d[i + 2] * f + nz;
    }
  }
  g.putImageData(img, 0, 0);
}
// `skin` overrides the person's skin tone (tests use it to cover a range of skin tones).
// `person` draws someone else entirely (tests use it for many different feet).
export function drawSample({ who = "you", side = "L", view = "top", rand = Math.random, pose = samplePose(rand), curl = 0, shake = null, empty = false, skin: skinTone = null, person = null } = {}) {
  const base = person || PEOPLE[who];
  const p = skinTone ? { ...base, skin: skinTone } : base;
  const c = document.createElement("canvas");
  c.width = SW;
  c.height = SH;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (shake) {
    g.translate(SW / 2 + shake.dx, SH / 2 + shake.dy);
    g.rotate(shake.rot);
    g.translate(-SW / 2, -SH / 2);
    g.scale(1.03, 1.03);
  }
  drawScene(g, pose);
  if (!empty) {
    const len = SH * pose.len, sole = view === "sole";
    g.save();
    g.translate(SW / 2 + pose.x * SW, SH / 2 + pose.y * SH);
    g.rotate(pose.rot);
    g.scale(len * pose.stretch * (side === "L" ? -1 : 1), -len);
    g.translate(0, -0.5);
    // Seen from below, the foot is the mirror image of its top view.
    if (sole) g.scale(-1, 1);
    const skin = sole ? mix(p.skin, [242, 204, 190], 0.45) : p.skin;
    // Right foot seen from above, toes up, big toe on the left. The left foot is its mirror.
    const b = p.ball / 2, hh = p.heel / 2;
    const body = [
      [0, 0], [hh * 0.85, 0.03], [hh, 0.13], [hh + (b - hh) * 0.35, 0.38], [b * 0.97, 0.62], [b * 0.92, 0.74],
      [b * 0.55, 0.8], [-b * 0.2, 0.83], [-b * 0.9, 0.8], [-b, 0.68], [-(hh + (b - hh) * 0.4) + p.arch, 0.42],
      [-hh, 0.15], [-hh * 0.85, 0.03],
    ];
    if (pose.cast && !sole) {
      // The cast shadow: a long soft band from the heel out to one side, under the foot.
      const c = pose.cast;
      g.save();
      g.filter = `blur(${c.blur}px)`;
      g.fillStyle = `rgba(0,0,0,${c.alpha})`;
      g.translate(0, 0.05);
      g.rotate(c.side * c.ang);
      g.beginPath();
      g.ellipse(c.side * 0.12, c.len * 0.45, 0.13, c.len * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    // curl 0 = toes flat, 1 = curled under; each toe curls a little differently.
    const toes = p.toes.map((tl, i) => ({
      x: [-0.62, -0.17, 0.16, 0.45, 0.72][i] * b + pose.toes[i][0],
      y: [0.79, 0.8, 0.78, 0.75, 0.71][i],
      len: tl * (sole ? 0.85 : 1) * (1 + pose.toes[i][1]) * (1 - 0.5 * curl * (0.75 + 0.25 * Math.sin(i * 1.7))),
      w: p.toeW[i],
      tilt: [-0.04, 0.05, 0.11, 0.18, 0.26][i] + pose.toes[i][2],
    }));
    const toePath = t => {
      g.beginPath();
      g.ellipse(t.x, t.y + t.len / 2, t.w / 2, t.len / 2 + t.w * 0.15, -t.tilt, 0, Math.PI * 2);
    };
    g.save();
    g.translate(0.014, -0.012);
    g.filter = "blur(6px)";
    g.fillStyle = "rgba(0,0,0,0.3)";
    toes.forEach(t => { toePath(t); g.fill(); });
    g.beginPath();
    smoothClosed(g, body);
    g.fill();
    g.restore();

    const grad = g.createRadialGradient(0, 0.5, 0.02, 0, 0.5, 0.62);
    grad.addColorStop(0, `rgb(${shade(skin, 1.08)})`);
    grad.addColorStop(0.7, `rgb(${skin})`);
    grad.addColorStop(1, `rgb(${shade(skin, 0.82)})`);
    g.fillStyle = grad;
    g.strokeStyle = `rgba(${shade(skin, 0.68)},0.7)`;
    g.lineWidth = 0.003;
    toes.forEach(t => { toePath(t); g.fill(); g.stroke(); });
    g.beginPath();
    smoothClosed(g, body);
    g.fill();
    if (sole) {
      // Creases across the ball, along the arch and around the heel pad.
      g.strokeStyle = `rgba(${shade(skin, 0.72)},0.75)`;
      g.lineWidth = 0.004;
      g.beginPath();
      g.moveTo(-b * 0.8, 0.7); g.quadraticCurveTo(0, 0.64, b * 0.8, 0.7);
      g.moveTo(-b * 0.5, 0.52); g.quadraticCurveTo(-b * 0.1, 0.45, -b * 0.2, 0.36);
      g.moveTo(b * 0.2, 0.5); g.lineTo(b * 0.35, 0.38);
      g.moveTo(-hh * 0.6, 0.2); g.quadraticCurveTo(0, 0.26, hh * 0.6, 0.2);
      g.stroke();
    } else {
      g.fillStyle = `rgb(${p.skin.map(v => Math.round((v + 245) / 2))})`;
      toes.forEach(t => {
        const ax = Math.sin(t.tilt), ay = Math.cos(t.tilt);
        g.beginPath();
        g.ellipse(t.x + ax * t.len * 0.25, t.y + t.len / 2 + ay * t.len * 0.25, t.w * 0.3, t.len * 0.2, -t.tilt, 0, Math.PI * 2);
        g.fill();
      });
    }
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  light(g, pose.light, rand);
  return c;
}
function refilm(photo, shake, rand) {
  const c = document.createElement("canvas");
  c.width = SW;
  c.height = SH;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.translate(SW / 2 + shake.dx, SH / 2 + shake.dy);
  g.rotate(shake.rot);
  g.scale(1.04, 1.04);
  g.drawImage(photo, -SW / 2, -SH / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  light(g, { ang: 0, gain: 0.96 + rand() * 0.08, slope: 0 }, rand);
  return c;
}

// The requested foot drifts in the hand, arrives after half a second, and lifts its toes when asked.
// `toes`: "up" or "down" (the scanner's cue, followed after a moment), or false while it isn't asking.
export function createSampleCamera({ who = "you" } = {}) {
  const st = { key: "", pose: null, still: null, shake: null, t: 0, curl: 0, cue: null, since: 0 };
  return {
    frame(view, toes, dt) {
      if (st.key !== view.key) {
        st.key = view.key;
        st.pose = samplePose();
        st.shake = { dx: 0, dy: 0, rot: 0 };
        st.t = 0;
        st.still = who === "photo" ? drawSample({ who: "you", side: view.side, view: view.view, pose: st.pose }) : null;
      }
      st.t += dt;
      const s = st.shake;
      s.dx = s.dx * 0.92 + (Math.random() - 0.5) * 3;
      s.dy = s.dy * 0.92 + (Math.random() - 0.5) * 3;
      s.rot = s.rot * 0.92 + (Math.random() - 0.5) * 0.012;
      if (st.t < 0.5) return drawSample({ pose: st.pose, shake: s, empty: true });
      if (st.still) return refilm(st.still, s, Math.random);
      // A person reacts to a new cue after a beat, then moves their toes over a couple of frames.
      if (toes !== st.cue) { st.cue = toes; st.since = 0; }
      st.since += dt;
      const want = toes === "up" && st.since > 0.2 ? 0.9 : 0;
      st.curl += Math.max(-0.45, Math.min(0.45, want - st.curl));
      return drawSample({ who, side: view.side, view: view.view, pose: st.pose, curl: st.curl, shake: s });
    },
  };
}
