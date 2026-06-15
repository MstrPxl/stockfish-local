# Stockfish Bench

A small, self-contained web app for **analyzing chess positions with a native
Stockfish engine on your own machine** — and measuring how long that analysis
takes. Set up a position (drag pieces, paste a FEN, or import a full PGN), pick
the depth / time / threads / hash, and watch the engine work in real time.

The browser is only the UI. The actual search runs in a **native Stockfish
process** that the local Node server spawns and streams back over a WebSocket,
so you get real native performance — not a slower WebAssembly build. Everything
(engine aside) is vendored locally, so the app works **fully offline**.

---

## Features

- ♟️ **Interactive board** — click-to-move or smooth custom drag (the piece
  stays under the exact point you grabbed), with legal-move validation,
  highlights, castling/en-passant/promotion, undo, flip, and copy-FEN.
- ⚡ **Auto-analyze** — re-runs automatically on load and after every move,
  cleanly preempting the previous search so rapid moves never cross wires.
- 📊 **Top-N moves, color-coded** — the best candidate moves as boxes colored by
  who they favor (white box = White better, dark box = Black better); hover to
  preview the move as a translucent piece sliding to its destination (and back
  when you leave).
- 📈 **Eval bar + material panel** — a live evaluation bar and a captured-pieces
  display with the running material advantage in points.
- 🔢 **Standard Algebraic Notation** everywhere (`Nf3`, `exd5`, `O-O`, `Nbd2`,
  `#3`) with full disambiguation.
- 🎨 **Themes & piece sets** — 9 board color themes and 6 vendored SVG piece sets
  (plus a Unicode fallback), remembered across sessions.
- ⏱️ **Benchmarking** — a wall-clock timer plus the engine's own search time,
  nodes, and nps; a **run-history table** with **CSV export**; and a one-click
  **engine `bench`** (Stockfish's standard speed self-test).
- 🖥️ **Live host specs** — the header shows the CPU, threads, RAM, and OS of
  whatever machine is running the program, read fresh on each load.
- 📥 **Import** a position (FEN) or a whole game (PGN file or paste), with a move
  navigator to step through and analyze each position.

---

## Requirements

- **Node.js 18+**
- **Stockfish** installed locally (any recent version). The server auto-detects
  the binary from, in order:
  1. the `STOCKFISH_PATH` environment variable,
  2. your `PATH` (`stockfish` / `stockfish.exe`),
  3. the winget install folder on Windows.

  Install Stockfish via:
  - **Windows:** `winget install Stockfish.Stockfish`
  - **macOS:** `brew install stockfish`
  - **Linux:** `apt install stockfish` (or your distro's package)
  - or download from <https://stockfishchess.org/download/>

## Install & run

```bash
npm install      # first time only
npm start
```

Then open <http://localhost:3000>.

### Configuration

Both are optional environment variables:

| Variable         | Purpose                                  | Example                                   |
| ---------------- | ---------------------------------------- | ----------------------------------------- |
| `PORT`           | Port to serve on (default `3000`)        | `PORT=4000 npm start`                     |
| `STOCKFISH_PATH` | Explicit path to the Stockfish binary    | `STOCKFISH_PATH=/usr/bin/stockfish`       |

On Windows PowerShell, set them with `$env:NAME = "value"` before `npm start`.

---

## Usage

### The board

- **Move pieces** by clicking (select a piece → legal destinations appear as
  dots/rings → click one) or by **dragging** them. Dragging is custom (not native
  HTML5 drag), so the piece follows the cursor from the exact point you grabbed it
  — no recentering. Moves are validated by `chess.js`: only legal moves are
  allowed, and castling, en passant, and promotion (auto-queen) all work.
- **Coordinates** (files a–h, ranks 1–8) are inset on the squares, chess.com-style.
- The **eval bar** fills toward White or Black and shows the numeric score; it
  updates live while Stockfish searches (driven by the top line).
- The **material panel** beside the eval bar shows captured pieces, split top and
  bottom: the **top** holds the White pieces Black captured, the **bottom** the
  Black pieces White captured. At the split it shows the **material advantage in
  points** (pawn 1, knight/bishop 3, rook 5, queen 9) — a light chip when White
  leads, a dark chip when Black leads, `=` when even. Captures are derived from
  the current position versus a full starting army, so it works for any FEN.
- **↺ Start** resets, **↶ Undo** takes back a move, **⇅ Flip** views from Black's
  side, **⧉ Copy FEN** copies the current position.
- Every move rewrites the FEN box, so you can play out a line and then analyze the
  resulting position.

### Appearance (board theme + pieces)

Two dropdowns under the board (both remembered across sessions):

- **Board** — 9 color themes: Slate (default), Green, Brown, Blue, Gray, Wood,
  Purple, Ice, Tournament. Pure CSS; coordinate label colors adapt automatically.
- **Pieces** — 6 SVG sets (Cburnett (default), Merida, Alpha, Staunty, Maestro,
  Gioco) plus **Unicode (text)**. The SVGs are vendored under
  `public/pieces/<set>/`, so it all works offline.

### Auto-analyze

The **⚡ Auto-analyze** toggle (on by default) re-runs analysis whenever the
position changes — page load, move, undo, preset, FEN edit, or settings change.
Each request carries a token; a new request cleanly stops the running search and
relaunches, and output from a superseded search is ignored. Turn it off to
analyze only when you press **▶ Analyze now**.

### Collapsing the settings panel

The **⚙ cog** (top-right) shows/hides the middle analysis-settings panel. With it
hidden, the board expands to fill the freed space (capped to the viewport height
so it never overflows). The choice is remembered. The live **Top moves** count
stays available while hidden; reopen the cog for depth, threads, hash, Stop, or
bench.

### Importing a position or a whole game

Open **⇩ Import a position (FEN) or a full game (PGN)** under the board, then
either paste a FEN/PGN and press **Load**, or **choose a `.pgn` / `.fen` file**.
A bare FEN sets the position; a PGN loads the whole game with a **move
navigator**: step with ⏮ ◀ ▶ ⏭, the arrow keys (`←` `→` `Home` `End`), or click
any move. With auto-analyze on, each position you land on is analyzed — handy for
reviewing a game. Making a manual move from any point branches off and continues
from there.

### Analysis settings

1. **Stop condition:** Fixed depth (most common benchmark), Fixed time (ms),
   Fixed nodes, or Infinite (until you press Stop or move again).
2. **Threads** — defaults to (logical cores − 1). More threads = faster.
3. **Hash (MB)** — transposition table size; bigger helps deep searches.
4. **Top moves to show** (next to the Top moves heading) — how many candidate
   lines to report (MultiPV, 1–10). 1 is fastest.

### Top moves (color-coded)

Instead of a single best move, the results show the engine's **top N candidate
moves**, each a box with the move (SAN), its evaluation, and the continuation
line. Each box is colored by **who the move favors** (sign of the eval in White's
perspective): a winning side keeps its color across all candidates, and only a
move that pushes the eval **across zero** flips color — so a blunder stands out.

**Hover** a box to preview the move: a 50%-transparent copy of the piece slides
from its square to the destination; **moving off** glides it back home. Each move
has its own ghost/animation, so skimming several moves animates independently
without conflict. **Click** a box to play that move on the board.

### Run history & engine bench

- Every completed analysis is logged to the **Run history** table: position,
  limit, threads, hash, wall-clock, engine time, depth, nodes, nps, best move,
  eval. **Export CSV** to compare configurations, or **Clear** to reset.
- **⚡ Run engine bench** runs Stockfish's built-in `bench` (standard speed
  self-test, using your chosen thread count) and reports total nodes, nps, and
  time — the canonical way to compare raw engine speed across machines/builds.

### Two time numbers, on purpose

- **Timer (wall-clock)** includes one-time overhead: spawning the engine, the UCI
  handshake, and allocating the hash table.
- **Engine time** is the pure search time Stockfish reports.

For a clean search-only benchmark, compare runs by **Engine time**; the wall-clock
shows the real end-to-end experience.

---

## How it works

```
Browser (public/)                     Node server (server.js)            Engine
─────────────────                     ───────────────────────            ──────
index.html / style.css                Express static file server
app.js  ──── WebSocket (UCI) ───────► ws bridge ── stdin/stdout ───────► stockfish
   ▲                                     │  (one process per tab)
   └───────────── JSON messages ─────────┘
```

- `app.js` renders the board, parses UCI output, converts moves to SAN (via the
  vendored `chess.js`), and drives the eval bar, material panel, and timers.
- `server.js` serves the static UI, exposes `GET /api/engine` (live host specs +
  detected binary path), and bridges each WebSocket connection to its own
  Stockfish process. A small state machine handles `analyze` (with a search
  token), `stop`, and `bench`, restarting cleanly when the position changes.
- Inputs are clamped server-side (threads, hash, depth, …) and FEN strings are
  sanitized to a single line before reaching the engine.

## Project layout

```
server.js                Express static server + WebSocket→Stockfish UCI bridge + /api/engine
package.json             Scripts and dependencies (express, ws, chess.js)
public/
  index.html             UI markup
  style.css              Styling (dark theme)
  app.js                 Board, drag, eval bar, material, SAN, timing, history, WS client
  vendor/chess.js        Vendored chess.js (legal moves / SAN / PGN), offline
  pieces/<set>/*.svg     Vendored SVG piece sets (cburnett, merida, alpha, …)
```

## Notes & limitations

- **Local tool.** It serves over plain `ws://localhost` and spawns processes; run
  it on your own machine. Don't expose it to untrusted networks as-is.
- Each browser tab gets its own dedicated Stockfish process; closing the tab kills
  it.
- Pawn promotion auto-queens (no piece picker).
- Captured-piece display is derived from the current position vs a full starting
  army, so unusual setups or promotions are approximated; the point advantage is
  computed from on-board material and stays accurate.

## Credits & licenses

- **Engine:** [Stockfish](https://stockfishchess.org/) — GPLv3. Not bundled; you
  install it separately.
- **Move legality / SAN / PGN:** [chess.js](https://github.com/jhlywa/chess.js) —
  BSD-2-Clause, vendored in `public/vendor/`.
- **Piece SVG sets:** from the
  [Lichess](https://github.com/lichess-org/lila/tree/master/public/piece) (`lila`)
  project, vendored in `public/pieces/`. These are open-source under various free
  licenses (e.g. Cburnett is CC-BY-SA 3.0 by Colin M.L. Burnett); see lila's
  `COPYING.md` for per-set terms. All credit for the artwork goes to their authors.

Bundled third-party assets remain under their respective licenses (above). The
application code in this repository is provided as-is for local/personal use.
