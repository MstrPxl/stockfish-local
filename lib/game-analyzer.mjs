// Headless full-game analysis with a precise completion contract.
//
// A game's analysis is COMPLETE when every position — the initial position plus
// the position after each ply (N+1 for an N-ply game) — has been searched to a
// fixed limit (depth / nodes / movetime) and the engine has returned `bestmove`
// for each. Reviewing the game then needs zero further engine computation.
//
// One persistent Stockfish process is reused across positions (and, in batch
// mode, across games), which is what makes 1000-game runs practical.

import { spawn } from "node:child_process";
import { Chess } from "chess.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MATE_CP = 100000; // sentinel centipawns for a forced mate
const LOSS_CAP = 1000; // cap per-move centipawn loss so one disaster can't skew ACPL

// ---- UCI info parsing ------------------------------------------------------
function parseInfo(line) {
  const t = line.split(/\s+/);
  const info = { pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth": info.depth = +t[++i]; break;
      case "seldepth": info.seldepth = +t[++i]; break;
      case "multipv": info.multipv = +t[++i]; break;
      case "nodes": info.nodes = +t[++i]; break;
      case "nps": info.nps = +t[++i]; break;
      case "time": info.time = +t[++i]; break;
      case "score": info.score = { type: t[++i], value: +t[++i] }; break;
      case "pv": info.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  return info;
}

// Convert an engine score (side-to-move perspective) to centipawns for the
// centipawn-loss identity. Mates collapse to a large sentinel.
function scoreToCp(score) {
  if (!score) return 0;
  if (score.type === "mate") return score.value > 0 ? MATE_CP : -MATE_CP;
  return score.value;
}

function classify(cpLoss, wasBest) {
  if (wasBest) return "best";
  if (cpLoss < 20) return "good";
  if (cpLoss < 50) return "inaccuracy";
  if (cpLoss < 150) return "mistake";
  return "blunder";
}

// ---- Persistent engine -----------------------------------------------------
export class StockfishEngine {
  constructor(enginePath) {
    this.proc = spawn(enginePath, [], { windowsHide: true });
    this.buf = "";
    this.tokenWaiters = []; // { token, resolve }
    this.lastInfo = null;
    this.bestmoveResolve = null;
    this.name = "Stockfish";
    this.proc.stdout.on("data", (c) => this._onData(c));
    this.proc.on("error", (e) => this._fail(e));
  }

  _fail(err) {
    const e = new Error(`Engine process error: ${err.message}`);
    if (this.bestmoveResolve) { const r = this.bestmoveResolve; this.bestmoveResolve = null; r(Promise.reject(e)); }
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this._handle(line);
    }
  }

  _handle(line) {
    if (line.startsWith("id name ")) this.name = line.slice(8).trim();

    if (this.bestmoveResolve) {
      if (line.startsWith("info ") && line.includes(" score ") && line.includes(" pv ")) {
        this.lastInfo = parseInfo(line);
      } else if (line.startsWith("bestmove")) {
        const bm = line.split(/\s+/)[1];
        const resolve = this.bestmoveResolve;
        this.bestmoveResolve = null;
        resolve({ bestmove: bm, info: this.lastInfo });
      }
    }

    for (let i = this.tokenWaiters.length - 1; i >= 0; i--) {
      if (line === this.tokenWaiters[i].token) {
        this.tokenWaiters[i].resolve();
        this.tokenWaiters.splice(i, 1);
      }
    }
  }

  _send(cmd) { this.proc.stdin.write(cmd + "\n"); }
  _awaitToken(token) { return new Promise((resolve) => this.tokenWaiters.push({ token, resolve })); }

  async init() { this._send("uci"); await this._awaitToken("uciok"); return this.name; }

  async setOptions({ threads = 1, hash = 128, multipv = 1 } = {}) {
    this._send(`setoption name Threads value ${threads}`);
    this._send(`setoption name Hash value ${hash}`);
    this._send(`setoption name MultiPV value ${multipv}`);
    this._send("isready");
    await this._awaitToken("readyok");
  }

  async newGame() { this._send("ucinewgame"); this._send("isready"); await this._awaitToken("readyok"); }

  // Search one position to the limit; resolves on `bestmove` (the per-position
  // completion signal) with the deepest info line seen.
  analyzePosition(fen, limit) {
    return new Promise((resolve, reject) => {
      this.lastInfo = null;
      this.bestmoveResolve = (v) => (v && typeof v.then === "function" ? v.then(resolve, reject) : resolve(v));
      this._send(`position fen ${fen}`);
      if (limit.movetime) this._send(`go movetime ${limit.movetime}`);
      else if (limit.nodes) this._send(`go nodes ${limit.nodes}`);
      else this._send(`go depth ${limit.depth}`);
    });
  }

  quit() {
    try { this._send("quit"); } catch {}
    try { this.proc.kill(); } catch {}
  }
}

// ---- Game analysis ---------------------------------------------------------
function buildLimit(config) {
  if (config.movetime) return { movetime: config.movetime, kind: "movetime", label: `${config.movetime} ms/move` };
  if (config.nodes) return { nodes: config.nodes, kind: "nodes", label: `${config.nodes.toLocaleString()} nodes/move` };
  return { depth: config.depth || 18, kind: "depth", label: `depth ${config.depth || 18}` };
}

// Parse a PGN into the ordered list of positions to analyze, plus the move that
// was actually played from each.
export function positionsFromPgn(pgn) {
  const parser = new Chess();
  parser.loadPgn(pgn); // throws on invalid PGN
  const headers = parser.header();
  const start = headers.FEN || START_FEN;
  const sans = parser.history();
  const replay = new Chess(start);
  const positions = [{ ply: 0, fen: replay.fen(), played: null }];
  for (let i = 0; i < sans.length; i++) {
    const mv = replay.move(sans[i]);
    positions.push({
      ply: i + 1,
      fen: replay.fen(),
      played: { san: mv.san, uci: mv.from + mv.to + (mv.promotion || "") },
    });
  }
  return { headers, positions };
}

// Analyze one full game on an already-initialized engine.
// `onProgress({ index, total, ply, score, depth })` is called per position.
export async function analyzeGame(engine, pgn, config = {}, onProgress) {
  const limit = buildLimit(config);
  const { headers, positions } = positionsFromPgn(pgn);

  await engine.newGame(); // clear TT between games so each game is independent

  const t0 = Date.now();
  let engineMs = 0;
  let totalNodes = 0;
  const analyzed = [];

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const { bestmove, info } = await engine.analyzePosition(p.fen, limit);
    const meta = info || {};
    engineMs += meta.time || 0;
    totalNodes += meta.nodes || 0;
    analyzed.push({
      ply: p.ply,
      fen: p.fen,
      sideToMove: p.fen.split(" ")[1] === "b" ? "b" : "w",
      depth: meta.depth ?? null,
      seldepth: meta.seldepth ?? null,
      score: meta.score || null, // side-to-move perspective
      bestMove: bestmove && bestmove !== "(none)" ? bestmove : null,
      pv: meta.pv || [],
      nodes: meta.nodes ?? null,
      timeMs: meta.time ?? null,
    });
    if (onProgress) onProgress({ index: i, total: positions.length, ply: p.ply, score: meta.score, depth: meta.depth });
  }

  const wallMs = Date.now() - t0;

  // Per-move centipawn loss via the negamax identity: with adjacent scores in
  // side-to-move perspective, best play gives score_i + score_{i+1} == 0, so the
  // loss for the move played from position i is max(0, score_i + score_{i+1}).
  const moves = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const before = analyzed[i];
    const played = positions[i + 1].played;
    let cpLoss = scoreToCp(before.score) + scoreToCp(analyzed[i + 1].score);
    if (!Number.isFinite(cpLoss)) cpLoss = 0;
    cpLoss = Math.max(0, Math.min(LOSS_CAP, cpLoss));
    const wasBest = before.bestMove != null && played.uci === before.bestMove;
    moves.push({
      ply: i + 1,
      side: before.sideToMove,
      san: played.san,
      uci: played.uci,
      bestMove: before.bestMove,
      wasBest,
      scoreBefore: before.score,
      cpLoss,
      classification: classify(cpLoss, wasBest),
    });
  }

  return {
    complete: true,
    completion: {
      positionsExpected: positions.length,
      positionsAnalyzed: analyzed.length,
      satisfied: analyzed.length === positions.length && analyzed.every((a) => a.bestMove !== undefined),
      definition:
        "every position (initial + after each ply) searched to the fixed limit and returned bestmove",
    },
    game: {
      white: headers.White || "?",
      black: headers.Black || "?",
      event: headers.Event || null,
      date: headers.Date || null,
      result: headers.Result || "*",
      plyCount: positions.length - 1,
    },
    config: { limit: limit.kind, label: limit.label, depth: limit.depth, nodes: limit.nodes, movetime: limit.movetime, threads: config.threads ?? 1, hash: config.hash ?? 128, multipv: config.multipv ?? 1 },
    engine: { name: engine.name },
    timing: { wallMs, engineMs, totalNodes, nps: engineMs ? Math.round(totalNodes / (engineMs / 1000)) : null },
    aggregates: aggregate(moves),
    moves,
    positions: analyzed,
  };
}

function aggregate(moves) {
  const blank = () => ({ moves: 0, acpl: 0, _sum: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 });
  const sides = { w: blank(), b: blank() };
  for (const m of moves) {
    const s = sides[m.side];
    s.moves++;
    s._sum += m.cpLoss;
    s[m.classification]++;
  }
  for (const s of Object.values(sides)) {
    s.acpl = s.moves ? Math.round(s._sum / s.moves) : 0;
    delete s._sum;
  }
  return sides;
}
