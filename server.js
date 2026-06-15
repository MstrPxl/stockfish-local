// Stockfish Bench — local web tool to benchmark Stockfish analysis.
//
// Serves a small web UI and bridges the browser to a *native* Stockfish
// process over a WebSocket, so analysis runs on this machine's CPU at full
// native speed. Each browser tab gets its own dedicated engine process.

import express from "express";
import { WebSocketServer } from "ws";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- Locate the Stockfish binary -------------------------------------------
// Priority: explicit env var > PATH > winget link > winget package folder.
function resolveStockfishPath() {
  if (process.env.STOCKFISH_PATH && existsSync(process.env.STOCKFISH_PATH)) {
    return process.env.STOCKFISH_PATH;
  }

  try {
    const cmd = process.platform === "win32" ? "where stockfish" : "which stockfish";
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (out.length) return out[0];
  } catch {
    /* not on PATH */
  }

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const link = join(local, "Microsoft", "WinGet", "Links", "stockfish.exe");
    if (existsSync(link)) return link;

    const pkgRoot = join(local, "Microsoft", "WinGet", "Packages");
    try {
      const found = execSync(`where /r "${pkgRoot}" stockfish*.exe`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (found.length) return found[0];
    } catch {
      /* not found */
    }
  }

  return null;
}

const STOCKFISH_PATH = resolveStockfishPath();
if (!STOCKFISH_PATH) {
  console.warn(
    "\n[warn] Could not locate a Stockfish binary.\n" +
      "       Set STOCKFISH_PATH=/full/path/to/stockfish before starting,\n" +
      "       or install it (Windows: winget install Stockfish.Stockfish).\n"
  );
} else {
  console.log(`[info] Using Stockfish: ${STOCKFISH_PATH}`);
}

// --- HTTP + static UI -------------------------------------------------------
const app = express();
app.use(express.static(join(__dirname, "public")));

// Live specs of whatever machine is running this server (the machine whose CPU
// actually runs Stockfish). Read fresh on every request so it always reflects
// the host the program is started on.
app.get("/api/engine", (_req, res) => {
  const cpus = os.cpus();
  res.json({
    found: Boolean(STOCKFISH_PATH),
    path: STOCKFISH_PATH || null,
    cpuModel: cpus[0]?.model?.trim() || "unknown CPU",
    logicalCores: cpus.length,
    speedGhz: cpus[0]?.speed ? +(cpus[0].speed / 1000).toFixed(2) : null,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(1),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
  });
});

const server = createServer(app);

// --- WebSocket UCI bridge ---------------------------------------------------
const wss = new WebSocketServer({ server });

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

wss.on("connection", (ws) => {
  let engine = null;
  let stdoutBuf = "";
  let uciSent = false;

  // Search lifecycle: only one search runs at a time. A new "analyze" request
  // becomes `pending`; if a search is already running we `stop` it and launch
  // the pending one once its bestmove arrives. Every engine line is tagged with
  // `currentToken` so the client can ignore output from a superseded search.
  let searching = false;
  let stopSent = false;
  let pending = null;
  let currentToken = null;

  let benchProc = null;

  const sendJSON = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  function send(cmd) {
    if (engine && engine.stdin.writable) engine.stdin.write(cmd + "\n");
  }

  function killEngine() {
    if (engine) {
      try { engine.stdin.write("quit\n"); } catch {}
      try { engine.kill(); } catch {}
      engine = null;
    }
    uciSent = false;
    searching = false;
    stopSent = false;
    pending = null;
  }

  function killBench() {
    if (benchProc) {
      try { benchProc.kill(); } catch {}
      benchProc = null;
    }
  }

  function handleEngineLine(line) {
    sendJSON({ type: "engine", line, token: currentToken });
    if (line.startsWith("bestmove")) {
      searching = false;
      stopSent = false;
      if (pending) launchPending();
    }
  }

  function startEngine() {
    if (engine) return true;
    if (!STOCKFISH_PATH) {
      sendJSON({ type: "error", message: "No Stockfish binary found on the server." });
      return false;
    }
    engine = spawn(STOCKFISH_PATH, [], { windowsHide: true });
    uciSent = false;

    engine.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length) handleEngineLine(line);
      }
    });
    engine.on("error", (err) => {
      sendJSON({ type: "error", message: `Engine error: ${err.message}` });
      engine = null;
      searching = false;
    });
    engine.on("exit", (code) => {
      sendJSON({ type: "engine-exit", code });
      engine = null;
      searching = false;
    });
    return true;
  }

  function launchPending() {
    const req = pending;
    pending = null;
    stopSent = false;
    if (!startEngine()) return;

    currentToken = req.token ?? null;
    const threads = clampInt(req.threads, 1, 1024, 1);
    const hash = clampInt(req.hash, 1, 1024 * 64, 128);
    const multipv = clampInt(req.multipv, 1, 10, 1);
    const fen = clean(req.fen) || "startpos";

    if (!uciSent) { send("uci"); uciSent = true; }
    send("ucinewgame");
    send(`setoption name Threads value ${threads}`);
    send(`setoption name Hash value ${hash}`);
    send(`setoption name MultiPV value ${multipv}`);
    send("isready");

    if (/^startpos$/i.test(fen)) send("position startpos");
    else send(`position fen ${fen}`);

    const limit = req.limit || "depth";
    if (limit === "movetime") send(`go movetime ${clampInt(req.movetime, 10, 3_600_000, 1000)}`);
    else if (limit === "infinite") send("go infinite");
    else if (limit === "nodes") send(`go nodes ${clampInt(req.nodes, 1000, 2_000_000_000, 1_000_000)}`);
    else send(`go depth ${clampInt(req.depth, 1, 99, 20)}`);

    searching = true;
    sendJSON({ type: "started", token: currentToken, at: Date.now() });
  }

  function runBench(req) {
    if (!STOCKFISH_PATH) {
      sendJSON({ type: "error", message: "No Stockfish binary found on the server." });
      return;
    }
    killBench();
    const threads = clampInt(req.threads, 1, 1024, 1);
    const hash = clampInt(req.hash, 1, 1024 * 64, 16);
    let buf = "";
    benchProc = spawn(STOCKFISH_PATH, [], { windowsHide: true });
    sendJSON({ type: "bench-started" });

    const onLine = (line) => {
      sendJSON({ type: "bench", line });
      // Stockfish prints the bench summary to stderr; the last metric is nps.
      if (/Nodes\/second/i.test(line)) {
        sendJSON({ type: "bench-done" });
        try { benchProc.stdin.write("quit\n"); } catch {}
        killBench();
      }
    };
    const pump = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.length) onLine(line);
      }
    };
    benchProc.stdout.on("data", pump);
    benchProc.stderr.on("data", pump);
    benchProc.on("error", (err) =>
      sendJSON({ type: "error", message: `Bench error: ${err.message}` })
    );

    // bench [ttSize] [threads] [depth] [fenFile] [limitType]
    benchProc.stdin.write(`bench ${hash} ${threads} 13 default depth\n`);
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "analyze":
        pending = msg;
        if (searching) {
          if (!stopSent) { send("stop"); stopSent = true; }
        } else {
          launchPending();
        }
        break;
      case "stop":
        pending = null;
        if (searching) send("stop");
        break;
      case "bench":
        runBench(msg);
        break;
      case "newengine":
        killEngine();
        break;
      default:
        break;
    }
  });

  ws.on("close", () => { killEngine(); killBench(); });
  ws.on("error", () => { killEngine(); killBench(); });
});

server.listen(PORT, () => {
  console.log(`\n  Stockfish Bench running at  http://localhost:${PORT}\n`);
});
