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

- **24h UTC timeline** with a live "now" marker.
- **Draggable scrubber** — drag across the board to read every person's local time at that
  instant; green = they're inside working hours. (Arrow keys nudge it too.)
- **Add / edit / remove teammates** with timezone autocomplete and overnight-shift support.
- **🎲 Dummy users** — one click adds a random teammate for "what if we hire in X?" planning.
- **Sub-teams** — create Marketing / Tech / etc., color-code them, filter the board.
- **Meeting planner** — finds the UTC windows where everyone (or a selected team) overlaps,
  shown in each person's local time.
- **Share** — copies the URL and warns if it's getting long.

## Files

| File          | Job                                                          |
|---------------|--------------------------------------------------------------|
| `index.html`  | Markup + loads the libraries and scripts                     |
| `styles.css`  | All styling (plain CSS)                                       |
| `state.js`    | URL ↔ state: key-minify, lz-string compress/decompress, validate |
| `timeutil.js` | Timezone math: band projection, scrubber, overlap finder     |
| `app.js`      | UI: rendering, scrubber, forms, teams, planner, share        |

## Deploy to GitHub Pages

This is a static site, so hosting is free:

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source: `main` / root**.
3. Open the published URL. Done.

## Not included (on purpose)

Google Calendar / OAuth and real accounts are intentionally out of scope — they require a
server to hold secrets and tokens, which would break the "just a static file" model. The
URL-based workspace is the share-and-go core; a backend can be layered on later if needed.
