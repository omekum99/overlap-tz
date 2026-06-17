# 🕒 Timezones — a shareable team clock

See your whole distributed team on **one 24-hour timeline**, find meeting windows,
group people into sub-teams, and share it all with a single link.

**No account. No server. No database.** The entire workspace is compressed into the
URL. Sharing the workspace = copying the URL.

## Why it's built this way

- **Plain HTML/CSS/JS** — no React, no build step, no `node_modules`. Open the file and it runs.
- **State lives in the URL.** Your team is encoded with [`lz-string`](https://github.com/pieroxy/lz-string)
  (`compressToEncodedURIComponent`) and stored in `location.hash`. The browser decompresses
  it on load. A whole team fits comfortably under the ~2000-char limit chat apps respect.
- **Timezone math with [Luxon](https://moment.github.io/luxon/).** Working hours are projected
  from each person's local zone onto a shared UTC axis, so the offsets (even `+5:30`) line up.

## Run it

Just open `index.html` in a browser — that's it. (It loads Luxon + lz-string from a CDN,
so you need a network connection on first load.)

Prefer a local server? Any static server works:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Features

- **24h timeline in *your* timezone** — defaults to your browser's zone (remembered), or
  pick any zone. A live "now" marker shows the current time.
- **Fits your screen** — the whole day is sized to the viewport by default (no page scroll);
  **−/+** zoom in for detail and the board scrolls, **Fit** snaps back. Scroll past the edge
  of the day to roll into the next/previous one.
- **Hover to read every zone** — move the cursor across the timeline and each teammate's
  local time updates live (green = inside their working hours); click to pin, arrow-keys nudge.
- **Scrollable date strip** — a week-at-a-glance row under the controls; scroll it and click
  any day. Today and the selected day are highlighted, and the date is shown large up top.
- **Day / night view** — a toggle paints each person's sky across the axis (deep night → dawn
  red → midday gold → dusk) with ☀ at their noon and ☾ at their midnight, so you can *see*
  whose evening you'd be taking — and schedule respectfully. The working band frames over it.
- **UTC offset + compact rows** — every lane shows the person's offset (e.g. `UTC+5:30`); the
  ≡ button switches to dense rows. Hover a lane and hit ⌖ to re-base the whole board on that
  person's timezone.
- **Team filters** — chips above the timeline show/hide sub-teams, or pick **Custom** to
  choose exactly who appears. (The planner has its own independent scope, below.)
- **＋ Block time** — one button (or a double-click on the timeline) opens a dialog where the
  date, start, and length are all editable inline — no scrolling to the right day first.
- **Date navigation** — ◀ / ▶ / date-picker / Today. Offsets are computed *per date*, so
  overlaps reflect daylight-saving differences (the same meeting overlaps differently in
  January vs July).
- **Draggable scrubber** — drag across the board to read every person's local time at that
  instant; green = they're inside working hours. (Arrow keys nudge it too.)
- **Add / edit / remove teammates** — timezone autocomplete, 30-minute granularity,
  overnight-shift support, and per-person **days off** (incl. Fri/Sat-weekend regions).
- **🎲 Dummy users** — one click adds a random teammate for "what if we hire in X?" planning.
- **Sub-teams** — create Marketing / Tech / etc., color-code them, filter the board.
- **Meeting planner** — finds the windows where everyone available overlaps (people off that
  day are excluded), then offers **clickable slots** for your chosen meeting length.
- **Meetings + minutes (MOM)** — pick a slot to create a meeting with notes; saved privately
  in your browser (`localStorage`), keyed to the workspace. Mark booked/proposed, edit, delete.
- **Calendar export** — download a standard **.ics** or open a prefilled **Google Calendar**
  link. This is how a private meeting gets shared — no backend, no OAuth.
- **12h / 24h toggle** and **member search**.
- **Share** — copies the URL and warns if it's getting long.

### What's in the URL vs your browser

- **URL hash** = the shared *team config* (org, teams, members, working hours). Small and
  shareable. This is the save file.
- **localStorage** = your *private* data (saved meetings + MOM notes) for this device, keyed
  by a stable workspace id (`wid`) that rides along in the URL. Not shared; export to a
  calendar to share a meeting.

## Design & interaction

- **One calm design system ("Zen")** — light, warm-paper background, a single sage accent,
  sharp (un-rounded) corners. No theme switching: one focused, production interface. Fonts:
  Bricolage Grotesque (display), Manrope (body), JetBrains Mono (times).
- **App-shell layout** — a fixed top bar, the timeline as the stage, and a side rail for the
  team + saved meetings. Each pane scrolls on its own so the page itself doesn't.
- **Scrollable, zoomable timeline** — the 24h board fits the screen by default, zooms with
  − / +, and scrolls horizontally (sticky name column) when zoomed in.
- **Search by city or country** — type "Boston", "India", "London" to find the right zone
  (no need to know IANA names like `America/New_York`).
- **Drag & drop** — drag a person chip onto a team to reassign them.
- **Calm canvas** — the timeline and planner are the focus; data-entry forms (add person,
  manage teams) live in a slide-in drawer so the main view stays uncluttered.

## Files

| File          | Job                                                                |
|---------------|--------------------------------------------------------------------|
| `index.html`  | Markup + loads the libraries and scripts                           |
| `styles.css`  | All styling — the single "Zen" design system + app-shell layout    |
| `state.js`    | URL ↔ config: key-minify, lz-string compress/decompress, validate  |
| `tzcities.js` | Friendly timezone search (city/country/alias → IANA)               |
| `timeutil.js` | Timezone math: date/home-tz projection, scrubber, overlap, slots   |
| `store.js`    | Private per-workspace meetings in localStorage                     |
| `calendar.js` | .ics file + Google Calendar link generation                        |
| `app.js`      | UI: timeline, hover/scrubber, team filters, combobox, drag & drop, drawer, planner, meetings |

## Deploy to GitHub Pages

This is a static site, so hosting is free:

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source: `main` / root**.
3. Open the published URL. Done.

## Not included (on purpose)

Google Calendar / OAuth and real accounts are intentionally out of scope — they require a
server to hold secrets and tokens, which would break the "just a static file" model. The
URL-based workspace is the share-and-go core; a backend can be layered on later if needed.
