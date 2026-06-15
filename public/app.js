// Stockfish Bench — client. Talks to the local server over WebSocket, which
// bridges to a native Stockfish process. Interactive board (legal moves via
// chess.js), eval bar, live auto-analysis that re-runs on every move, a run
// history with CSV export, and the engine's standard `bench` self-test.

import { Chess } from "./vendor/chess.js";

const $ = (id) => document.getElementById(id);
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const els = {
  board: $("board"),
  evalFill: $("evalFill"),
  evalBarText: $("evalBarText"),
  matTop: $("matTop"),
  matBottom: $("matBottom"),
  matDiff: $("matDiff"),
  resetBtn: $("resetBtn"),
  undoBtn: $("undoBtn"),
  flipBtn: $("flipBtn"),
  copyFenBtn: $("copyFenBtn"),
  boardTheme: $("boardTheme"),
  pieceSet: $("pieceSet"),
  fen: $("fen"),
  preset: $("preset"),
  sideToMove: $("sideToMove"),
  autoAnalyze: $("autoAnalyze"),
  limit: $("limit"),
  depth: $("depth"),
  movetime: $("movetime"),
  nodes: $("nodes"),
  threads: $("threads"),
  threadsHint: $("threadsHint"),
  hash: $("hash"),
  multipv: $("multipv"),
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  benchBtn: $("benchBtn"),
  benchResult: $("benchResult"),
  timer: $("timer"),
  timerLabel: $("timerLabel"),
  topMoves: $("topMoves"),
  evalVal: $("evalVal"),
  depthVal: $("depthVal"),
  nodesVal: $("nodesVal"),
  npsVal: $("npsVal"),
  engTimeVal: $("engTimeVal"),
  log: $("log"),
  engineDot: $("engineDot"),
  engineText: $("engineText"),
  settingsToggle: $("settingsToggle"),
  layout: document.querySelector(".layout"),
  historyBody: $("historyBody"),
  exportCsvBtn: $("exportCsvBtn"),
  clearHistoryBtn: $("clearHistoryBtn"),
  pgnNav: $("pgnNav"),
  pgnGame: $("pgnGame"),
  firstBtn: $("firstBtn"),
  prevBtn: $("prevBtn"),
  plyLabel: $("plyLabel"),
  nextBtn: $("nextBtn"),
  lastBtn: $("lastBtn"),
  closePgnBtn: $("closePgnBtn"),
  moveList: $("moveList"),
  importInput: $("importInput"),
  importFile: $("importFile"),
  importBtn: $("importBtn"),
  importMsg: $("importMsg"),
};

const PIECES = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

// Appearance (persisted). "unicode" renders text glyphs; any other value is an
// SVG set vendored under public/pieces/<set>/<wK|bQ|…>.svg.
let pieceSet = "cburnett";
let boardTheme = "slate";

// Build a piece element for a FEN char ("K", "q", …). `movable` only styles the
// cursor — dragging is handled by custom pointer events, not native HTML5 DnD
// (native DnD recenters the drag image under the cursor, which we don't want).
function makePiece(pieceChar, isWhite, movable) {
  let el;
  if (pieceSet === "unicode") {
    el = document.createElement("span");
    el.className = "piece " + (isWhite ? "piece-w" : "piece-b");
    el.textContent = PIECES[pieceChar];
  } else {
    el = document.createElement("img");
    el.className = "piece piece-img";
    const code = (isWhite ? "w" : "b") + pieceChar.toUpperCase();
    el.src = `pieces/${pieceSet}/${code}.svg`;
    el.alt = code;
  }
  el.draggable = false;
  if (movable) el.classList.add("movable");
  return el;
}

// Material: piece values and the standard starting army (king excluded).
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START_ARMY = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const MAT_ORDER = ["q", "r", "b", "n", "p"]; // shown high value first

function makeMatIcon(type, isWhite) {
  const w = document.createElement("span");
  w.className = "mat-piece";
  w.appendChild(makePiece(isWhite ? type.toUpperCase() : type, isWhite, false));
  return w;
}

// Recompute captured pieces + material advantage from the current position and
// render them beside the eval bar. Top = pieces Black captured (White pieces),
// bottom = pieces White captured (Black pieces); the split shows the point edge.
function renderMaterial() {
  const cells = parseFenBoard(els.fen.value);
  const wc = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const bc = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of cells) {
    for (const ch of row) {
      if (!ch) continue;
      const t = ch.toLowerCase();
      if (!(t in PIECE_VALUE)) continue; // skip kings
      if (ch === ch.toUpperCase()) wc[t]++;
      else bc[t]++;
    }
  }

  els.matTop.innerHTML = "";
  els.matBottom.innerHTML = "";
  let mw = 0, mb = 0;
  for (const t of MAT_ORDER) {
    mw += PIECE_VALUE[t] * wc[t];
    mb += PIECE_VALUE[t] * bc[t];
    const whiteTaken = Math.max(0, START_ARMY[t] - wc[t]); // white pieces Black took
    const blackTaken = Math.max(0, START_ARMY[t] - bc[t]); // black pieces White took
    for (let i = 0; i < whiteTaken; i++) els.matTop.appendChild(makeMatIcon(t, true));
    for (let i = 0; i < blackTaken; i++) els.matBottom.appendChild(makeMatIcon(t, false));
  }

  const diff = mw - mb;
  if (diff === 0) {
    els.matDiff.className = "mat-diff";
    els.matDiff.innerHTML = '<span class="chip">=</span>';
  } else {
    els.matDiff.className = "mat-diff " + (diff > 0 ? "white-lead" : "black-lead");
    els.matDiff.innerHTML = `<span class="chip">+${Math.abs(diff)}</span>`;
  }
}

// ---- Position / game state -------------------------------------------------
let game = null;
let selected = null;
let legalTargets = new Map();
let lastMove = null;
let flipped = false;

// PGN navigation state (a loaded game): a list of plies with FEN + the move
// that produced each one. pgnPly is the index currently shown.
let pgnLine = null;
let pgnPly = 0;
let pgnLabel = "";

function parseFenBoard(fen) {
  const board = (fen || "").trim().split(/\s+/)[0] || "8/8/8/8/8/8/8/8";
  const ranks = board.split("/");
  const cells = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (const ch of ranks[r] || "8") {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) row.push(null);
      else row.push(ch);
    }
    while (row.length < 8) row.push(null);
    cells.push(row.slice(0, 8));
  }
  while (cells.length < 8) cells.push(new Array(8).fill(null));
  return cells;
}

function sideToMoveFromFen(fen) {
  return (fen || "").trim().split(/\s+/)[1] === "b" ? "b" : "w";
}

function loadPosition(fen) {
  selected = null;
  legalTargets.clear();
  lastMove = null;
  try {
    game = new Chess(fen.trim());
  } catch {
    game = null;
  }
  afterPositionChange();
}

function afterPositionChange() {
  renderBoard();
  const side = sideToMoveFromFen(els.fen.value);
  els.sideToMove.textContent = game ? (side === "b" ? "Black" : "White") : "—";
  els.sideToMove.title = game ? "" : "Illegal FEN — moves disabled";
  resetEvalBar();
  updateUndoBtn();
}

function updateUndoBtn() {
  els.undoBtn.disabled = !(game && game.history().length > 0);
}

// ---- Board rendering -------------------------------------------------------
function renderBoard() {
  clearGhosts(); // ghosts live inside the board; a rebuild invalidates them
  const cells = parseFenBoard(els.fen.value);
  const side = sideToMoveFromFen(els.fen.value);
  els.board.innerHTML = "";
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = flipped ? 7 - vr : vr; // board row, 0 = rank 8
      const f = flipped ? 7 - vc : vc; // file index, 0 = a
      const sq = document.createElement("div");
      const dark = (r + f) % 2 === 1; // tied to the actual square (a1 dark)
      const name = FILES[f] + (8 - r);
      sq.className = "sq " + (dark ? "dark" : "light");
      sq.dataset.square = name;
      if (lastMove && (lastMove.from === name || lastMove.to === name)) {
        sq.classList.add("lastmove");
      }
      if (selected === name) sq.classList.add("selected");

      const piece = cells[r][f];
      if (piece && PIECES[piece]) {
        const isWhite = piece === piece.toUpperCase();
        const draggable = game && ((isWhite && side === "w") || (!isWhite && side === "b"));
        sq.appendChild(makePiece(piece, isWhite, draggable));
      }

      if (legalTargets.has(name)) addMarker(sq, Boolean(piece));

      if (vr === 7) sq.appendChild(makeCoord("file", FILES[f]));
      if (vc === 0) sq.appendChild(makeCoord("rank", String(8 - r)));

      els.board.appendChild(sq);
    }
  }
  renderMaterial();
}

function makeCoord(kind, text) {
  const el = document.createElement("span");
  el.className = "coord " + kind;
  el.textContent = text;
  return el;
}
function addMarker(sq, isCapture) {
  const m = document.createElement("span");
  m.className = isCapture ? "legal-capture" : "legal-dot";
  sq.appendChild(m);
}
function paintHighlights() {
  els.board.querySelectorAll(".sq").forEach((sq) => {
    const n = sq.dataset.square;
    sq.classList.toggle("selected", selected === n);
    sq.querySelectorAll(".legal-dot,.legal-capture").forEach((x) => x.remove());
    if (legalTargets.has(n)) addMarker(sq, Boolean(sq.querySelector(".piece")));
  });
}

// ---- Move interaction ------------------------------------------------------
function selectSquare(name) {
  selected = name;
  legalTargets.clear();
  for (const m of game.moves({ square: name, verbose: true })) {
    legalTargets.set(m.to, m);
  }
  paintHighlights();
}
function clearSelection() {
  selected = null;
  legalTargets.clear();
  paintHighlights();
}
function doMove(from, to) {
  const candidates = game
    .moves({ square: from, verbose: true })
    .filter((m) => m.to === to);
  if (!candidates.length) return clearSelection();
  const needsPromotion = candidates.some((m) => m.promotion);
  try {
    const move = game.move(needsPromotion ? { from, to, promotion: "q" } : { from, to });
    if (!move) return clearSelection();
    if (pgnLine) clearPgn(); // a manual move diverges from the imported game
    lastMove = { from, to };
    selected = null;
    legalTargets.clear();
    els.fen.value = game.fen();
    els.sideToMove.textContent = game.turn() === "b" ? "Black" : "White";
    renderBoard();
    resetEvalBar();
    updateUndoBtn();
    triggerAuto(true);
  } catch {
    clearSelection();
  }
}

// ---- Import (FEN or PGN) + game navigation ---------------------------------
const FEN_RE = /^([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+\s+[wb]\s/;

function importText(text) {
  text = (text || "").trim();
  if (!text) return setImportMsg("Nothing to import.", false);

  const firstLine = text.split(/\r?\n/)[0].trim();

  // Looks like a bare FEN (and not a PGN with headers/movetext)?
  if (FEN_RE.test(firstLine) && !text.includes("[") && !/\d+\.\s*\S/.test(text)) {
    try {
      new Chess(firstLine);
      clearPgn();
      els.fen.value = firstLine;
      els.preset.value = firstLine;
      loadPosition(firstLine);
      setImportMsg("Loaded position from FEN.", true);
      triggerAuto(true);
      return;
    } catch {
      /* fall through to PGN attempt */
    }
  }

  // Try PGN (a full game or a fragment, possibly with a [FEN] setup header).
  try {
    const g = new Chess();
    g.loadPgn(text);
    buildPgnLine(g);
    const n = pgnLine.length - 1;
    if (n === 0) {
      // PGN had only a [FEN] header and no moves -> treat as a position.
      gotoPly(0);
      setImportMsg("Loaded position from PGN header.", true);
    } else {
      gotoPly(0);
      setImportMsg(`Loaded game: ${n} half-moves.`, true);
    }
  } catch (e) {
    setImportMsg("Could not parse as FEN or PGN: " + (e.message || e), false);
  }
}

function buildPgnLine(g) {
  const headers = g.header();
  const start = headers.FEN || START_FEN;
  const sans = g.history();
  const replay = new Chess(start);
  const line = [{ fen: replay.fen(), from: null, to: null, san: null }];
  for (const san of sans) {
    const mv = replay.move(san);
    line.push({ fen: replay.fen(), from: mv.from, to: mv.to, san: mv.san });
  }
  pgnLine = line;
  const w = headers.White || "?";
  const b = headers.Black || "?";
  const res = headers.Result && headers.Result !== "*" ? `  ${headers.Result}` : "";
  pgnLabel = headers.Event && !headers.White ? headers.Event : `${w} – ${b}${res}`;
  els.pgnGame.textContent = pgnLabel;
  els.pgnGame.title = pgnLabel;
  els.pgnNav.classList.remove("hidden");
}

function gotoPly(k) {
  if (!pgnLine) return;
  pgnPly = Math.max(0, Math.min(pgnLine.length - 1, k));
  const node = pgnLine[pgnPly];
  els.fen.value = node.fen;
  try { game = new Chess(node.fen); } catch { game = null; }
  selected = null;
  legalTargets.clear();
  lastMove = node.from ? { from: node.from, to: node.to } : null;
  renderBoard();
  els.sideToMove.textContent = game ? (game.turn() === "b" ? "Black" : "White") : "—";
  resetEvalBar();
  updateUndoBtn();
  updatePgnNav();
  triggerAuto(true);
}

function updatePgnNav() {
  if (!pgnLine) return;
  els.plyLabel.textContent = `${pgnPly} / ${pgnLine.length - 1}`;
  els.firstBtn.disabled = els.prevBtn.disabled = pgnPly === 0;
  els.nextBtn.disabled = els.lastBtn.disabled = pgnPly === pgnLine.length - 1;
  renderMoveList();
}

function renderMoveList() {
  if (!pgnLine) { els.moveList.innerHTML = ""; return; }
  let html = "";
  for (let ply = 1; ply < pgnLine.length; ply++) {
    if (ply % 2 === 1) html += `<span class="movenum">${(ply + 1) / 2}.</span>`;
    const cls = "move" + (ply === pgnPly ? " current" : "");
    html += `<span class="${cls}" data-ply="${ply}">${escapeHtml(pgnLine[ply].san)}</span> `;
  }
  els.moveList.innerHTML = html;
  const cur = els.moveList.querySelector(".move.current");
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

function clearPgn() {
  pgnLine = null;
  pgnPly = 0;
  pgnLabel = "";
  els.pgnNav.classList.add("hidden");
  els.moveList.innerHTML = "";
}

function setImportMsg(text, ok) {
  els.importMsg.textContent = text;
  els.importMsg.className = "import-msg " + (ok ? "ok" : "err");
}

// ---- Eval bar --------------------------------------------------------------
function scoreWhiteView(score, side) {
  const flip = side === "b" ? -1 : 1;
  if (score.type === "mate") return { mate: score.value * flip, cp: null };
  return { mate: null, cp: score.value * flip };
}
function whiteFraction(w) {
  if (w.mate != null) return w.mate > 0 ? 1 : w.mate < 0 ? 0 : 0.5;
  const cp = Math.max(-1500, Math.min(1500, w.cp));
  const p = 1 / (1 + Math.pow(10, -cp / 400));
  return Math.max(0.03, Math.min(0.97, p));
}
function applyEvalBar(frac, text) {
  els.evalFill.style.height = (frac * 100).toFixed(1) + "%";
  els.evalBarText.textContent = text;
  els.evalBarText.className = "evalbar-text " + (frac >= 0.5 ? "on-white" : "on-black");
}
function setEvalBar(score, side) {
  applyEvalBar(whiteFraction(scoreWhiteView(score, side)), fmtScore(score, side));
}
function resetEvalBar() {
  applyEvalBar(0.5, "0.0");
}

// ---- Formatting helpers ----------------------------------------------------
function fmtBig(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtScore(score, sideToMove) {
  if (!score) return "—";
  const flip = sideToMove === "b" ? -1 : 1;
  if (score.type === "mate") {
    const m = score.value * flip;
    return (m >= 0 ? "#" : "#-") + Math.abs(m);
  }
  const cp = (score.value * flip) / 100;
  return (cp > 0 ? "+" : "") + cp.toFixed(2);
}

// ---- Coordinate (UCI) -> Standard Algebraic Notation (SAN) -----------------
// The engine reports moves in long coordinate form ("g1f3", "e7e8q"). We replay
// them through chess.js, which produces correct SAN — piece letters, captures,
// check/mate, castling (O-O), promotion (=Q), and the file/rank disambiguation
// needed when two knights or rooks can reach the same square (Nbd7, R1e2, …).
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/;
function uciParts(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]?.toLowerCase() };
}
function uciToSan(fen, uci) {
  if (!uci || !UCI_RE.test(uci)) return uci || "—";
  try {
    const chess = new Chess(fen);
    const mv = chess.move(uciParts(uci));
    return mv ? mv.san : uci;
  } catch {
    return uci;
  }
}
// Format a whole PV as a numbered SAN line, e.g. "12. Nf3 Nc6 13. Bb5" or, when
// Black is to move, "12... Nc6 13. Bb5". Falls back to raw UCI if it can't.
function pvToSan(fen, uciList) {
  let chess;
  try { chess = new Chess(fen); } catch { return uciList.join(" "); }
  const parts = (fen || "").trim().split(/\s+/);
  let moveNum = parseInt(parts[5], 10) || 1;
  let white = parts[1] !== "b";
  const out = [];
  let first = true;
  for (const uci of uciList) {
    if (!UCI_RE.test(uci)) break;
    let mv = null;
    try { mv = chess.move(uciParts(uci)); } catch { mv = null; }
    if (!mv) break;
    if (white) out.push(`${moveNum}.`, mv.san);
    else { if (first) out.push(`${moveNum}...`); out.push(mv.san); moveNum++; }
    white = !white;
    first = false;
  }
  return out.length ? out.join(" ") : uciList.join(" ");
}

// ---- UCI line parsing ------------------------------------------------------
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
      case "hashfull": info.hashfull = +t[++i]; break;
      case "tbhits": info.tbhits = +t[++i]; break;
      case "score": info.score = { type: t[++i], value: +t[++i] }; break;
      case "pv": info.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  return info;
}

// ---- Analysis / WebSocket --------------------------------------------------
let ws = null;
let running = false;
let startPerf = 0;
let rafId = 0;
let tokenCounter = 0;
let activeToken = null;
let lastInfo = null;
let currentRun = null;
let initialDone = false;
const pvLines = new Map();
let curSide = "w";
let curFen = START_FEN; // FEN of the position the active search is analyzing
let bestMoveSan = "—"; // SAN of the engine's final best move (for history)

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => maybeAutoStartInitial();
  ws.onclose = () => {
    setEngineDot("bad");
    els.engineText.textContent = "Disconnected — is the server running?";
    if (running) finishRun("(connection lost)");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServer(msg);
  };
}

function handleServer(msg) {
  switch (msg.type) {
    case "engine":
      if (msg.token !== activeToken) return; // output from a superseded search
      onEngineLine(msg.line);
      break;
    case "started":
      // Reset wall-clock to the moment this search actually launched, so the
      // timer reflects pure search time (not the wait for a previous stop).
      if (msg.token === activeToken) startPerf = performance.now();
      break;
    case "bench": onBenchLine(msg.line); break;
    case "bench-started": break;
    case "bench-done": finishBench(); break;
    case "error":
      appendLog(`[error] ${msg.message}`);
      setEngineDot("bad");
      els.engineText.textContent = msg.message;
      finishRun("(error)");
      break;
    case "engine-exit":
      appendLog(`[engine exited: ${msg.code}]`);
      if (running) finishRun("(engine exited)");
      break;
    default: break;
  }
}

function onEngineLine(line) {
  appendLog(line);
  if (line.startsWith("info ") && line.includes(" pv ")) {
    const info = parseInfo(line);
    lastInfo = info;
    if (info.multipv) pvLines.set(info.multipv, info);
    else pvLines.set(1, info);
    updateLiveStats(info);
    renderTopMoves();
  } else if (line.startsWith("info ") && line.includes(" score ")) {
    const info = parseInfo(line);
    lastInfo = info;
    updateLiveStats(info);
  } else if (line.startsWith("bestmove")) {
    const mv = line.split(/\s+/)[1];
    bestMoveSan = mv && mv !== "(none)" ? uciToSan(curFen, mv) : "—";
    finishRun("done");
  }
}

function updateLiveStats(info) {
  if (info.depth != null) {
    els.depthVal.textContent = info.depth + (info.seldepth ? `/${info.seldepth}` : "");
  }
  if (info.nodes != null) els.nodesVal.textContent = fmtBig(info.nodes);
  if (info.nps != null) els.npsVal.textContent = fmtBig(info.nps) + "/s";
  if (info.time != null) els.engTimeVal.textContent = (info.time / 1000).toFixed(2) + "s";
  // The headline eval and the eval bar follow the best line (MultiPV 1) only.
  if (info.score && (info.multipv == null || info.multipv === 1)) {
    els.evalVal.textContent = fmtScore(info.score, curSide);
    setEvalBar(info.score, curSide);
  }
}

// Which side a move favors, from the *evaluation's* sign (White's perspective).
// This is what makes the coloring "natural": in a winning position every top
// move keeps the leader's color; only a move that pushes the eval across zero
// flips to the other color.
function advantageClass(score, side) {
  const w = scoreWhiteView(score, side);
  if (w.mate != null) return w.mate > 0 ? "white" : w.mate < 0 ? "black" : "even";
  if (w.cp > 0) return "white";
  if (w.cp < 0) return "black";
  return "even";
}

function renderTopMoves() {
  if (pvLines.size === 0) return;
  const indices = [...pvLines.keys()].sort((a, b) => a - b);
  els.topMoves.innerHTML = "";
  for (const idx of indices) {
    const info = pvLines.get(idx);
    if (!info.pv || !info.pv.length || !info.score) continue;
    const moveSan = uciToSan(curFen, info.pv[0]);
    const evalStr = fmtScore(info.score, curSide); // White's perspective
    const line = pvToSan(curFen, info.pv.slice(0, 12));
    const box = document.createElement("div");
    box.className = "tm-box " + advantageClass(info.score, curSide);
    box.dataset.uci = info.pv[0];
    box.title = "Hover to preview · click to play";
    box.innerHTML =
      `<div class="tm-row1">` +
      `<span class="tm-move"><span class="tm-rank">${idx}</span>${escapeHtml(moveSan)}</span>` +
      `<span class="tm-eval">${escapeHtml(evalStr)}</span>` +
      `</div>` +
      `<div class="tm-line">${escapeHtml(line)}</div>`;
    els.topMoves.appendChild(box);
  }
}

// ---- Move-preview ghosts ---------------------------------------------------
// Hovering a top-move box slides a translucent copy of the moving piece from its
// origin square to the destination. Un-hovering plays the slide in reverse so
// the ghost returns home, then removes itself. Each move keeps its own ghost +
// animation, so a ghost gliding back never conflicts with another sliding out.
const ghosts = new Map(); // uci -> { el, anim, dismissing }
let hoverUci = null;

function setGhostHints(uci) {
  els.board
    .querySelectorAll(".ghost-from, .ghost-to")
    .forEach((s) => s.classList.remove("ghost-from", "ghost-to"));
  if (!uci) return;
  els.board.querySelector(`[data-square="${uci.slice(0, 2)}"]`)?.classList.add("ghost-from");
  els.board.querySelector(`[data-square="${uci.slice(2, 4)}"]`)?.classList.add("ghost-to");
}

function spawnGhost(uci) {
  const existing = ghosts.get(uci);
  if (existing) {
    // Re-entering a ghost that was gliding home: send it forward again.
    existing.dismissing = false;
    if (existing.anim) { existing.anim.playbackRate = 1; existing.anim.play(); }
    return;
  }
  if (!game || !uci || uci.length < 4) return;
  const fromSq = els.board.querySelector(`[data-square="${uci.slice(0, 2)}"]`);
  const toSq = els.board.querySelector(`[data-square="${uci.slice(2, 4)}"]`);
  if (!fromSq || !toSq) return;
  const piece = game.get(uci.slice(0, 2));
  if (!piece) return;

  const size = fromSq.offsetWidth;
  const isWhite = piece.color === "w";
  const el = document.createElement("div");
  el.className = "move-ghost";
  el.style.width = size + "px";
  el.style.height = size + "px";
  el.style.left = fromSq.offsetLeft + "px";
  el.style.top = fromSq.offsetTop + "px";
  el.style.fontSize = Math.round(size * 0.78) + "px"; // for the unicode set
  el.appendChild(makePiece(isWhite ? piece.type.toUpperCase() : piece.type, isWhite, false));
  els.board.appendChild(el);

  const dx = toSq.offsetLeft - fromSq.offsetLeft;
  const dy = toSq.offsetTop - fromSq.offsetTop;
  const rec = { el, anim: null, dismissing: false };
  try {
    rec.anim = el.animate(
      [{ transform: "translate(0,0)" }, { transform: `translate(${dx}px, ${dy}px)` }],
      { duration: 550, fill: "forwards", easing: "ease-in-out" }
    );
    rec.anim.onfinish = () => {
      if (rec.dismissing) { el.remove(); ghosts.delete(uci); } // finished gliding home
    };
  } catch {
    el.style.transform = `translate(${dx}px, ${dy}px)`; // no WAAPI: rest at dest
  }
  ghosts.set(uci, rec);
}

function dismissGhost(uci) {
  const rec = ghosts.get(uci);
  if (!rec) return;
  if (rec.anim) {
    rec.dismissing = true;
    try { rec.anim.reverse(); } catch { rec.el.remove(); ghosts.delete(uci); }
  } else {
    rec.el.remove();
    ghosts.delete(uci);
  }
}

// Remove every ghost immediately (used when the board itself changes/re-renders).
function clearGhosts() {
  for (const rec of ghosts.values()) {
    try { rec.anim?.cancel(); } catch {}
    if (rec.el.parentNode) rec.el.remove();
  }
  ghosts.clear();
  hoverUci = null;
  setGhostHints(null);
}

function tick() {
  els.timer.textContent = ((performance.now() - startPerf) / 1000).toFixed(3);
  if (running) rafId = requestAnimationFrame(tick);
}

// Single entry point for starting/restarting an analysis.
function requestAnalyze() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!game) {
    els.timerLabel.textContent = "fix the FEN to analyze";
    return;
  }
  const token = ++tokenCounter;
  activeToken = token;
  running = true;
  curSide = sideToMoveFromFen(els.fen.value);
  curFen = els.fen.value.trim() || START_FEN;
  pvLines.clear();
  lastInfo = null;

  bestMoveSan = "…";
  els.evalVal.textContent = "…";
  els.depthVal.textContent = "…";
  els.nodesVal.textContent = "…";
  els.npsVal.textContent = "…";
  els.engTimeVal.textContent = "…";
  els.topMoves.innerHTML = '<div class="tm-empty">Searching…</div>';
  clearGhosts();
  els.log.textContent = "";
  els.timer.classList.add("running");
  els.timerLabel.textContent = "seconds elapsed (searching…)";
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;

  const payload = {
    type: "analyze",
    token,
    fen: els.fen.value.trim(),
    limit: els.limit.value,
    depth: +els.depth.value,
    movetime: +els.movetime.value,
    nodes: +els.nodes.value,
    threads: +els.threads.value,
    hash: +els.hash.value,
    multipv: +els.multipv.value,
  };
  currentRun = {
    fen: payload.fen,
    side: curSide,
    limitLabel: limitLabel(),
    threads: payload.threads,
    hash: payload.hash,
    posLabel: positionLabel(payload.fen),
  };

  startPerf = performance.now();
  ws.send(JSON.stringify(payload));
  cancelAnimationFrame(rafId);
  tick();
}

function finishRun(reason) {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  const elapsed = (performance.now() - startPerf) / 1000;
  els.timer.textContent = elapsed.toFixed(3);
  els.timer.classList.remove("running");
  els.timerLabel.textContent =
    reason === "done" ? "seconds (wall-clock) — analysis done" : `seconds — ${reason}`;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  if (reason === "done" && currentRun && lastInfo) logRun(elapsed);
}

function stopRun() {
  if (!running || !ws) return;
  ws.send(JSON.stringify({ type: "stop" }));
  els.timerLabel.textContent = "stopping…";
}

function appendLog(line) {
  els.log.textContent += line + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}

// ---- Auto-analyze triggers -------------------------------------------------
const autoOn = () => els.autoAnalyze.checked;
function debounce(fn, ms) {
  let t;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
const autoDebounced = debounce(() => { if (autoOn()) requestAnalyze(); }, 300);
function triggerAuto(immediate) {
  if (!autoOn()) return;
  if (immediate) requestAnalyze();
  else autoDebounced();
}
function maybeAutoStartInitial() {
  if (initialDone) return;
  if (autoOn() && game && ws && ws.readyState === WebSocket.OPEN) {
    initialDone = true;
    requestAnalyze();
  }
}

// ---- Run history -----------------------------------------------------------
const history = [];
function positionLabel(fen) {
  if (pgnLine) return `${pgnLabel} #${pgnPly}`;
  const opt = [...els.preset.options].find((o) => o.value === fen);
  if (opt) return opt.textContent;
  if (fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")) return "Start position";
  return fen.split(/\s+/).slice(0, 2).join(" ");
}
function limitLabel() {
  switch (els.limit.value) {
    case "movetime": return `${els.movetime.value} ms`;
    case "nodes": return `${(+els.nodes.value).toLocaleString()} nodes`;
    case "infinite": return "infinite";
    default: return `depth ${els.depth.value}`;
  }
}
function logRun(wallSeconds) {
  const i = lastInfo || {};
  const top1 = pvLines.get(1);
  const best = bestMoveSan && bestMoveSan !== "…"
    ? bestMoveSan
    : top1 && top1.pv?.length ? uciToSan(currentRun.fen, top1.pv[0]) : "—";
  const evalInfo = top1 && top1.score ? top1.score : i.score;
  const row = {
    n: history.length + 1,
    pos: currentRun.posLabel,
    fen: currentRun.fen,
    limit: currentRun.limitLabel,
    threads: currentRun.threads,
    hash: currentRun.hash,
    wall: wallSeconds,
    engine: i.time != null ? i.time / 1000 : null,
    depth: i.depth != null ? i.depth + (i.seldepth ? `/${i.seldepth}` : "") : "—",
    nodes: i.nodes ?? null,
    nps: i.nps ?? null,
    best,
    eval: evalInfo ? fmtScore(evalInfo, currentRun.side) : "—",
  };
  history.unshift(row);
  if (history.length > 100) history.pop();
  renderHistory();
}
function renderHistory() {
  if (history.length === 0) {
    els.historyBody.innerHTML =
      '<tr class="empty-row"><td colspan="12">No runs yet — analyze a position to log one.</td></tr>';
    return;
  }
  els.historyBody.innerHTML = "";
  for (const r of history) {
    const tr = document.createElement("tr");
    const evalCls = r.eval.startsWith("-") || r.eval.startsWith("#-") ? "eval-neg" : "eval-pos";
    tr.innerHTML =
      `<td>${r.n}</td>` +
      `<td class="pos" title="${escapeHtml(r.fen)}">${escapeHtml(r.pos)}</td>` +
      `<td>${escapeHtml(r.limit)}</td>` +
      `<td>${r.threads}</td>` +
      `<td>${r.hash}</td>` +
      `<td>${r.wall.toFixed(3)}</td>` +
      `<td>${r.engine != null ? r.engine.toFixed(3) : "—"}</td>` +
      `<td>${r.depth}</td>` +
      `<td>${r.nodes != null ? r.nodes.toLocaleString() : "—"}</td>` +
      `<td>${r.nps != null ? fmtBig(r.nps) : "—"}</td>` +
      `<td class="best">${escapeHtml(r.best)}</td>` +
      `<td class="${evalCls}">${escapeHtml(r.eval)}</td>`;
    els.historyBody.appendChild(tr);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function exportCsv() {
  if (history.length === 0) return;
  const headers = ["run", "position", "fen", "limit", "threads", "hash_mb",
    "wall_s", "engine_s", "depth", "nodes", "nps", "best", "eval"];
  const rows = [...history].reverse().map((r) =>
    [r.n, r.pos, r.fen, r.limit, r.threads, r.hash, r.wall.toFixed(3),
      r.engine != null ? r.engine.toFixed(3) : "", r.depth, r.nodes ?? "",
      r.nps ?? "", r.best, r.eval]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `stockfish-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Engine bench ----------------------------------------------------------
let benchData = {};
function onBenchLine(line) {
  appendLog(line);
  let m;
  if ((m = line.match(/Total time \(ms\)\s*[:=]\s*(\d+)/i))) benchData.time = +m[1];
  else if ((m = line.match(/Nodes searched\s*[:=]\s*(\d+)/i))) benchData.nodes = +m[1];
  else if ((m = line.match(/Nodes\/second\s*[:=]\s*(\d+)/i))) benchData.nps = +m[1];
}
function finishBench() {
  const { nodes, nps, time } = benchData;
  els.benchResult.textContent =
    `${nps ? fmtBig(nps) + " nps" : "?"} · ${nodes ? fmtBig(nodes) + " nodes" : "?"} · ${time != null ? (time / 1000).toFixed(2) + "s" : "?"}`;
  els.benchResult.classList.add("done");
  els.benchBtn.disabled = false;
  els.benchBtn.textContent = "⚡ Run engine bench";
}
function runBench() {
  benchData = {};
  els.benchBtn.disabled = true;
  els.benchBtn.textContent = "running…";
  els.benchResult.classList.remove("done");
  els.benchResult.textContent = "benchmarking…";
  ws.send(JSON.stringify({ type: "bench", threads: +els.threads.value, hash: +els.hash.value }));
}

// ---- Engine status ---------------------------------------------------------
function setEngineDot(state) {
  els.engineDot.className = "dot" + (state ? " " + state : "");
}
const OS_LABEL = { win32: "Windows", darwin: "macOS", linux: "Linux" };
function shortCpu(model) {
  return (model || "")
    .replace(/\((R|TM|tm)\)/g, "")
    .replace(/\bCPU\b/gi, "")
    .replace(/@.*$/, "") // drop the trailing "@ x.xx GHz" (shown separately)
    .replace(/\s+/g, " ")
    .trim();
}
async function loadEngineInfo() {
  try {
    const r = await fetch("/api/engine");
    const d = await r.json();
    if (d.found) {
      setEngineDot("ok");
    } else {
      setEngineDot("bad");
    }
    // Always show the live host specs (engine runs on this machine's CPU).
    const osName = OS_LABEL[d.platform] || d.platform || "";
    els.engineText.textContent =
      `${shortCpu(d.cpuModel)} · ${d.logicalCores} threads · ${d.totalMemGB} GB · ${osName}`;
    els.engineText.title =
      `CPU: ${d.cpuModel}${d.speedGhz ? " @ " + d.speedGhz + " GHz" : ""}\n` +
      `Threads (logical cores): ${d.logicalCores}\n` +
      `RAM: ${d.totalMemGB} GB total · ${d.freeMemGB} GB free\n` +
      `OS: ${osName} ${d.release} (${d.arch})\n` +
      `Host: ${d.hostname}` +
      (d.found ? "" : "\n\n⚠ No Stockfish binary found on the server.");
    if (!d.found) els.engineText.textContent = "No Stockfish binary found on server.";
    els.threadsHint.textContent = `(1–${d.logicalCores})`;
    els.threads.max = d.logicalCores;
    els.threads.value = Math.max(1, d.logicalCores - 1);
  } catch {
    setEngineDot("bad");
    els.engineText.textContent = "Could not reach server.";
  }
  maybeAutoStartInitial();
}

// ---- Wiring ----------------------------------------------------------------
function showLimitField() {
  const v = els.limit.value;
  document.querySelectorAll(".limit-field").forEach((f) => {
    f.classList.toggle("hidden", f.dataset.for !== v);
  });
}

// Board interaction: click-to-move + custom pointer dragging. We use pointer
// events (not native HTML5 DnD) so the piece stays exactly under the point you
// grabbed it by, instead of snapping its center to the cursor.
let drag = null;

function squareUnder(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const sq = el && el.closest ? el.closest(".sq") : null;
  return sq ? sq.dataset.square : null;
}
function startDragVisual() {
  drag.started = true;
  const size = drag.sqEl.offsetWidth;
  const el = document.createElement("div");
  el.className = "drag-piece";
  el.style.width = size + "px";
  el.style.height = size + "px";
  el.style.fontSize = Math.round(size * 0.78) + "px"; // for the unicode set
  el.appendChild(makePiece(drag.pieceChar, drag.isWhite, false));
  els.board.appendChild(el);
  drag.el = el;
  const orig = drag.sqEl.querySelector(".piece");
  if (orig) orig.style.visibility = "hidden"; // lift the piece off its square
  moveDragVisual(drag.lastX, drag.lastY);
}
function moveDragVisual(clientX, clientY) {
  if (!drag || !drag.el) return;
  const rect = els.board.getBoundingClientRect();
  // Keep the grabbed point pinned to the cursor (no recentering).
  const x = clientX - rect.left - drag.grabX;
  const y = clientY - rect.top - drag.grabY;
  drag.el.style.transform = `translate(${x}px, ${y}px)`;
}
function endDrag() {
  if (!drag) return;
  try { els.board.releasePointerCapture(drag.pointerId); } catch {}
  if (drag.el && drag.el.parentNode) drag.el.remove();
  if (drag.sqEl) {
    const o = drag.sqEl.querySelector(".piece");
    if (o) o.style.visibility = "";
  }
  drag = null;
}

els.board.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !game) return;
  const sqEl = e.target.closest(".sq");
  if (!sqEl) return;
  const name = sqEl.dataset.square;

  // Second click of click-to-move (or clicking a highlighted target).
  if (selected && legalTargets.has(name)) {
    doMove(selected, name);
    e.preventDefault();
    return;
  }
  const piece = game.get(name);
  if (!piece || piece.color !== game.turn()) {
    clearSelection();
    return;
  }
  selectSquare(name);
  const rect = sqEl.getBoundingClientRect();
  drag = {
    from: name,
    sqEl,
    pieceChar: piece.color === "w" ? piece.type.toUpperCase() : piece.type,
    isWhite: piece.color === "w",
    el: null,
    started: false,
    startX: e.clientX, startY: e.clientY,
    lastX: e.clientX, lastY: e.clientY,
    grabX: e.clientX - rect.left, // offset of the grab point within the square
    grabY: e.clientY - rect.top,
    pointerId: e.pointerId,
  };
  try { els.board.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});

els.board.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    startDragVisual();
  }
  moveDragVisual(e.clientX, e.clientY);
});

els.board.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const from = drag.from;
  const wasDragging = drag.started;
  const target = wasDragging ? squareUnder(e.clientX, e.clientY) : null;
  endDrag();
  if (wasDragging) {
    if (target && legalTargets.has(target)) doMove(from, target);
    else clearSelection();
  }
  // A plain click (no movement) leaves the piece selected for click-to-move.
});

els.board.addEventListener("pointercancel", () => { endDrag(); clearSelection(); });

els.preset.addEventListener("change", () => {
  clearPgn();
  els.fen.value = els.preset.value;
  loadPosition(els.fen.value);
  triggerAuto(true);
});
els.fen.addEventListener("input", () => {
  clearPgn();
  loadPosition(els.fen.value);
  triggerAuto(false);
});
els.resetBtn.addEventListener("click", () => {
  clearPgn();
  els.fen.value = START_FEN;
  els.preset.value = START_FEN;
  loadPosition(START_FEN);
  triggerAuto(true);
});
els.undoBtn.addEventListener("click", () => {
  if (!game || !game.undo()) return;
  lastMove = null;
  selected = null;
  legalTargets.clear();
  els.fen.value = game.fen();
  afterPositionChange();
  triggerAuto(true);
});
els.flipBtn.addEventListener("click", () => { flipped = !flipped; renderBoard(); });
els.copyFenBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.fen.value.trim());
    const old = els.copyFenBtn.textContent;
    els.copyFenBtn.textContent = "✓ Copied";
    setTimeout(() => (els.copyFenBtn.textContent = old), 1200);
  } catch { /* clipboard blocked */ }
});

els.limit.addEventListener("change", () => { showLimitField(); triggerAuto(false); });
for (const id of ["depth", "movetime", "nodes", "threads", "hash", "multipv"]) {
  els[id].addEventListener("change", () => triggerAuto(false));
}
els.autoAnalyze.addEventListener("change", () => {
  if (autoOn() && !running) requestAnalyze();
});

els.startBtn.addEventListener("click", requestAnalyze);
els.stopBtn.addEventListener("click", stopRun);
els.benchBtn.addEventListener("click", runBench);

// Click a top-move box to play that move on the board.
els.topMoves.addEventListener("click", (e) => {
  const box = e.target.closest(".tm-box");
  if (!box || !game || !box.dataset.uci) return;
  doMove(box.dataset.uci.slice(0, 2), box.dataset.uci.slice(2, 4));
});
// Hover a top-move box to preview the move; leaving it glides the ghost home.
els.topMoves.addEventListener("mouseover", (e) => {
  const box = e.target.closest(".tm-box");
  if (!box || !box.dataset.uci) return;
  const uci = box.dataset.uci;
  if (uci === hoverUci) return;
  if (hoverUci) dismissGhost(hoverUci); // reverse the move we just left
  hoverUci = uci;
  spawnGhost(uci); // slide out the newly hovered move
  setGhostHints(uci);
});
els.topMoves.addEventListener("mouseleave", () => {
  if (hoverUci) dismissGhost(hoverUci);
  hoverUci = null;
  setGhostHints(null);
});
els.exportCsvBtn.addEventListener("click", exportCsv);
els.clearHistoryBtn.addEventListener("click", () => { history.length = 0; renderHistory(); });

// Import (paste or file) + game navigation
els.importBtn.addEventListener("click", () => importText(els.importInput.value));
els.importFile.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.importInput.value = reader.result;
    importText(reader.result);
  };
  reader.readAsText(file);
  els.importFile.value = ""; // allow re-importing the same file
});
els.firstBtn.addEventListener("click", () => gotoPly(0));
els.prevBtn.addEventListener("click", () => gotoPly(pgnPly - 1));
els.nextBtn.addEventListener("click", () => gotoPly(pgnPly + 1));
els.lastBtn.addEventListener("click", () => gotoPly(pgnLine ? pgnLine.length - 1 : 0));
els.closePgnBtn.addEventListener("click", clearPgn);
els.moveList.addEventListener("click", (e) => {
  const m = e.target.closest(".move");
  if (m) gotoPly(+m.dataset.ply);
});
document.addEventListener("keydown", (e) => {
  if (!pgnLine) return;
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "ArrowLeft") { gotoPly(pgnPly - 1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { gotoPly(pgnPly + 1); e.preventDefault(); }
  else if (e.key === "Home") { gotoPly(0); e.preventDefault(); }
  else if (e.key === "End") { gotoPly(pgnLine.length - 1); e.preventDefault(); }
});

// Appearance: board color theme + piece set (both persisted across sessions).
try {
  const t = localStorage.getItem("sf-board-theme");
  const p = localStorage.getItem("sf-piece-set");
  if (t) boardTheme = t;
  if (p) pieceSet = p;
} catch {}
els.boardTheme.value = boardTheme;
els.pieceSet.value = pieceSet;
els.board.dataset.theme = boardTheme;
els.boardTheme.addEventListener("change", () => {
  boardTheme = els.boardTheme.value;
  els.board.dataset.theme = boardTheme;
  try { localStorage.setItem("sf-board-theme", boardTheme); } catch {}
});
els.pieceSet.addEventListener("change", () => {
  pieceSet = els.pieceSet.value;
  renderBoard();
  try { localStorage.setItem("sf-piece-set", pieceSet); } catch {}
});

// Settings panel visibility — the cog hides the middle panel so the board can
// expand into the freed space. The choice is remembered across sessions.
const SETTINGS_KEY = "sf-settings-hidden";
function applySettingsHidden(hidden) {
  els.layout.classList.toggle("settings-hidden", hidden);
  els.settingsToggle.classList.toggle("active", !hidden); // glow when panel open
  els.settingsToggle.setAttribute("aria-pressed", hidden ? "false" : "true");
  els.settingsToggle.title = hidden ? "Show analysis settings" : "Hide analysis settings";
}
let settingsHidden = false;
try { settingsHidden = localStorage.getItem(SETTINGS_KEY) === "1"; } catch {}
els.settingsToggle.addEventListener("click", () => {
  settingsHidden = !settingsHidden;
  try { localStorage.setItem(SETTINGS_KEY, settingsHidden ? "1" : "0"); } catch {}
  applySettingsHidden(settingsHidden);
});

// init
applySettingsHidden(settingsHidden);
loadPosition(els.fen.value);
showLimitField();
renderHistory();
loadEngineInfo();
connect();
