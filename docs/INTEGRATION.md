# Integrating Piggyback

Piggyback is a second factor. Your login flow checks the password (or SSO) as usual, then asks this service to confirm the user's feet. The service answers with a **signed result token** your backend verifies. Nothing in the browser can grant access by itself.

```
 Your app / IdP backend            Piggyback service                 User's browser
 ──────────────────────            ───────────────────                 ──────────────
 1. POST /v1/sessions  ─────────▶  session_token + hosted_url
 2. redirect or embed  ────────────────────────────────────────────▶  camera scans the view(s) asked for
                                   ◀──── frames per view ───────────  (top of each foot)
                                   decides match + toe wiggle
                                   ──── code ──────────────────────▶  back to your redirect_uri
 3. POST /v1/token {code} ──────▶  result_token (ES256 JWT)
 4. verify JWT with JWKS, check sub/aud/amr → mark MFA done
```

## What the user does

- **Enroll** (once): the top of each foot. Each is saved after a couple of seconds held still, then shown back so the user can redo it before moving on. (Soles were dropped: a sole held up to a camera turns and tilts too much to match reliably.)
- **Verify** (each login): one foot, picked at random by the server, must match; then the scanner prompts for toes up, down, then up again while the heel stays down. Unpredictable views stop someone preparing the right photo; the prompts stop photos however they're moved (see [Liveness](#liveness)). Register a client with `--verify-views 2` to ask for both.

## On a computer: continue on the phone

A laptop webcam can't see feet, so on a computer the scanner leads with **Use my phone**. It works the same in every integration below, with nothing extra to build:

1. The computer shows a QR code in the lens. It holds a one-time link, `https://feet.example.com/m/<code>`, valid for 2 minutes and refreshed automatically. It never contains the session token.
2. The phone's camera opens the link in the browser, with no app to install. The page says which app and which computer it's for ("Sign in to Piggy Bank · Started on a Mac · Chrome") and claims the link only when the user taps **Scan my feet**. A link works once, and showing a new code signs out any phone that claimed the old one.
3. The phone scans with its own token, which can send frames but can't finish the session. The computer follows along (the steps tick and the line around the lens fills) and, once every view has passed, finishes by itself: the redirect, `piggyback-complete` and the OpenID Connect return all happen on the computer, as usual.

4. **The next step comes straight to the same phone.** For 10 minutes after a phone takes a step, the same user's next session for the same app (typically the first login right after enrolling) skips the QR code. The computer hands it to that phone, which shows "One more step · Now sign in to Piggy Bank" and waits for a tap on **Continue**. The computer offers **Show a code** in case the phone has gone. Nothing carries over to another user or another app.

**Use this computer** stays available next to it. Phones and tablets skip the QR code and scan directly. Set `handoff="off"` on the element to turn it off, or `handoff="on"` to force it.

The phone has to reach the service, so `PUBLIC_URL` must be an https address it can open. To try it from your own machine, put the service behind a tunnel and start it with that address:

```bash
cloudflared tunnel --url http://localhost:8787          # or: ngrok http 8787
PUBLIC_URL=https://<the-tunnel-address> npm start
```

## 1. Register your app

```bash
node server/cli.js add-client --name "Piggy Bank" --redirect-uri https://your.app/mfa/feet/callback
# → { "client_id": "pb_…", "client_secret": "…" }   (the secret is shown once)
```

Every server-to-server call uses HTTP Basic auth with `client_id:client_secret`. Users and templates are partitioned per client.

## 2. Pick an integration

### A. Redirect (works with any stack, like Duo's Universal Prompt)

```js
// After the password step succeeds:
const { enrolled } = await feet.get(`/v1/users/${encodeURIComponent(userId)}`);
const state = randomString();                       // store in the user's session
const s = await feet.post("/v1/sessions", {
  user_id: userId,
  purpose: enrolled ? "verify" : "enroll",
  redirect_uri: "https://your.app/mfa/feet/callback",
  state,
});
res.redirect(s.hosted_url);

// GET /mfa/feet/callback?code=…&state=…
if (req.query.state !== session.state) throw new Error("state mismatch");
const { result_token } = await feet.post("/v1/token", { code: req.query.code });
const claims = verifyJwt(result_token, jwks, { issuer: FEET_URL, audience: CLIENT_ID });
if (claims.sub !== userId) throw new Error("wrong user");
if (claims.purpose === "enroll") return res.redirect("/mfa");   // enrolled → now verify
session.mfa = true;
```

**Handle `error` on your callback.** The hosted page has a cancel link, and too many failed tries end the session too; both come back to your `redirect_uri` with `error=access_denied` (and your `state`), like an OAuth sign-in. Offer to try again, or to sign in as someone else.

### B. Embedded (the scanner inside your own page)

```html
<script type="module" src="https://feet.example.com/sdk/piggyback.js"></script>
<piggyback-auth server="https://feet.example.com" session-token="{{ session_token }}"></piggyback-auth>
<script>
  document.querySelector("piggyback-auth").addEventListener("piggyback-complete", e =>
    fetch("/mfa/feet/exchange", { method: "POST", body: JSON.stringify({ code: e.detail.code }) }));
</script>
```

Create the session exactly as in A, without `redirect_uri`, and pass `session_token` to the page. Your backend exchanges the code the same way.

Element events: `piggyback-complete { code, redirect_to }`, `piggyback-view { key, ok, reason, message }`, `piggyback-error { error, message }` (`camera_unavailable`, `session_failed`, `invalid_session`, `network`). On `piggyback-error`, offer your other factor. On a computer the element offers the phone handoff described above; `piggyback-complete` still fires on the computer.

Theme it with CSS custom properties: `--pb-accent`, `--pb-accent-ink`, `--pb-bg`, `--pb-ink`, `--pb-muted`, `--pb-good`, `--pb-bad`, `--pb-font`. It adapts to a narrow container on its own.

### C. Behind an identity platform (OpenID Connect)

Piggyback is also an **OpenID Connect provider**, which is how Okta, Microsoft Entra ID, Ping, Keycloak and Auth0 plug in external factors. The platform has already identified the user; it sends them here naming that user, we run the foot check (enrolling on first use), and return an `id_token` whose `sub` is that user.

What every platform needs from you:

| Setting | Value |
|---|---|
| Discovery / metadata URL | `https://feet.example.com/.well-known/openid-configuration` |
| Issuer | `https://feet.example.com` |
| Authorization endpoint | `https://feet.example.com/oauth2/authorize` |
| Token endpoint | `https://feet.example.com/oauth2/token` (client_secret_basic or client_secret_post) |
| User info / JWKS | `/oauth2/userinfo`, `/.well-known/jwks.json` (id_tokens are RS256) |
| Client ID / secret | from `node server/cli.js add-client --name "<platform>" --redirect-uri <the platform's callback URL>` |
| Scope | `openid` |

How the user is named, in order: a signed `id_token_hint` from an issuer you trust (`--hint-issuer`), else `login_hint`, else (if you add `--username-prompt`) a page asking for the account name. Without any of these the platform gets `login_required`.

Supported: `response_type=code` (PKCE S256 optional) with `response_mode=query`, and `response_type=id_token` with `response_mode=form_post` or `fragment` (nonce required). `prompt=none` returns `interaction_required`. The hosted page has a **Use another sign-in method** link that returns `error=access_denied` so the platform can fall back.

Per-platform notes. These follow each platform's documented model for external OIDC factors; none has been tried against a live tenant yet, so check the platform's current docs for exact field names:

| Platform | Where it goes |
|---|---|
| **Okta** | Add an OpenID Connect Identity Provider with the values above, then use it as an IdP authenticator in your authentication policy. Map the IdP username to `idpuser.subject`; make sure Okta passes the user (login_hint), or create the client with `--username-prompt`. |
| **Microsoft Entra ID** | External Authentication Methods: register the discovery URL and client ID. Entra sends a signed `id_token_hint` and expects an `id_token` back by `form_post` with specific `amr`/`acr` values. Create the client with `--hint-issuer <Entra issuer>=<its JWKS URL>` and the `--amr` / `--acr` values Microsoft lists. We echo `oid`, `tid` and `preferred_username` from the hint. |
| **Ping (PingOne / PingFederate)** | Add an external OpenID Connect IdP with the values above and call it as a step in your authentication policy. |
| **Keycloak** | Add an OpenID Connect v1.0 Identity Provider with the discovery URL, then put it in a post-login flow (or write a small Authenticator that redirects with `login_hint`). |
| **Auth0** | Either an enterprise OIDC connection used for step-up, or the Action sketch below using the plain API. |
| **Your own backend** | Pattern A or B. |

The browser test (`npm run test:e2e`) drives two stand-in platforms through these flows: code + PKCE with `login_hint`, and `form_post` with an RS256-signed `id_token_hint`. It also checks single-use codes, a forged hint and the cancel path.

Auth0 Action sketch (not yet tested against a live tenant; Auth0 adds its own `state` to the redirect, which the hosted page must pass back to `/continue`):

```js
exports.onExecutePostLogin = async (event, api) => {
  const s = await feetPost("/v1/sessions", { user_id: event.user.user_id, purpose: "verify",
    redirect_uri: `https://${event.request.hostname}/continue` });
  api.redirect.sendUserTo(s.hosted_url);
};
exports.onContinuePostLogin = async (event, api) => {
  const { result_token } = await feetPost("/v1/token", { code: event.request.query.code });
  const claims = await verifyResult(result_token);               // JWKS check, sub === event.user.user_id
  api.authentication.recordMethod("https://feet.example.com/mfa");
};
```

## 3. Verify the result token

`result_token` is an ES256 JWT. Fetch keys from `/.well-known/jwks.json` (cache them) and check:

| Claim | Must be |
|---|---|
| `iss` | your Piggyback URL |
| `aud` | your `client_id` |
| `sub` | the user you started the session for |
| `exp` | in the future (tokens last 5 minutes) |
| `purpose` | `verify` to grant access (`enroll` only confirms enrollment) |
| `amr` | contains `feet` and `liveness` |

`views` carries the per-view scores for your audit log. Any JWT library works (`jose`, `jsonwebtoken`, `PyJWT`, `golang-jwt`); `server/jwt.js` has a dependency-free `verifyJwt`.

## API reference

Server-to-server (Basic auth):

| Method | Path | Body / result |
|---|---|---|
| POST | `/v1/sessions` | `{ user_id, purpose: "enroll"\|"verify", redirect_uri?, state? }` → `{ session_id, session_token, hosted_url, expires_at }`. 409 `not_enrolled` for verify on an unknown user. |
| POST | `/v1/token` | `{ code }` → `{ result_token, claims, expires_in }`. Codes are single-use, last 60 s and only work for the client that started the session. |
| GET | `/v1/users/:user_id` | `{ enrolled, enrolled_at, views }` |
| DELETE | `/v1/users/:user_id` | Removes the user's templates (account deletion, re-enrollment, consent withdrawal). |

Browser (Bearer `session_token`, CORS open, used by the element):

| Method | Path | |
|---|---|---|
| GET | `/v1/session` | `cancel_url`: where the page's cancel link goes (your `redirect_uri` with `error=access_denied` and your `state`, or the identity platform's cancel), purpose, the views this session asks for (both feet to enroll, the randomly picked one(s) to log in) with `ok` per view, `handoff: { state: "waiting"\|"offered"\|"claimed", device, expires_at }` once a phone is involved, and `phone_ready` (the paired phone's device) when the user's phone can take this step without a code |
| POST | `/v1/session/views/:key` | `{ frames: [{ w, h, format: "rgba"\|"gray", data, cue }] }`, data = base64 of deflate-raw pixels, ≤ 256 px a side. Returns `{ ok, reason, message, attempts_left }`; scores are never sent to the browser. Logging in takes two calls: still (`rgba`) frames first, answered with `{ matched: true }` if the foot matches (no try used), then `gray` frames taken while the scanner prompted toes up, down, up, each with `cue` (0, 1, 2: which prompt was showing), checked against the first still that passed (409 `match_first` without a match in the last minute). Sending both at once still works. |
| POST | `/v1/session/views/:key/reset` | Enrollment only: take that view again before finishing (the user's "Redo"). Failed tries still count. |
| POST | `/v1/session/complete` | → `{ code, redirect_to }` once every requested view passed. Not allowed with a phone's token (403 `phone_session`). |
| POST | `/v1/session/handoff` | → `{ url, expires_at }`: a one-time phone link (2 minutes). A new one replaces the old one and signs out any phone. If the user's phone is paired (see above), → `{ url: null, attached: true, device }` instead; send `{ "fresh": true }` to get a code anyway. |

Phone page (no auth; the code in the link is the secret, and it works once):

| Method | Path | |
|---|---|---|
| GET | `/m/:code` | The phone page. Opening it doesn't use up the code, so link previews can't spend it. |
| GET | `/v1/handoff/:code` | `{ app, purpose, device, expires_at }`, shown before the user agrees |
| POST | `/v1/handoff/:code/claim` | → `{ session_token, pairing_token }` for the phone; 404 `handoff_invalid` if expired or already used |
| GET | `/v1/pairing/next` | Bearer `pairing_token`. → `{ session_token, purpose, app, device }` when the user's next step was handed to this phone, else `{ waiting: true }`; 401 once the pairing has expired (10 minutes) |

Front page: `/` (says what the service is). Discovery: `/.well-known/piggyback-configuration`, keys: `/.well-known/jwks.json`, hosted page: `/hosted#t=<session_token>`.

## How the foot is found

Every frame is cropped to the guide area and looked at three ways; the outline that sits on the sharpest colour edge wins:

- **Skin colour against the floor:** skin-hued pixels that differ from the floor colours at the frame's edge.
- **FootNet:** a tiny per-pixel model (10 inputs, 12 hidden units, 145 numbers, in `core/footnet.js`). It's trained on drawn feet over many floors, skin tones, lights and shadows; retrain with `npm run train:footnet`.
- **Learnt colours:** the foot's colours from the middle of the guide and the floor's from the edges, refined a few times. It's slower, so it only runs when the first two disagree.

Then it has to look like a foot: mostly skin-coloured (checked as seen and after a simple white balance, so bluish or yellowish light doesn't count against real skin) and wider at the toes than at the heel, with toes: the front edge has to show at least two separate bumps, where a skin-coloured blob is one smooth curve. A bare ankle or leg joined at the heel is cut off where the outline narrows and widens again, since how much leg shows changes with distance and would shift every measurement. The scanner finds the foot anywhere from about a third of the guide's height to nearly all of it (otherwise it says "Move closer" or "Move back"), then cuts the frames it measures and sends from the full camera picture around the foot, so the foot runs about 72% of their height at any distance: enrollment and every login are measured at the same scale. The server accepts 45% to 96%. A frame too dark to find anything in says "Too dark". Nothing in the first 0.7 s after the camera starts counts, while its exposure settles.

Floor in shadow (a darker version of the floor's own colour) is offered as floor too. Each frame is steadied by the previous good outline (frame fusion), and a few odd frames in a row (a jolt, motion blur) don't reset the hold-still countdown: it counts the recent frames that agree with one another, the same test the server makes on an enrollment. Before sending, the scanner runs the server's own analysis on the frames, so a frame the server would reject never uses up a try. The toes are taken to be at the top of the frame, as the user is told, so a bare ankle at the heel can't flip the foot around.

**Matching** compares the foot's outline, width profile, proportions, skin texture and tone with the enrolled ones. Shapes are compared relative to the foot's own width as well as its length, so a phone held at a slight angle (which makes the foot look shorter) still matches; overall proportions count less for the same reason. On drawn feet it holds up to a foot turned 50°, a phone tilted so the foot looks 15% shorter, warm or cool light, another floor, shadows and a different distance.

**On the phone**, the scanner looks at a smaller copy of each frame (about a third of the pixels) to guide and to see the foot hold still, which keeps it quick on slower phones. At that size the toes blur together, so the live check asks for one toe bump instead of two; the full-size frames it sends are what the server decides on.

## Liveness

After a match, the scanner prompts: **lift your toes**, **put them down**, **lift them again**, moving to the next prompt once two frames in a row show the toes doing it. The server re-checks the same frames:

- Each frame is lined up with the matched frame using the heel, midfoot and ball: an affine warp (shift, turn, zoom, tilt) plus a brightness change, fitted by Gauss–Newton after a coarse search. Both are smoothed first so fine detail doesn't count as change.
- What the warp can't explain is measured on the toes, on the heel-to-ball points it was fitted on, and on a ring of floor around the front of the foot. Toes *up* means the toes changed well beyond how well the rest fits (`LIVE` in `core/engine.js`); *down* means they look as they did when matched; anything in the ring makes the frame *blocked*.
- The frames must show up, down, up, in that order, each under its own prompt.

A photo of a foot, however it's waved, tilted, zoomed or lit, moves as one flat picture that the warp explains, so its toes never come up; a finger or hand reaching over the toes crosses the ring. On drawn feet, real toe lifts passed every run, including half-height lifts, a shaky hand, drifting exposure and motion blur; a photo of the foot moved, zoomed, tilted, under glare or with a finger over the toes passed none (`npm run test:e2e` covers the photo case end to end). Before this check, a photo held in a hand that drifted a little closer passed every time.

What it doesn't stop: a video of the user doing the same thing, played back in step with the prompts, or a cut-out print bent at the toes over a real floor.

**Testing with real feet:** open the hosted page with `?debug` (for example `https://feet.example.com/hosted?debug#t=…`); it's carried over to the phone. The lens then draws the outline the scanner sees in yellow and the toe tip as a pink dot, and after each try a **Save this scan for debugging** link downloads what the scanner saw (the frames it couldn't make sense of, every upload and the server's answers) as a JSON file. Nothing is sent anywhere; the file stays on the device until you share it.

## Limits built in

- Sessions last 10 minutes; codes 60 seconds; result tokens 5 minutes; phone links 2 minutes, single use.
- 5 attempts per view, then the session fails and the user must start over.
- Frames are capped at 256 px a side, 16 per request, 8 MB per body.
- Frames are analysed in memory and discarded. Only measurements (388 numbers per frame, 2–3 frames per view) are stored, AES-256-GCM encrypted and bound to client + user.

## Before production

Setting up the server itself (Docker or a plain Linux server, https, backups) is in the [deployment guide](DEPLOY.md).

- **Run it behind HTTPS** (`PUBLIC_URL=https://…`); camera access requires it.
- **Keys:** pass `PIGGYBACK_DATA_KEY` from your KMS or secret store, and back up `DATA_DIR/keys.json` (signing key). Rotating the signing key means publishing both keys in the JWKS for a while; not automated yet.
- **More than one instance:** sessions, codes, phone links and OpenID Connect requests live in memory by default. Set `PIGGYBACK_REDIS_URL=redis://…` (or `rediss://` for TLS; Redis 6.2+) and every instance shares them, so a computer and its phone can land on different servers. The Redis client is built in. Registered apps and foot templates are files in `DATA_DIR`: put it on shared storage, or one volume per region. Templates are files; move them to a database for multiple instances.
- **Accuracy is unproven on real feet.** Thresholds and FootNet were tuned on drawn sample feet; retraining FootNet on consented real photos is the biggest single improvement available. Collect consented real-world data and measure false-accept and false-reject rates before relying on it.
- **Liveness stops photos, not videos.** A recording of the user lifting their toes, played back in time with the prompts, could pass. Next: prompts the server randomises per session (how many lifts, which toes).
- **Biometric law:** foot templates are biometric data. Get opt-in consent at enrollment, state retention, honour deletion (`DELETE /v1/users/:id`). In Canada that's PIPEDA, and Quebec's Law 25 requires notifying the CAI before deploying biometric verification; Illinois BIPA if you have US users.
- **Always keep another factor available** (passkey, authenticator app) for people who can't or won't use their feet.
