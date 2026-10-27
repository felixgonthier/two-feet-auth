// Demo shell: mounts the real <piggyback-auth> element with an in-browser backend.
import "../sdk/piggyback.js";
import { LocalBackend } from "../sdk/local-backend.js";

const $ = id => document.getElementById(id);
const state = { view: "enroll", sample: false, who: "you" };
let el = null;
const ICON = { info: "i", good: "✓", bad: "!" };
const PIG = document.querySelector("header img").src;  // the logo, reused on the simulated phone

// Show a toast: kind is info, good or bad; action is [label, id, onClick].
function toast(id, kind, msg, action) {
  const t = $(id);
  t.className = `pb-toast ${kind}`;
  t.innerHTML = `<span class="ic" aria-hidden="true">${ICON[kind]}</span><span class="msg">${msg}</span><span class="acts">${action ? `<button type="button" class="pb-btn small" id="${action[1]}">${action[0]}</button>` : ""}<button type="button" class="x" aria-label="Dismiss">×</button></span>`;
  if (action) $(action[1]).addEventListener("click", action[2]);
  t.querySelector(".x").addEventListener("click", () => { t.hidden = true; });
  t.hidden = false;
}

// "Use my phone" in the demo: a simulated phone below the scanner, sharing its session, the way a real phone
// would after scanning the QR code. It asks first, then scans the sample feet.
function showPhone(phone) {
  const box = $("phone");
  const sample = el.getAttribute("sample-who") || "you";
  box.hidden = false;
  box.querySelector(".screen").innerHTML = `<div class="ask"><img src="${PIG}" alt="">
    <p class="pb-eyebrow">Continue on your phone</p>
    <h2 class="pb-title">${state.view === "enroll" ? "Enroll your feet" : "Sign in with your feet"}</h2>
    <p class="pb-text">${state.view === "enroll" ? "You'll show the camera the top of each foot, one at a time." : "One quick scan, then your toes: up, down, up."}</p>
    <span class="pb-chip dot">Started on this computer</span>
    <button type="button" class="pb-btn block">Scan my feet</button></div>`;
  box.querySelector(".ask button").addEventListener("click", () => {
    phone.claim();
    const p = document.createElement("piggyback-auth");
    p.setAttribute("mode", "phone");
    p.setAttribute("source", "sample");
    p.setAttribute("sample-who", sample);
    p.setAttribute("autostart", "");
    p.backend = phone;
    box.querySelector(".screen").replaceChildren(p);
  });
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function mount() {
  el?.remove();
  $("result").hidden = true;
  $("note").hidden = true;
  $("phone").hidden = true;
  $("phone").querySelector(".screen").replaceChildren();
  el = document.createElement("piggyback-auth");
  if (state.sample) {
    el.setAttribute("source", "sample");
    el.setAttribute("sample-who", state.view === "login" ? state.who : "you");
  }
  // The backend must be set before the element connects.
  el.backend = new LocalBackend({ purpose: state.view === "enroll" ? "enroll" : "verify" });
  if (state.sample) el.backend.onHandoff = showPhone;
  el.addEventListener("piggyback-complete", () => {
    if (state.view === "enroll") {
      toast("result", "good", "Enrolled. Both feet are saved in this browser.", ["Log in", "go-login", () => setView("login")]);
    } else {
      const [[key, score]] = Object.entries(el.backend.result);
      toast("result", "good", `You're in. ${key.replace("L.", "Left ").replace("R.", "Right ")} matched ${Math.round(score * 100)}% and the toes moved.`, ["Again", "again", mount]);
    }
    render();
  });
  el.addEventListener("piggyback-error", e => {
    if (e.detail.error === "camera_unavailable") {
      toast("note", "info", "No live camera on this page. Try sample feet, or open the demo over https.", ["Sample feet", "use-sample", () => { $("sample").checked = true; state.sample = true; mount(); }]);
    } else if (e.detail.error === "session_failed") {
      toast("result", "bad", "Access denied after 5 tries.", ["Try again", "again", mount]);
    }
  });
  $("slot").append(el);
  render();
}
function setView(view) {
  state.view = view;
  mount();
}
function render() {
  const enrolled = !!LocalBackend.user();
  $("tab-enroll").setAttribute("aria-selected", String(state.view === "enroll"));
  $("tab-login").setAttribute("aria-selected", String(state.view === "login"));
  $("tab-login").disabled = !enrolled;
  $("tab-login").title = enrolled ? "" : "Enroll first";
  $("who-row").hidden = !(state.sample && state.view === "login");
  for (const b of document.querySelectorAll("[data-who]")) b.setAttribute("aria-pressed", String(b.dataset.who === state.who));
}

$("tab-enroll").addEventListener("click", () => setView("enroll"));
$("tab-login").addEventListener("click", () => setView("login"));
$("sample").addEventListener("change", e => { state.sample = e.target.checked; mount(); });
for (const b of document.querySelectorAll("[data-who]")) b.addEventListener("click", () => { state.who = b.dataset.who; mount(); });
mount();

window.__piggybackDemo = { state, element: () => el, LocalBackend };
