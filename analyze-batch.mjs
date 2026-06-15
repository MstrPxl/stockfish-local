// CLI: analyze MANY games from a PGN file to a fixed limit, reusing one engine.
// Reports per-game completion + timing and an aggregate with a projection to
// 1000 games — the benchmark for comparing this machine vs better/cloud specs.
//
//   node analyze-batch.mjs <games.pgn> [options]
//
// Options (same search flags as analyze-game.mjs), plus:
//   --max N        only analyze the first N games
//   --out FILE     write a JSON summary (config, per-game timing, totals)
//   --csv FILE     write per-game timing as CSV
//   --quiet        only print the final summary

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolveStockfishPath } from "./lib/stockfish-path.mjs";
import { StockfishEngine, analyzeGame } from "./lib/game-analyzer.mjs";

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "quiet") opts.quiet = true;
      else opts[key] = argv[++i];
    } else positional.push(a);
  }
  return { opts, positional };
}

// Split a multi-game PGN into individual game strings (each starts with [Event).
function splitPgnGames(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n(?=\[Event\s)/)
    .map((s) => s.trim())
    .filter((s) => /\[Event\s/.test(s) || /\d+\.\s*\S/.test(s));
}

function fmtBig(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}h ` : "") + (h || m ? `${m}m ` : "") + `${sec}s`;
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const file = positional[0] || opts.pgn;
  if (!file) {
    console.error("Usage: node analyze-batch.mjs <games.pgn> [--depth N|--nodes N|--movetime MS] [--threads N] [--hash MB] [--max N] [--out FILE] [--csv FILE] [--quiet]");
    process.exit(2);
  }
  const text = opts.pgn ? opts.pgn : readFileSync(file, "utf8");
  let games = splitPgnGames(text);
  if (opts.max) games = games.slice(0, +opts.max);
  if (!games.length) { console.error("No games found in input."); process.exit(1); }

  const enginePath = resolveStockfishPath();
  if (!enginePath) { console.error("No Stockfish binary found. Set STOCKFISH_PATH or install Stockfish."); process.exit(1); }

  const config = {
    depth: opts.depth ? +opts.depth : undefined,
    nodes: opts.nodes ? +opts.nodes : undefined,
    movetime: opts.movetime ? +opts.movetime : undefined,
    threads: opts.threads ? +opts.threads : Math.max(1, os.cpus().length - 1),
    hash: opts.hash ? +opts.hash : 256,
    multipv: opts.multipv ? +opts.multipv : 1,
  };

  const engine = new StockfishEngine(enginePath);
  const name = await engine.init();
  await engine.setOptions(config);

  console.log(`Engine: ${name}`);
  console.log(`Host:   ${os.cpus()[0]?.model?.trim()} · ${os.cpus().length} threads · ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB · ${os.platform()} ${os.arch()}`);
  console.log(`Games:  ${games.length}    Search: ${config.nodes ? config.nodes + " nodes" : config.movetime ? config.movetime + " ms" : "depth " + (config.depth || 18)}/pos, ${config.threads} threads, ${config.hash} MB`);
  console.log("");

  const perGame = [];
  let totalWall = 0, totalEngine = 0, totalNodes = 0, totalPositions = 0, completed = 0, failed = 0;
  const batchStart = Date.now();

  for (let i = 0; i < games.length; i++) {
    try {
      const r = await analyzeGame(engine, games[i], config);
      completed++;
      totalWall += r.timing.wallMs;
      totalEngine += r.timing.engineMs;
      totalNodes += r.timing.totalNodes;
      totalPositions += r.completion.positionsAnalyzed;
      perGame.push({
        n: i + 1, white: r.game.white, black: r.game.black, plies: r.game.plyCount,
        positions: r.completion.positionsAnalyzed, complete: r.completion.satisfied,
        wallMs: r.timing.wallMs, engineMs: r.timing.engineMs, nodes: r.timing.totalNodes,
        acplW: r.aggregates.w.acpl, acplB: r.aggregates.b.acpl,
      });
      if (!opts.quiet) {
        console.log(
          `[${String(i + 1).padStart(4)}/${games.length}] ${(r.game.white + " vs " + r.game.black).slice(0, 34).padEnd(34)} ` +
          `${String(r.game.plyCount).padStart(3)} plies  ${String(r.completion.positionsAnalyzed).padStart(3)} pos  ` +
          `${(r.timing.wallMs / 1000).toFixed(2).padStart(7)}s  ACPL W${r.aggregates.w.acpl}/B${r.aggregates.b.acpl}` +
          (r.completion.satisfied ? "" : "  ⚠ INCOMPLETE")
        );
      }
    } catch (e) {
      failed++;
      if (!opts.quiet) console.log(`[${String(i + 1).padStart(4)}/${games.length}] ⚠ skipped (${e.message})`);
    }
  }
  engine.quit();
  const batchWall = Date.now() - batchStart;

  const avgWall = completed ? totalWall / completed : 0;
  const summary = {
    host: { cpu: os.cpus()[0]?.model?.trim(), threads: os.cpus().length, totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1), platform: os.platform(), arch: os.arch() },
    config: { limit: config.nodes ? "nodes" : config.movetime ? "movetime" : "depth", depth: config.depth || (config.nodes || config.movetime ? undefined : 18), nodes: config.nodes, movetime: config.movetime, threads: config.threads, hash: config.hash, multipv: config.multipv },
    totals: {
      gamesRequested: games.length, gamesCompleted: completed, gamesFailed: failed,
      positions: totalPositions, batchWallMs: batchWall, sumGameWallMs: totalWall, engineMs: totalEngine, nodes: totalNodes,
      avgGameWallMs: Math.round(avgWall),
      avgPositionMs: totalPositions ? Math.round(totalWall / totalPositions) : 0,
      nps: totalEngine ? Math.round(totalNodes / (totalEngine / 1000)) : null,
      projected1000GamesMs: Math.round(avgWall * 1000),
    },
    perGame,
  };

  console.log("");
  console.log("──────────── BATCH COMPLETE ────────────");
  console.log(`  Games completed:   ${completed}/${games.length}${failed ? `  (${failed} failed)` : ""}`);
  console.log(`  Positions:         ${totalPositions}  (~${summary.totals.avgPositionMs} ms/position)`);
  console.log(`  Total wall time:   ${fmtDuration(batchWall)}  (sum of game times ${fmtDuration(totalWall)})`);
  console.log(`  Avg per game:      ${(avgWall / 1000).toFixed(2)}s`);
  console.log(`  Engine speed:      ~${fmtBig(summary.totals.nps)}nps  (${fmtBig(totalNodes)} nodes)`);
  console.log(`  ▶ Projected 1000 games: ${fmtDuration(summary.totals.projected1000GamesMs)}`);

  if (opts.out) { writeFileSync(opts.out, JSON.stringify(summary, null, 2)); console.log(`  Summary JSON → ${opts.out}`); }
  if (opts.csv) {
    const header = "game,white,black,plies,positions,complete,wall_s,engine_s,nodes,acpl_white,acpl_black";
    const rows = perGame.map((g) => [g.n, `"${g.white}"`, `"${g.black}"`, g.plies, g.positions, g.complete, (g.wallMs / 1000).toFixed(3), (g.engineMs / 1000).toFixed(3), g.nodes, g.acplW, g.acplB].join(","));
    writeFileSync(opts.csv, [header, ...rows].join("\r\n"));
    console.log(`  Per-game CSV → ${opts.csv}`);
  }
}

main().catch((e) => { console.error("\nError:", e.message); process.exit(1); });
