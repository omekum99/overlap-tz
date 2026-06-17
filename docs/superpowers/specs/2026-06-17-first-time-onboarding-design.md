# First-Time Onboarding Modal

## Problem

New users landing on Overlap for the first time see a timeline with demo people but
no explanation of what they're looking at or how to use it. The app's core concepts
(timeline, URL-based sharing, meeting planner) are not obvious from the UI alone.

## Design

A single modal with **3 panels side by side**, each explaining one core concept.
Shown only once per device via a `localStorage` flag (`tzclock.onboarded`).

### Modal Layout

| Aspect | Details |
|--------|---------|
| Container | Centered over a semi-transparent scrim |
| Background | `--bg-2: #fbfaf6` with 1px `--line` border |
| Shadow | App's standard `--shadow` |
| Corner radius | 0 (sharp, app-wide) |
| Width | 620px max |
| Close | ✕ in top-right corner |
| Dismiss | ✕ button or "Got it" button — both set localStorage + close |

### 3 Panels

| Panel | Icon | Headline | Body |
|-------|------|----------|------|
| 1 | ◷ (in accent) | **Whole team on one timeline** | Hover or drag to read each teammate's local time. Green bars = working hours. |
| 2 | 🔗 (in accent) | **Share with one link. No sign-up.** | Team encoded in the URL. Click "Share link" — no server, no database, no accounts. |
| 3 | ⏰ (in accent) | **Find meeting windows in seconds** | Planner shows overlaps. Pick a slot, add notes, export to calendar. |

Panels are separated by `--line` (1px) vertical borders. A `--line` divider sits above
the CTA button.

### Typography

- Headlines: `--font-display` (Bricolage Grotesque), 14px, 700 weight
- Body: `--font-body` (Manrope), 12px, `--muted` color
- CTA button: Manrope 600, `--accent` bg, `--accent-ink` text

### After Dismissal: ＋Person Pulse

Once the modal closes, the ＋Person button (`#openAdd`) gets:

1. A CSS `box-shadow` pulse animation for 3 seconds (using `--accent` color)
2. A small tooltip "👆 Add your real team" appears above the button, fading out after 3s

## Implementation

### localStorage Key

`tzclock.onboarded` → `'1'` after dismissal. Checked on DOMContentLoaded.

### Modal HTML

A new `<dialog>` element (or overlay `<div>`) in `index.html` with the 3-panel
layout. Using a `<div>` overlay (not native `<dialog>`) to match the app's existing
pattern (scrim + drawer).

### CSS

Styles added to `styles.css`:

```css
/* onboarding overlay */
.onboard-overlay { ... }
.onboard-modal { ... }
.onboard-panel { ... }
.onboard-btn { ... }
```

### JS Changes (app.js)

1. In `DOMContentLoaded` handler: check `localStorage.getItem('tzclock.onboarded')`
   — if absent, show the modal.
2. On dismiss: `localStorage.setItem('tzclock.onboarded', '1')`, hide modal,
   start ＋Person pulse.
3. Pulse: add class `pulse` to `#openAdd` for 3s, show tooltip, remove after 3s.

### Pulse CSS

```css
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(95,125,99,.5); }
  70% { box-shadow: 0 0 0 10px rgba(95,125,99,0); }
  100% { box-shadow: 0 0 0 0 rgba(95,125,99,0); }
}
.pulse { animation: pulse-ring 1.5s ease-out 3; }
```

## Not Included (Deferred)

- **Google Ads** — no ad units. Revisit when there's meaningful traffic.
- **Versioning** — no version system yet. Can add a `v` field to the URL hash later.
- **Analytics** — no tracking. First-visit check is purely client-side localStorage.
