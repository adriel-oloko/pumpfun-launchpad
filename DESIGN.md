---
version: alpha
name: HopeX-PONS-Pad-design
source: local codebase /mnt/d/web3-engineer/PonsLaunchpad (src/)
capture_date: 2026-09-04
description: A dark-only, near-monochrome trading console for the Pons v2 launchpad on Robinhood Chain. Deep navy-black canvas (#0B1217) carries a two-step panel ladder (#142028 surfaces, #23323C wells) separated by thin 1px slate rules (#25343F, #3A4956); a single electric lime (#52d593) is reserved for transactional commands, live readouts, and the wallet surface. Everything is a pill or a 12px-radius control, elevation is flat (one whisper shadow per panel), and the whole register is the system UI sans stack, weight-driven. Color-coded per-account funding states and a pulsing auto-trading marker are the only signals beyond ink, white, and lime.

colors:
  accent: "#52d593"
  accent-ink: "#1B170D"
  canvas: "#0B1217"
  surface: "#142028"
  well: "#23323C"
  well-step: "#25343F"
  rule: "#3A4956"
  text: "#FFFFFF"
  icon: "#CACEDB"
  icon-dim: "#818EA3"
  success: "#10B981"
  success-soft: "#29A533"
  danger: "#FF5E89"
  danger-soft: "#FF7777"
  alert: "#B6313A"
  destructive: "#F87171"
  black: "#000000"
  warning: "#F2C94C"
  mid: "#2B2DC7"
  dust: "#979797"
  info: "#155DFC"

typography:
  wordmark:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    letterSpacing: 0
  panel-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    letterSpacing: 0
  modal-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: 0
  table-cell:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 0
  input-text:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 0
  readout:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  button:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

components:
  header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.wordmark}"
    padding: 12px 16px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xs}"
    padding: 16px 24px
  panel-title-row:
    textColor: "{colors.text}"
    typography: "{typography.panel-title}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 6px 12px
    height: 32px
    width: 112px
  button-secondary:
    backgroundColor: "{colors.well}"
    border: "1px solid {colors.well}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 6px 12px
  button-danger:
    backgroundColor: "{colors.danger}"
    border: "1px solid {colors.danger}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 6px 12px
    minWidth: 112px
  button-icon-round:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.pill}"
    padding: 8px
  button-icon-ghost:
    backgroundColor: "transparent"
    border: "1px solid {colors.rule}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: 6px
  switch:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 6px 12px
  switch-on:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 6px 12px
  input:
    backgroundColor: "{colors.well}"
    border: "1px solid {colors.rule}"
    textColor: "{colors.text}"
    placeholderColor: "{colors.rule}"
    typography: "{typography.input-text}"
    rounded: "{rounded.lg}"
    padding: 8px 10px
  input-icon-chip:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.icon}"
    rounded: "{rounded.lg} left-flat variant"
  select:
    backgroundColor: "{colors.well}"
    border: "1px solid {colors.rule}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 8px 10px
  select-menu:
    backgroundColor: "{colors.well}"
    border: "1px solid {colors.rule}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  checkbox:
    backgroundColor: "{colors.well}"
    border: "1px inset {colors.text} at 15%"
    rounded: "{rounded.sm}"
    size: 20px
  checkbox-checked:
    backgroundColor: "{colors.text}"
    glyphColor: "{colors.black}"
  table:
    textColor: "{colors.text}"
    typography: "{typography.table-cell}"
  table-row:
    borderBottom: "1px solid {colors.well-step}"
  table-th:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "0 (checkbox header cell only: 16px 0)"
  row-icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: 6px
  dropzone:
    backgroundColor: "{colors.well}"
    border: "1px dashed {colors.rule}"
    textColor: "{colors.rule}"
    rounded: "{rounded.lg}"
    height: 112px
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 16px 32px
    maxWidth: 448px
  modal-close:
    backgroundColor: "{colors.well}"
    glyphColor: "{colors.icon-dim}"
    rounded: "{rounded.pill}"
  toast:
    backgroundColor: "{colors.success} (80% alpha) or {colors.danger-soft} (80% alpha)"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  countdown-ring:
    fillColor: "{colors.icon}"
    trackColor: "{colors.icon}"
  spinner:
    size: 24px
    duration: 0.75s per revolution
---

## Overview

**Creative North Star: "The Launch Console"**

A near-monochrome operations desk for launching and sniping Pons v2 tokens on Robinhood Chain. {colors.canvas}, a deep navy-black, is the entire page; panels sit on {colors.surface}, one step up, and interactive wells on {colors.well}, another step up. Depth comes from this three-step ladder plus thin 1px slate rules, never from blur or glow. {colors.accent}, an electric lime, is the only chroma in the default register and it is spent deliberately: pill-shaped transaction buttons, the ON state of toggles, round command icons, and the live symbol and pool-depth readouts in the Action panel header. Text on lime is always {colors.accent-ink}, a dark olive-black, never white.

The register is product. Headings are left-aligned and semicolon-sized; rows and controls are dense because the user is a launch operator, not a browser. Type is the system sans stack end to end, weight-driven (600 titles and labels, 400 data), with no display face and no mono. Signals beyond ink, white, and lime are confined to transaction feedback (green/red toasts), a per-account funding heat scale in the ledger, a destructive-actions red, and a slowly pulsing marker on accounts currently auto-trading.

**Key Characteristics:**
- Dark-only: {colors.canvas} page, {colors.surface} panels and header, {colors.well} fields and wells; no light theme exists
- One accent: {colors.accent} lime for commands, ON states, and live readouts, always paired with {colors.accent-ink} text
- Two hairline families: {colors.well-step} for table rules, {colors.rule} for field borders, chip fills, and ghost-icon borders
- Every button is a pill ({rounded.pill}); every input, dropdown, dropzone, and modal is {rounded.lg} (12px); panels are {rounded.xs} (4px)
- Flat elevation: panels and header carry one whisper shadow ({colors.black} at 10%), toasts a medium two-layer shadow; nothing else floats
- System sans only, no webfonts; 600 does the talking, sizes stay at 14/16/18/20px
- Joined control clusters: adjacent inputs and buttons square their shared edges so a group reads as one 12px-radius unit
- All icons are Heroicons outline at 16-20px, tinted {colors.icon} inside rule-colored chips and white elsewhere
- The ledger colors each account's ETH and token balances on a funding threshold scale, not on market direction
- The only looping animation is the 2s pulse of the auto-trading marker; the only choreography is modal entrance and countdown pie ticks
- HashRouter single screen: three panels (Launch, Action, Accounts) arranged asymmetrically, no nav, no marketing page

## Colors

### Brand & Accent
- **Accent** ({colors.accent}): the one chroma. Action buttons, Nuke/refresh/launch/collect round icons, SwitchButton ON, selected borders, the Action header symbol and pool-depth readouts, and the AppKit wallet accent (`--apkt-tokens-core-backgroundAccentPrimary`). Spinner fills take the accent while a loading button goes transparent.
- **Accent Ink** ({colors.accent-ink}): text on lime. Dark olive-black so lime surfaces hold contrast; also the AppKit `--apkt-tokens-theme-textInvert`.

### Surface
- **Canvas** ({colors.canvas}): page background, scrollbar thumbs, countdown ring track.
- **Surface** ({colors.surface}): header, the three panels, sticky table headers, and modal panels. All chrome.
- **Well** ({colors.well}): inputs, textareas, dropdown buttons and menus, checkboxes, secondary buttons, image dropzone, modal close pill, icon wells.
- **Well Step** ({colors.well-step}): table row rules, the sticky header rule, and the mobile drawer's right edge.
- **Rule** ({colors.rule}): field borders, the filled icon chip behind input icons, placeholder text, ghost-icon-button borders, summary separators in the Accounts header, the dim dropzone glyph.

### Text
- **Text** ({colors.text}): all copy, headings, and most icon strokes on dark. Pure white on these surfaces.
- **Icon** ({colors.icon}): soft slate for icons sitting on rule-colored chips and for the active countdown ring.
- **Icon Dim** ({colors.icon-dim}): modal close glyphs.
- Placeholder text uses {colors.rule} on the {colors.well} field.

### Semantic
- **Success** ({colors.success} at 80%): success toast fill. **Success Soft** ({colors.success-soft}): healthy funding-range text (ETH 0.1-0.5, token <=2% of supply).
- **Danger** ({colors.danger}): the danger ActionButton variant and its loading spinner. **Danger Soft** ({colors.danger-soft} at 80%): error toast fill.
- **Alert** ({colors.alert}): over-funded text in the ledger (ETH >1, token >2% of supply). **Destructive** ({colors.destructive}, Tailwind red-400): trash icons in rows and toolbar.
- **Mid** ({colors.mid}): ETH balances 0.5-1 in the ledger. **Dust** ({colors.dust}): ETH balances under 0.1.
- **Warning** ({colors.warning}): the Warning modal triangle and its 20%-opacity halo.
- **Info** ({colors.info}): the unused default fill of the countdown ring component; every real call site overrides it with {colors.icon}.

### Named Rules
**The Lime Law.** {colors.accent} exists for one reason: the operator's next command or the live state of the token. It appears on buttons that transact, toggles that are ON, round command icons, and the symbol/depth readouts. It never decorates a passive surface.

**The Funding Heat Scale.** In the ledger, color describes funding concentration, not price. ETH: under 0.1 is {colors.dust}, 0.1-0.5 is {colors.success-soft}, 0.5-1 is {colors.mid}, over 1 is {colors.alert}. Token share: up to 2% of supply is {colors.success-soft}, over 2% is {colors.alert}. Red means "this account holds too much for a clean launch", not "loss".

**The Two-Hairline Rule.** Rules come in exactly two tones: {colors.well-step} inside tables, {colors.rule} everywhere else (field borders, chip seams, dividers). Never a third border tone.

## Typography

### Font Family
The entire interface runs the Tailwind default sans stack: `ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji`. No webfont is loaded anywhere (no font link in index.html, no font import in index.css), and the AppKit wallet modal is forced onto the same stack via `--apkt-font-family: vars(--font-sans)`.

### Hierarchy
| Token | Size | Weight | Line Height | Use |
|-------|------|--------|-------------|-----|
| {typography.wordmark} | 18px | 600 | 1.56 | "HopeX" in the header |
| {typography.panel-title} | 18px | 600 | 1.56 | Panel titles: Launch, Action, Accounts |
| {typography.modal-title} | 20px | 500 | 1.4 | Modal titles (Warning is centered, others left) |
| {typography.body} | 16px | 400 | 1.5 | Default copy, modal alert text, button labels (inherited) |
| {typography.label} | 14px | 600 | 1.43 | Field labels ("PK *", "Name *"), Accounts summary stats |
| {typography.table-cell} | 14px | 400 | 1.43 | Table cells, row data |
| {typography.input-text} | 14px | 400 | 1.43 | Inputs, dropdowns, textareas |
| {typography.readout} | 16px | 400 | 1.5 | Inline accents in titles: symbol "(SYMB - Curve)", pool depth "X ETH" |
| {typography.button} | 16px | 600 | 1 | ActionButton, SwitchButton labels (buttons inherit 16px from preflight) |

### Principles
- Weight does the hierarchy: titles and labels are 600, data is 400. There is no uppercase anywhere, no tracking, no condensed face.
- Color adds a second channel: the {colors.accent} readouts sit inside a 600-weight title at 400 weight, so lime + 16px signals "live" while the 18px white word signals "section".
- Sizes never exceed 20px. This is a dense console, not a landing page.

### Note on Font Substitutes
If the system sans stack is absent, fallbacks are the browser's own UI font; nothing in the design depends on a specific glyph shape, so substitution is safe.

## Layout

### Spacing System
Tailwind's default scale in 4px steps, used sparingly: {spacing.xxs} gaps inside joined clusters, {spacing.xs} between stacked fields and toolbar buttons, {spacing.sm} inside headers, {spacing.md} as the standard vertical rhythm (`mt-2`/`mt-4`) and panel inner padding (`px-6 py-4`), {spacing.lg} for modal side padding. Field stacks use 8px between label and control and 8px between fields.

### Grid & Container
Single asymmetric desktop screen, no nav: a fixed 64px header (12px vertical padding, wordmark left, wallet button right), then a `main` that is `calc(100vh - 64px)` tall. Left column: the Launch panel, `min-w-[360px]`, widening to `min-w-[500px]` at `xl`. Right column (full remaining width): the Action panel on top, the Accounts panel below with `mt-4`, each panel owning its own scroll region (`h-[calc(100%-214px)]` on Accounts, `h-[calc(100%-44px)]` inside Launch). Panels share 16px gutter spacing.

### Whitespace Philosophy
Whitespace is functional: 24px horizontal panel padding, 16px vertical, 16px between sections. Dense by intent; the operator reads many numbers at once, so rows carry 16px vertical padding and no ornament.

## Elevation & Depth

Flat color-blocking with a three-step luminance ladder. The only shadows:

| Level | Definition | Use |
|-------|-----------|-----|
| Whisper | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` (Tailwind `shadow-sm`) | Header and every panel |
| Toast | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -1px rgb(0 0 0 / 0.06)` | Toasts only |
| Dim | {colors.black} at 30% full-screen | Modal backdrop, above everything |

There is no gradient, no glow, no blur, no glass. Layering is communicated by surface tone (canvas under surface under well) plus a single hairline between tone steps. Scrollbars are styled to {colors.canvas} thumbs on a 6px track so they disappear into the page.

## Shapes

### Border Radius Scale
| Token | Value | Tailwind Utility | Use |
|-------|-------|------------------|-----|
| {rounded.xs} | 4px | `rounded-sm` | Panel corners |
| {rounded.sm} | 6px | `rounded-md` | Checkboxes |
| {rounded.md} | 8px | `rounded-lg` | Toasts, dropdown menus, paste chip |
| {rounded.lg} | 12px | `rounded-xl` | Inputs, textareas, dropzone, modals, result/explorer rows |
| {rounded.pill} | 9999px | `rounded-full` | All buttons, switch, round icon buttons, close pills, logo avatars |

The scale is a three-stop story: fields and floating surfaces are 12px, the few small decorative chips 6-8px, panels barely rounded at 4px, and anything pressable is a pill.

### Shape Rules
**The Seam Rule.** When controls join into one cluster (amount + max-amount + Buy; interval + A-Buy), the shared edges square off: the trailing input drops its right corners (`rounded-se-none rounded-ee-none`), the middle piece goes fully square (`rounded-none`), and the button drops its left corners (`rounded-ss-none rounded-es-none`). Adjacent pieces overlap by 1px so the outer shape stays a single 12px-radius unit with the field border running through the seams.

**The Icon Chip Rule.** Inputs with icons wear a rule-colored {colors.rule} chip on the left that is 12px-rounded on its outer edge only (`rounded-ss-xl rounded-es-xl`), holding a 16px {colors.icon} glyph; the field itself keeps its right-side 12px corners. Dropdowns mirror this: chip on the left, `rounded-se-xl rounded-ee-xl` on the button.

## Components

### Header
{components.header}: centered row inside `mx-4`, wordmark "HopeX" in {typography.wordmark} on the left, AppKit `<w3m-button>` on the right. The wallet modal inherits {colors.accent} and {colors.accent-ink} via the AppKit theme variables in index.css.

### Panels
{components.panel}: {colors.surface} fill, 4px corners, whisper shadow, 24px/16px padding (the Launch drawer is tighter at 16px/16px). Each opens with a sticky title row: title in {typography.panel-title} on the left, its controls on the right, separated by 8px. Inside, content scrolls in its own region.

### Buttons
- **Primary** {components.button-primary}: {colors.accent} pill, {colors.accent-ink} 600 label, self-colored 1px border, 6px/12px padding, 112px (`w-28`) default width, narrowed when seated in clusters (Buy/Sell 72px, Nuke 64px, Deposit 80px). Loading swaps the plate to transparent and spins an {colors.accent} Spinner. Used for Buy, Sell, Nuke, Deposit, Save, Create, Withdraw, Ok.
- **Secondary** {components.button-secondary}: {colors.well} pill used as Cancel in modals.
- **Danger** {components.button-danger}: {colors.danger} pill; defined on ActionButton and used for destructive confirmations.
- **Round Icon** {components.button-icon-round}: {colors.accent} circle, {colors.accent-ink} 20px icon, 8px padding; refresh, launch, collect-fees.
- **Ghost Icon** {components.button-icon-ghost}: transparent circle, 1px {colors.rule} border, white 20px icon (24px in toolbar, 16px in rows); the Accounts toolbar's ten tools.
- **Row Icon** {components.row-icon-button}: borderless transparent circle with 16px white icons, {colors.destructive} on trash.
- **Switch** {components.switch} / {components.switch-on}: pill toggle. OFF is a {colors.rule} plate with white label; ON is {colors.accent} with {colors.accent-ink} label. Doubles as the loading host for auto modes (white Spinner).

### Inputs & Forms
- **Input / Textarea** {components.input}: {colors.well} fill, 1px {colors.rule} border, 12px radius, 8px/10px padding, 14px text, {colors.rule} placeholder, no visible focus treatment (`outline-none`). Left icon chip per the Icon Chip Rule. Disabled at 60% opacity.
- **Select** {components.select}: a HeadlessUI Menu styled as an input, right-aligned value; menu panel {components.select-menu} is a {colors.well} 8px-radius sheet with {colors.rule} borders, items divided by 1px {colors.rule} rules, last item borderless.
- **Checkbox** {components.checkbox}: 20px, 6px radius, {colors.well} fill with a 15%-white inset ring; checked flips to {colors.text} white fill with a {colors.black} check glyph. Row selection has a chaining quirk: clicking one row toggles the next N rows (select-count), so the checkboxes are load-bearing for bulk ops.
- **Dropzone** {components.dropzone}: 112px tall, {colors.well} fill, dashed {colors.rule} border, 12px radius, centered 36px {colors.rule} inbox icon; paste-from-clipboard chip floats top-right.
- **Countdown Ring**: a 16px SVG pie fill that drains clockwise inside the auto-buy/auto-sell icon chip once that mode arms, over a matching 1px ring, both {colors.icon}; updated every 100ms with a linear ease.

### Table (Accounts ledger)
{components.table} with a sticky {components.table-th} header on {colors.surface}: headers run at default {typography.body} size with explicit left alignment (Name, Address, Balance, Token, Actions); the checkbox header cell alone carries 16px vertical padding. Addresses render 4-char truncated. Rows are {components.table-row}: 14px cells separated by 1px {colors.well-step} rules; the checkbox cell drives row height with its 16px vertical padding and sibling cells align to it; hovering lifts the whole row to a 5% white wash. Balance and Token cells carry the Funding Heat Scale colors. The Actions cell holds the four row tools (Approve, Withdraw ETH, Copy PK, Remove); trash is {colors.destructive}, and a live auto-trading account shows a 16px exclamation glyph pulsing 1x to 1.2x on a 2s loop. Row tools dim to 15% opacity when their precondition fails (approving/withdrawing disabled until balances exist).

### Accounts Panel Header
Title on the left; on the right a summary strip: "Balance: N" and "Token: N" in {typography.label} separated by 1px {colors.rule} rules, then a divider-separated cluster of ten ghost-icon tools (approve all, disperse, withdraw all, fund, copy addresses, remove, create, multi-create, import, export), each a 32px {colors.rule}-bordered circle with tooltip below.

### Action Panel Clusters
The console heart. Row one: full-width contract-address search (a CASearchInput with a rule-chip magnifier), plus narrow Tip Gas and Select Count inputs. Row two: the joined **Buy cluster** (Buy Amount + Max Buy Amount + Buy), the joined **Sell cluster** (Sell Percent + Sell), Nuke, the random-buy "R" switch, and a round-lime refresh. Row three: joined **Auto-Buy** (interval + A-Buy) and **Auto-Sell** (interval + A-Sell) clusters whose icon chips swap from clock to countdown ring when armed, Min/Max Pool Size inputs, and the joined **Deposit cluster** (Min + Max + auto "A" switch + Deposit). In the title, the token symbol and its venue phase render in {colors.accent}: "(SYMB - Curve)" pre-graduation, "(SYMB - Pool)" after, with the live pool depth in ETH beside it.

### Modals
All dialogs share a chrome: full-screen {colors.black}-at-30% backdrop over a centered {components.modal} (max-width 448px, 12px radius, {colors.surface} fill, 16px top / 32px side padding) that enters by fading in from 95% scale over 300ms ease-out. Top-right close pill {components.modal-close}: {colors.well} circle with a 20px {colors.icon-dim} X. Titles in {typography.modal-title}; body forms reuse the standard fields and end in a centered action row: Cancel ({components.button-secondary}) beside the confirm ({components.button-primary}). The **Warning modal** is the exception: a centered {colors.warning} triangle with a 20% halo, centered title, body copy in {typography.body}, and a single centered Ok button.

### Toast
Top-left, 3-second lifetime, max two stacked. {components.toast}: 8px radius, white 14px semibold text, fill {colors.success} at 80% for success and {colors.danger-soft} at 80% for error, medium shadow, explorer link at 75% opacity, round white-X dismiss.

### Spinner
24px single-arc SVG, one revolution per 0.75s. Color is contextual: white when the host control is white-text (switch, row tools), {colors.accent} when the loading plate went transparent, variant color (well/danger) for secondary/danger buttons.

## Do's and Don'ts

### Do:
- **Do** keep the page {colors.canvas}, panels {colors.surface}, wells {colors.well}: the three-step ladder is the depth system.
- **Do** spend {colors.accent} only on commands, ON toggles, and live readouts, and always set its text to {colors.accent-ink}.
- **Do** make every button a pill and every field, menu, and modal 12px; panels stay at 4px.
- **Do** square the inner edges of joined clusters and overlap seams by 1px so a group reads as one control.
- **Do** divide tables with {colors.well-step} and everything else with {colors.rule}.
- **Do** keep type to the system sans stack at 14/16/18/20px and let weight (600 vs 400) carry hierarchy.
- **Do** color the ledger by funding concentration (the Funding Heat Scale), not by market direction.
- **Do** keep feedback to the two toasts: {colors.success} for success, {colors.danger-soft} for errors.
- **Do** show a spinner on a transparent plate while an action is in flight, tinted with the variant color.

### Don't:
- **Don't** introduce a light theme or a second bright accent; lime on navy-black is the identity.
- **Don't** add gradients, glow, glass, blur, or drop shadows beyond the whisper panel shadow and the toast shadow.
- **Don't** put text on lime in white; {colors.accent-ink} is the only legible pairing.
- **Don't** invent new border tones; the Two-Hairline Rule is {colors.well-step} in tables, {colors.rule} elsewhere.
- **Don't** add display fonts, mono labels, uppercase microcopy, or letter-spacing; the register is weight-only.
- **Don't** round the seams of joined clusters, or the join reads as separate buttons.
- **Don't** use {colors.success-soft}/{colors.alert} outside the ledger heat scale, and never green-for-up / red-for-down, because these colors already mean funding-health.
- **Don't** raise the 20px ceiling on type; this is a console, and dense rows are a feature.
- **Don't** center headings or stack three columns; the asymmetric Launch | Action/Accounts layout is deliberate.

## Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Default | < 1024px (`max-lg`) | Launch panel detaches into an off-canvas drawer |
| Large | >= 1024px (`lg`) | Three-panel desktop layout |
| X-Large | >= 1280px (`xl`) | Launch panel min width grows 360px to 500px |

### Collapsing Strategy
Below 1024px the Launch panel leaves the flow and becomes an absolute drawer pinned under the header (`top-16`, left edge, `max-lg:border-r` in {colors.well-step}, max width `calc(100vw - 64px)`). It is hidden by translating -100% and is pulled out by a round tab that hangs off the panel's right edge at mid-height: a {colors.surface} disc straddling the panel edge, holding a chevron that flips when open. The Action and Accounts panels keep the full width. Modal positioning is unchanged: always centered on whatever viewport.

### Touch Targets
Icon controls are small (round command buttons 36px, toolbar ghosts 32px, row tools 28-32px, close pill 30px). Acceptable for a keyboard-and-mouse operator console, but below the 44px guidance if the app is ever pointed at mobile thumbs; enlarge before shipping a touch-first build.

### Image Behavior
Token art uploads are cropped to fit the 112px dropzone preview with `h-full w-auto`; logos in the Action header are 24px round (Robinhood) or square (Dexscreener, Uniswap) and open the explorer, Dexscreener, or Uniswap pages.

## Iteration Guide

1. Change one component at a time. Because colors live as inline arbitrary utilities, restyle by editing the component's className, then update this document's token and the affected {components.*} entry in the same pass.
2. Keep variants as separate entries: primary, secondary, and danger buttons are distinct records even though they share one ActionButton.
3. Reference tokens (`{colors.accent}`, `{rounded.lg}`) in prose and component specs; never scatter raw hex through the narrative.
4. Do not document hover states in this file; the code's hovers (brightness-95 on lime plates, 5% white wash on rows, white borders and white icon fills on ghosts) are implementation detail.
5. Respect type-voice boundaries: labels and titles 600, data 400, never above 20px, never a new face.
6. Keep accent surfaces scarce. If a new component needs emphasis, first try inversion or weight before reaching for a second hue.
7. When a field's font size drifts, remember inputs, table cells, and labels are all 14px; anything else is a fork worth flagging.
8. When adding a control to a cluster, preserve the Seam Rule so the group still reads as one 12px unit.
9. Match this doc's shape: YAML tokens up front, then the fixed section order. Do not add sections.

## Known Gaps

- **No token layer in code.** There is no `@theme` block: colors, radii, and spacing are Tailwind arbitrary values repeated per use. This document is the token layer; the code has no single source of truth beyond the two AppKit CSS variables in index.css and the scrollbar/zoom CSS. A grep of the hex is the only way to trace a color.
- **Three tokens are Tailwind named utilities, not literals**: {colors.text} renders as `text-white`/`fill-white`/`stroke-white`, {colors.black} as `bg-black/30` and `fill-black`, and {colors.destructive} as `stroke-red-400`/`fill-red-400` (the Tailwind red-400 palette value that token stands for). A hex grep of src will not find these three.
- **Radius and shadow values are Tailwind v4 defaults** (4px `rounded-sm`, 6px `rounded-md`, 8px `rounded-lg`, 12px `rounded-xl`, 10%-black whisper `shadow-sm`), mapped from utility names rather than read from computed styles; verified against the installed tailwindcss 4.1.x scale.
- **Focus treatment is absent**: inputs and buttons declare `outline-none` with no replacement, so keyboard focus is not visibly indicated anywhere. Flagged as a real accessibility gap, not a system feature.
- **Hover states exist in code but are excluded from this doc** per the no-hover convention: `hover:brightness-95` on solid lime plates, `hover:bg-white/5` on rows and ghost buttons, `hover:border-white` and `hover:fill-white` on toolbar ghosts.
- **Button label size is implicit**: ActionButton and SwitchButton set no text-size class, so labels render at the 16px inherited from preflight; confirmed as intended by the consistent pill heights, but it is not written anywhere in the className.
- **Unused prop defaults**: the countdown ring defaults to {colors.info} fill and {colors.canvas} track, but every call site overrides both to {colors.icon}; the defaults never surface.
- **Third-party surfaces are out of scope**: the AppKit wallet modal is only themed via the accent/invert variables and font, and the w3m button's internals are not part of this system; the react-tooltip chrome is stock.
- **The funding heat scale thresholds** (>1 ETH red, 0.5-1 blue, 0.1-0.5 green, <0.1 gray; >2% supply red) are read straight from AccountItem.tsx and are functional constants, not verified against a product spec.
- **Spinner arc geometry and the 0.75s rotation** are SVG-internal (Spinner.tsx); the 2s zoom pulse is the only keyframe (index.css `zoom-in-out`).
- **Content language is English only**, no i18n; numbers format via `toLocaleString`.
