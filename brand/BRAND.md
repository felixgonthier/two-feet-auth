# Piggyback brand

Fun, confident, a bit cheeky. A cartoon pig sticking its tongue out, three clear colours, and a round, glassy interface that stays out of its way. Security products are usually grey and anxious; this one is relaxed because the hard part happens on the server.

## Name

**Piggyback**: one word, capital P. It rides on top of the login a company already has, the way a second factor should.

Tagline: **The new 2FA (Two-Feet Authentication)**. The pun lives in the tagline; in product UI the name stands alone ("Secured by Piggyback"). Write "Two-Feet Authentication" with a hyphen and capitals when spelling it out.

## Logo

A soft 3D cartoon pig, rendered like an animated-film character or a vinyl toy: big head, floppy ears with pink insides, rosy cheeks, a glossy snout, one bright eye and a cheeky wink, tongue out. The pig is the one rich, shaded object; everything around it is flat, which makes it pop.

| File | Use |
|---|---|
| `logo.png` (512) · `logo-256.png` · `logo-128.png` · `favicon-32.png` | The pig's head on a transparent background. Headers, hosted page, favicon, docs. Use the size closest to 2× the display size. |
| `mascot.png` | The whole pig, standing, with hooves and a curly tail, on a transparent background. For big moments: README, landing pages, success screens, stickers. |
| `mascot-point.png` | The whole pig pointing to its left (your left). Put it to the right of what it points at: dashboards, results, "look here" moments. |

- Lock-up: piggy at 1.4× the cap height, then "Piggyback" in weight 800, gap = ¼ of the piggy's width.
- Minimum size: 16 px. Clear space: ¼ of the piggy's width.
- Don't recolour, rotate, flatten the shading, or put its tongue away.
- The renders were generated with Figma AI (file "Piggyback brand") and cut out onto transparency. Generate new poses from that file so they stay in the same style.

The piggy nods to "this little piggy", the toe rhyme. Use the rhyme at most once per surface, never in errors.

## Colour

Three colours, each with one job:

| Colour | Hex | Job |
|---|---|---|
| **Blue** | #2F6BFF | Things you press: buttons, links, focus. Also "foot found" on the camera. |
| **Green** | #4CD992 (text #11774A) | Done: checkmarks, saved and matched steps, success. |
| **Pink** | #FF8FB1 (deep #E5578A) | The brand and "you are here": the piggy, the current step, focus rings. |

Supporting: ink #14161A, paper #FFFFFF, muted #555B66, quiet divider #DADDE3, error #D93A2B. Tints (`--pb-*-tint`) fill backgrounds behind a colour's job. All values, including dark mode, are in `ui/tokens.css`.

The camera lens is always a soft charcoal. Around it, the line is grey while searching, green while holding still and on a match, pink during the toe wiggle, coral on a problem.

## Shape

- **Round:** pills for buttons, fields, choices and labels; 24–32 px corners on cards and the camera view.
- **Glassy:** frosted surfaces (`--pb-glass`) with a bright rim on top, a faint outer line, and no inner shadows: fields and tracks stay flat, buttons and chosen options are lightly raised with a soft glow. Pages sit on a soft wash of the three brand colours (`.pb-backdrop`) so the glass has something to blur.
- **No hard edges:** no thick outlines and no solid offset shadows.
- **State lives in colour fills:** the line round the lens, the status chip and the judge's tile turn green when something's done. No coloured stripes down the side of cards.
- **Motion is smooth, never bouncy:** eased progress, a gliding scan beam, a gentle pop for the checkmark. All of it switches off with reduced motion.

## The UI kit

Every Piggyback screen (the demo, the hosted page, the sign-in pages, and the Piggy Bank example app) is built from three files in `ui/`. Use them instead of styling things per page.

| File | What's in it |
|---|---|
| `ui/tokens.css` | Colours, glass, shadows and fonts, light and dark. |
| `ui/controls.css` | Buttons, segmented choices, switches, text fields, links. |
| `ui/page.css` | The backdrop, the page column, the lockup, panels, chips, the success check, toasts, code blocks. |

The scanner element carries its own copy of the styles it needs inside its shadow DOM, so it works on any customer page with nothing else loaded.

### Controls

| Class | What it is |
|---|---|
| `.pb-btn` | Button: a 48 px pill of tinted glass with a bright rim on top and a soft glow of its own colour; brightens and lifts a touch on hover, presses in on click, a blue ring on keyboard focus. In the dark the fill goes deeper and more saturated than the link blue so white labels stay crisp. `.secondary` (frosted glass, ink text, no sheen), `.success` (green), `.danger` (coral), `.small` and `.block` (full width) variants. |
| `.pb-actions` | A row of buttons as equal columns, each as wide as the longest label (132 px at least). |
| `.pb-seg` | Segmented choice: a flat frosted track; the chosen option a glossy pink pill (pink to deep pink) with white text. `.fill` makes the options equal width across the row. |
| `.pb-switch` | On/off switch: a flat glass track and a glossy knob; the track turns green when on. `.row` puts the label left and the switch right. |
| `.pb-input`, `.pb-label` | Text field: a flat frosted pill that glows blue on focus. |
| `.pb-link` | Text link: blue, underlined on hover. |

### Page pieces

| Class | What it is |
|---|---|
| `.pb-backdrop` | The page background: a soft wash of pink, blue and green. |
| `.pb-page` | One centred column (440 px; `.wide` 760 px; `.middle` centres it vertically). |
| `.pb-lockup` | The piggy and the name together. |
| `.pb-panel` | A frosted card for related content or controls. `.tight` for control groups. |
| `.pb-eyebrow`, `.pb-title`, `.pb-text` | Step label, heading, body text. |
| `.pb-chip` | A small frosted note or state; `.dot` adds a status dot, `.good` and `.bad` tint it. |
| `.pb-toasts`, `.pb-toast` | Floating messages at the bottom of the screen: a glass bead icon (blue info, `.good` green, `.bad` red), the message, an inline action and a close button. Never inline banners that push the page around. |
| `.pb-code` | Code and token dumps. |
| `.pb-check` | Success: a glossy green disc with a white check, matching the judge's green tile on a match. |

Group related controls in one frosted panel with shared edges (the demo's control panel is the model): full-width choices, label left and switch right, nothing floating off-axis.

Focus is always visible: a blue ring around the control.

## The camera view

Like Face ID, not like a scanner: the camera shows only inside a lens shaped like a phone screen (the guide area's 0.62 proportions, smooth rounded corners), on the page's own background. The lens is a soft charcoal (#2B2F38), not black. Around it, 6 px out, runs one thin line in the same shape, like a bezel. The line does all the talking: it fills clockwise from the top and only ever moves forward; when progress has to start over, the old fill fades out rather than running backwards.

- **Searching:** the line stays quiet and grey; a soft, glowing outline of the foot, centred in the lens behind the judge (solid line, gently breathing, mirrored for left and right), shows which foot.
- **Holding still:** the line fills green, clockwise from the top, easing as the foot steadies.
- **Wiggle:** the line refills in pink as the toes move; soft pink ripples mark the toes.
- **Match:** the whole line is green, the judge's tile turns green and a white check pops out of its corner. Nothing covers the foot.
- **Miss:** the line turns red and the lens shakes, like a wrong passcode.
- The status sits under the lens as a small chip with a dot, so it reads as live feedback, not a heading: a blinking blue dot while the camera runs, green for good, coral for problems. No labels on top of the camera. On phones the Start button sits right under it; with room to spare (620 px or more) the lens sits left and the words, steps and button sit beside it, with "Secured by Piggyback" centred underneath both.
- **On a computer, the phone comes first.** The main button reads "Use my phone" and the lens shows a QR code on a white card, with rounded finder corners and the pig in the middle; "Use this computer" sits beside it as a frosted pill. Once the phone picks it up, the lens shows the foot outline breathing, the status reads "Scanning on your phone…", and the steps and line fill as views pass there. The phone page asks before claiming ("Sign in to Piggy Bank · Started on a Mac · Chrome") and ends with "Done. Your computer takes it from here". If the same user's next step follows, the phone shows "One more step" with a Continue button, and the computer says "Tap Continue on your phone", with "Show a code" underneath. In the no-server demo, a simulated phone in a dark bezel appears under the scanner.
- **The status chip is a label, not a sentence:** "Hold still…", "Left foot saved", "No match · 4 tries left", "Camera blocked". Any explanation goes in the line under the heading.
- No step pills: a small "Step 1 of 2" above the heading says where you are, and the line round the lens carries the progress.
- Choices sit side by side as pills of exactly the same size, as wide as the longer label: the main one in blue, the other in frosted glass ("Redo" · "Next", "Use my phone" · "Use this computer"). Only the review pair carries glyphs: a turning arrow on Redo, an arrow on Next and a tick on Finish, each nudging on hover. On narrow screens the pair stays side by side with a little less padding.
- **Enrolling is never rushed.** Each foot is saved after about two seconds held still, then the lens freezes on what was saved with "Redo" and "Next" (or "Finish"). Logins don't stop: one foot, a wiggle, done.
- After a few seconds without finding a foot, the status suggests a floor lighter or darker than the skin, and good light.

### The judge

A small pig sits in a frosted glass tile (rounded square) inside the bottom of the lens, watching the foot.

| Moment | What he does |
|---|---|
| Waiting | Bobs gently |
| A foot is in the frame | Leans in, watching |
| View passed | Nods yes |
| View passed and he's smitten | Flustered: blushes, puffs up, hearts float up |
| View failed | Shakes his head no |
| View failed and he's grossed out | Sick: turns green, wobbles, stink lines rise |

Smitten or grossed out depends on his taste: a meaningless number per scan, taken from image texture so it never tracks a foot's size or shape. Nobody's feet get judged for how they're built, and none of it affects the decision.

## Type

The system font stack: nothing to download, nothing for a customer's security policy to block. Headings weight 800 with slightly tight tracking (−0.01em); labels and buttons 700; text 400. Sizes 32 / 24 / 16 / 14 / 12 px. Sentence case everywhere.

## Voice

Short, direct, friendly. Say what to do with the foot ("Fit heel to toes inside the frame"). A little play in success moments ("Wiggle!"), none in errors: they say what went wrong and what to try.

## Theming for customers

The drop-in element takes customer colours through `--pb-accent`, `--pb-accent-ink`, `--pb-bg`, `--pb-ink`, `--pb-muted`, `--pb-good`, `--pb-bad` and `--pb-font`. The small "Secured by Piggyback" piggy mark stays.
