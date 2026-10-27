// The phone side of "Continue on your phone": /m/<code>, opened from the QR code a computer shows.
// It says which app and computer this is for, claims the code only when the user agrees, then runs the scanner.
// The computer finishes each step by itself. If the same user's next step follows (say, the first login right after
// enrolling), it comes straight here: the user taps Continue instead of scanning another code.
import "./piggyback.js";

const slot = document.getElementById("slot");
const code = location.pathname.split("/").pop();
const params = new URLSearchParams(location.hash.slice(1));
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// How long a finished phone listens for the user's next step. Staying on this page also means the browser doesn't ask
// for the camera again; it checks often at first, then every few seconds.
const NEXT_WAIT = 30 * 60 * 1000;
const panel = html => { slot.innerHTML = `<div class="pb-panel">${html}</div>`; };
const expired = message => panel(`<h1 class="pb-title">This code has expired</h1><p class="pb-text">${esc(message || "Show a new code on your computer and scan it again.")}</p>`);
const ask = ({ eyebrow, title, chip, text, button }, onGo) => {
  panel(`<p class="pb-eyebrow">${esc(eyebrow)}</p><h1 class="pb-title">${esc(title)}</h1>
    <span class="pb-chip dot">${esc(chip)}</span><p class="pb-text">${esc(text)}</p>
    <button type="button" class="pb-btn block" id="go">${esc(button)}</button>
    <p class="note">Didn't start this on a computer just now? Close this page; nothing happens.</p>`);
  document.getElementById("go").addEventListener("click", e => { e.target.disabled = true; onGo(); }, { once: true });
};

// Run the scanner for one session; when it's done, listen for the next step. `modes`: debug and tester mode as the
// computer had them (they also come in the link, for older computers).
function scan(sessionToken, pairingToken, modes = {}) {
  const el = document.createElement("piggyback-auth");
  el.setAttribute("server", location.origin);
  el.setAttribute("session-token", sessionToken);
  el.setAttribute("mode", "phone");
  if (modes.debug || params.has("debug")) el.setAttribute("debug", "");
  if (modes.tester || params.has("tester")) el.setAttribute("tester", "");
  if (params.get("source") === "sample") {
    el.setAttribute("source", "sample");
    el.setAttribute("sample-who", params.get("who") || "you");
  }
  el.addEventListener("piggyback-handoff-done", () => waitForNext(pairingToken));
  slot.replaceChildren(el);
}
async function waitForNext(pairingToken) {
  const start = Date.now();
  while (Date.now() < start + NEXT_WAIT) {
    await new Promise(r => setTimeout(r, Date.now() - start < 3 * 60 * 1000 ? 1500 : 5000));
    const r = await fetch("/v1/pairing/next", { headers: { authorization: `Bearer ${pairingToken}` } }).catch(() => null);
    if (r?.status === 401) return;
    const next = r?.ok ? await r.json() : null;
    if (next?.session_token) {
      return ask({
        eyebrow: "One more step",
        title: next.purpose === "verify" ? `Now sign in to ${next.app}` : `Enroll your feet for ${next.app}`,
        chip: `For the ${next.device}`,
        text: next.purpose === "verify" ? "One quick scan, then curl your toes, relax them and curl them again." : "The top of each foot, one at a time.",
        button: "Continue",
      }, () => scan(next.session_token, pairingToken, next.modes));
    }
  }
}

try {
  const r = await fetch(`/v1/handoff/${encodeURIComponent(code)}`);
  const info = await r.json();
  if (!r.ok) throw new Error(info.message);
  const what = info.purpose === "enroll" ? "the top of each foot, one at a time" : `the ${info.views.map(v => v.toLowerCase().replace(" of ", " of your ")).join(", then the ")}, then lift your toes when asked`;
  ask({
    eyebrow: "Continue on your phone",
    title: `${info.purpose === "enroll" ? "Enroll your feet for" : "Sign in to"} ${info.app}`,
    chip: `Started on a ${info.device}`,
    text: `You'll show the camera ${what}. Socks off, on a plain floor.`,
    button: "Scan my feet",
  }, async () => {
    const c = await fetch(`/v1/handoff/${encodeURIComponent(code)}/claim`, { method: "POST" });
    const claimed = await c.json();
    if (!c.ok) return expired(claimed.message);
    scan(claimed.session_token, claimed.pairing_token, claimed.modes);
  });
} catch (e) {
  expired(e.message);
}
