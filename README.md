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

## Files

| File          | Job                                                                |
|---------------|--------------------------------------------------------------------|
| `index.html`  | Markup + loads the libraries and scripts                           |
| `styles.css`  | All styling (plain CSS)                                            |
| `state.js`    | URL ↔ config: key-minify, lz-string compress/decompress, validate  |
| `timeutil.js` | Timezone math: date/home-tz projection, scrubber, overlap, slots   |
| `store.js`    | Private per-workspace meetings in localStorage                     |
| `calendar.js` | .ics file + Google Calendar link generation                        |
| `app.js`      | UI: rendering, scrubber, forms, teams, planner, meetings, share    |

## Deploy to GitHub Pages

This is a static site, so hosting is free:

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source: `main` / root**.
3. Open the published URL. Done.

## Not included (on purpose)

Google Calendar / OAuth and real accounts are intentionally out of scope — they require a
server to hold secrets and tokens, which would break the "just a static file" model. The
URL-based workspace is the share-and-go core; a backend can be layered on later if needed.
