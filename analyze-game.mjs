// CLI: analyze ONE full game to a fixed limit and report completion + timing.
//
//   node analyze-game.mjs <game.pgn> [options]
//   node analyze-game.mjs --pgn "1. e4 e5 2. Nf3 ..." [options]
//
// Options:
//   --depth N       fixed search depth per position (default 18)
//   --nodes N       fixed nodes per position (overrides depth) — best for pure
//                   hardware time-scaling across machines
//   --movetime MS   fixed time per position in ms (overrides depth/nodes)
//   --threads N     engine threads (default: logical cores - 1)
//   --hash MB       transposition table size (default 256)
//   --multipv N     candidate lines per position (default 1)
//   --out FILE      write the full analysis JSON to FILE
//   --quiet         don't print per-position progress

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

function fmtBig(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtScore(score) {
  if (!score) return "—";
  if (score.type === "mate") return "#" + score.value;
  return (score.value > 0 ? "+" : "") + (score.value / 100).toFixed(2);
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  let pgn = opts.pgn;
  if (!pgn && positional[0]) pgn = readFileSync(positional[0], "utf8");
  if (!pgn) {
    console.error("Usage: node analyze-game.mjs <game.pgn> [--depth N] [--nodes N] [--movetime MS] [--threads N] [--hash MB] [--multipv N] [--out FILE] [--quiet]");
    process.exit(2);
  }

  const enginePath = resolveStockfishPath();
  if (!enginePath) {
    console.error("No Stockfish binary found. Set STOCKFISH_PATH or install Stockfish.");
    process.exit(1);
  }

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

  const onProgress = opts.quiet
    ? null
    : ({ index, total, ply, score, depth }) => {
        const pct = Math.round(((index + 1) / total) * 100);
        process.stdout.write(
          `\r  analyzing  ${String(index + 1).padStart(3)}/${total}  (${String(pct).padStart(3)}%)  ply ${String(ply).padStart(3)}  d${depth ?? "?"}  ${fmtScore(score).padStart(7)}   `
        );
      };

  console.log(`Engine: ${name}`);
  console.log(`Using:  ${enginePath}`);

  const result = await analyzeGame(engine, pgn, config, onProgress);
  engine.quit();
  if (!opts.quiet) process.stdout.write("\n");

  const { game, completion, config: cfg, timing, aggregates: agg } = result;
  const secs = (timing.wallMs / 1000).toFixed(2);
  const esecs = (timing.engineMs / 1000).toFixed(2);

  console.log("");
  console.log(completion.satisfied ? "✓ Game analysis COMPLETE" : "✗ Game analysis INCOMPLETE");
  console.log(`  ${game.white} vs ${game.black}${game.event ? " — " + game.event : ""}  (${game.result})`);
  console.log(`  Positions analyzed: ${completion.positionsAnalyzed} / ${completion.positionsExpected}  [${cfg.label}, ${cfg.threads} threads, ${cfg.hash} MB]`);
  console.log(`  Wall time: ${secs}s    Engine time: ${esecs}s    Nodes: ${fmtBig(timing.totalNodes)}    ~${fmtBig(timing.nps)}nps`);
  console.log(`  ACPL    White: ${agg.w.acpl}   Black: ${agg.b.acpl}`);
  console.log(`  White:  ${agg.w.blunder} blunder(s), ${agg.w.mistake} mistake(s), ${agg.w.inaccuracy} inaccuracy(ies)`);
  console.log(`  Black:  ${agg.b.blunder} blunder(s), ${agg.b.mistake} mistake(s), ${agg.b.inaccuracy} inaccuracy(ies)`);

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(result, null, 2));
    console.log(`  Full analysis written to ${opts.out}`);
  }

  process.exit(completion.satisfied ? 0 : 1);
}

main().catch((e) => { console.error("\nError:", e.message); process.exit(1); });
