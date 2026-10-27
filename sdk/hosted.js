// The hosted page: /hosted#t=<session token>[&source=sample&who=you]
// After the views pass, the browser goes back to the app (or the identity platform) it came from.
import "./piggyback.js";

// The token comes in the fragment, which never reaches servers or logs. It's taken out of the address bar and history,
// and kept for this tab only (sessionStorage) so a reload carries on instead of losing the sign-in.
const KEPT = "piggyback.hosted";
let params = new URLSearchParams(location.hash.slice(1));
const debug = new URLSearchParams(location.search).has("debug");
history.replaceState(null, "", location.pathname + (debug ? "?debug" : ""));
try {
  if (params.get("t")) sessionStorage.setItem(KEPT, params.toString());
  else params = new URLSearchParams(sessionStorage.getItem(KEPT) || "");
} catch { /* storage blocked: a reload then needs the app to start again */ }
const forget = () => { try { sessionStorage.removeItem(KEPT); } catch {} };

const slot = document.getElementById("slot");
const token = params.get("t");
if (!token) {
  slot.innerHTML = `<div class="pb-panel"><h1 class="pb-title">No sign-in in progress</h1><p class="pb-text">This page opens from an app's sign-in, with the feet check already set up. Go back to the app you were signing in to and start again.</p></div>`;
} else {
  const el = document.createElement("piggyback-auth");
  el.setAttribute("server", location.origin);
  el.setAttribute("session-token", token);
  // ?debug on the hosted page draws the outline the scanner sees, for testing with real feet.
  if (debug || params.has("debug")) el.setAttribute("debug", "");
  if (params.get("source") === "sample") {
    el.setAttribute("source", "sample");
    el.setAttribute("sample-who", params.get("who") || "you");
  }
  // Back to the app; without a return address the scanner's own "done" state is the last word.
  // Back to the app after the success moment has had a beat (the scanner fills its "Taking you back" bar meanwhile).
  el.addEventListener("piggyback-complete", e => { forget(); if (e.detail.redirect_to) setTimeout(() => location.replace(e.detail.redirect_to), 1600); });
  // An expired or finished session can't be resumed; don't bring it back on the next reload.
  el.addEventListener("piggyback-error", e => { if (["invalid_session", "session_done", "session_failed"].includes(e.detail.error)) forget(); });
  slot.append(el);

  // A way out, like Duo's cancel: back to the app (or the identity platform) it came from, as "access denied".
  fetch("/v1/session", { headers: { authorization: `Bearer ${token}` } })
    .then(r => r.json())
    .then(s => {
      if (!s.cancel_url) return;
      const a = document.createElement("a");
      a.href = s.cancel_url;
      a.className = "pb-link";
      a.addEventListener("click", forget);
      a.textContent = s.platform ? "Use another sign-in method" : `Cancel and go back to ${s.app || "the app"}`;
      document.getElementById("exit").append(a);
    })
    .catch(() => {});
}
