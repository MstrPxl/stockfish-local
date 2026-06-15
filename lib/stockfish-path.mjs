// Locate a native Stockfish binary.
// Priority: explicit STOCKFISH_PATH env var > PATH > winget link/package (Windows).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveStockfishPath() {
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
