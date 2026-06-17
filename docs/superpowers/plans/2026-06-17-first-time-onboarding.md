# First-Time Onboarding Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a 3-panel onboarding modal on first visit, dismissible via localStorage, with a ＋Person button pulse after dismissal.

**Architecture:** Pure HTML/CSS/JS addition to existing single-page app. No new dependencies. Modal markup in `index.html`, styles in `styles.css`, logic in `app.js`.

**Tech Stack:** Plain HTML/CSS/JS (no frameworks). Existing Luxon + lz-string CDN deps.

---

### Task 1: Add modal markup to index.html

**Files:**
- Modify: `index.html:208` (before the scrim/dialog section)

- [ ] **Add the onboarding overlay + modal HTML**

Insert after the `</main>` closing tag, before the scrim:

```html
  <!-- ───────────────────────── First-visit onboarding overlay ───────────────────────── -->
  <div id="onboardOverlay" class="onboard-overlay" hidden>
    <div class="onboard-modal">
      <button id="onboardClose" class="onboard-close" aria-label="Close">✕</button>
      <div class="onboard-panels">
        <div class="onboard-panel">
          <span class="onboard-icon">◷</span>
          <h3 class="onboard-heading">Whole team on<br>one timeline</h3>
          <p class="onboard-text">Hover or drag to read each teammate's local time. Green bars = working hours.</p>
        </div>
        <div class="onboard-panel">
          <span class="onboard-icon">🔗</span>
          <h3 class="onboard-heading">Share with one link.<br>No sign-up.</h3>
          <p class="onboard-text">Team encoded in the URL. Click "Share link" — no server, no database, no accounts.</p>
        </div>
        <div class="onboard-panel">
          <span class="onboard-icon">⏰</span>
          <h3 class="onboard-heading">Find meeting windows<br>in seconds</h3>
          <p class="onboard-text">Planner shows overlaps. Pick a slot, add notes, export to calendar.</p>
        </div>
      </div>
      <div class="onboard-divider"></div>
      <button id="onboardGotIt" class="btn primary onboard-cta">Got it — start using Overlap</button>
    </div>
  </div>
```

- [ ] **Commit**

```bash
git add index.html
git commit -m "feat: add onboarding modal markup to index.html"
```

---

### Task 2: Add onboarding styles to styles.css

**Files:**
- Modify: `styles.css` (append to end)

- [ ] **Add onboarding overlay and modal styles**

```css
/* ── first-visit onboarding ─────────────────────────────────── */
.onboard-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,.25);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
}
.onboard-modal {
  background: var(--bg-2); border: 1px solid var(--line);
  box-shadow: var(--shadow);
  padding: 32px 28px; max-width: 620px; width: 100%;
  position: relative;
}
.onboard-close {
  position: absolute; top: 10px; right: 14px;
  background: none; border: none; font-size: 16px;
  cursor: pointer; color: var(--muted); line-height: 1;
  font-family: var(--font-body);
}
.onboard-close:hover { color: var(--text); }
.onboard-panels { display: flex; gap: 0; }
.onboard-panel {
  flex: 1; text-align: center; padding: 16px 14px;
}
.onboard-panel + .onboard-panel {
  border-left: 1px solid var(--line);
}
.onboard-icon {
  display: block; font-size: 30px; margin-bottom: 6px;
  color: var(--accent);
}
.onboard-heading {
  font-family: var(--font-display); font-weight: 700;
  font-size: 14px; margin-bottom: 6px; letter-spacing: -.01em;
  color: var(--text);
}
.onboard-text {
  font-size: 12px; color: var(--muted); line-height: 1.5;
  font-family: var(--font-body);
}
.onboard-divider {
  height: 1px; background: var(--line); margin: 12px 0 16px;
}
.onboard-cta {
  display: block; margin: 0 auto;
  padding: 8px 32px; font-size: 14px;
}

/* ── ＋Person pulse after onboarding ────────────────────────── */
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(95,125,99,.5); }
  70% { box-shadow: 0 0 0 10px rgba(95,125,99,0); }
  100% { box-shadow: 0 0 0 0 rgba(95,125,99,0); }
}
.pulse {
  animation: pulse-ring 1.5s ease-out 3;
  position: relative;
}
.pulse-tooltip {
  position: absolute;
  bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  background: var(--accent); color: var(--accent-ink);
  font-family: var(--font-body); font-size: 12px; font-weight: 600;
  padding: 4px 10px; white-space: nowrap;
  pointer-events: none;
  opacity: 1;
  transition: opacity .3s;
}
```

- [ ] **Commit**

```bash
git add styles.css
git commit -m "feat: add onboarding and pulse styles"
```

---

### Task 3: Add onboarding logic to app.js

**Files:**
- Modify: `app.js`

- [ ] **Add the onboarding show/dismiss logic and pulse**

Find the `DOMContentLoaded` handler around line 54 and add after the meetings load and before `initDaysOff`:

```javascript
  // First-visit onboarding
  if (!localStorage.getItem('tzclock.onboarded')) {
    showOnboarding();
  }
```

Add these functions at the end of file (before the last line):

```javascript
// ── first-visit onboarding ────────────────────────────────────
function showOnboarding() {
  const overlay = $('onboardOverlay');
  if (!overlay) return;
  overlay.hidden = false;

  const dismiss = () => {
    overlay.hidden = true;
    localStorage.setItem('tzclock.onboarded', '1');
    pulseAddPerson();
  };

  $('onboardClose').addEventListener('click', dismiss);
  $('onboardGotIt').addEventListener('click', dismiss);
  overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
}

function pulseAddPerson() {
  const btn = $('openAdd');
  if (!btn) return;
  btn.classList.add('pulse');
  const tip = document.createElement('div');
  tip.className = 'pulse-tooltip';
  tip.textContent = '👆 Add your real team';
  btn.appendChild(tip);
  setTimeout(() => {
    btn.classList.remove('pulse');
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }, 4500);
}
```

- [ ] **Verify it works**

Open `index.html` in a browser. Clear `localStorage` for the domain. Reload — the modal should appear. Click "Got it" — modal dismisses, ＋Person button pulses. Reload again — modal should NOT appear (flag set).

- [ ] **Commit**

```bash
git add app.js
git commit -m "feat: add onboarding show/dismiss logic and button pulse"
```
