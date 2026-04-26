/**
 * auto-fix — end-of-turn formatter/linter dispatcher.
 *
 * Collects every file written during a turn (via `edit` / `write` tool
 * results and `context-guard:file-modified` events), then on `agent_end`
 * dispatches each file to a language-appropriate fixer command (eslint,
 * black, prettier, etc.). Fixes are applied silently; the user is only
 * notified of the final summary.
 *
 * Config resolution order (first hit wins):
 *   1. PI_AUTO_FIX=0 → extension is disabled entirely
 *   2. ~/.pi/agent/auto-fix.json
 *   3. built-in defaults (see DEFAULT_FIXERS below)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FixerRule {
  /** File extensions this rule matches (include leading dot, lowercase). */
  extensions: string[];
  /** Shell command; `{files}` is replaced with space-separated, quoted paths. */
  command: string;
  /** Optional human-readable label used in notifications. */
  label?: string;
}

interface Config {
  enabled: boolean;
  fixers: FixerRule[];
  /** Glob-ish substring ignore patterns applied to the relative path. */
  ignore: string[];
  /** Per-fixer timeout in ms. */
  timeoutMs: number;
  /** Max parallel fixer invocations. */
  concurrency: number;
}

const DEFAULT_FIXERS: FixerRule[] = [
  {
    label: "eslint",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "npx eslint --fix --no-error-on-unmatched-pattern {files}",
  },
  {
    label: "ruff",
    extensions: [".py"],
    command:
      "uvx ruff check --fix --quiet {files} && uvx ruff format --quiet {files}",
  },
  {
    label: "prettier",
    extensions: [".json", ".md", ".yml", ".yaml", ".css", ".scss", ".html"],
    command: "npx prettier --write --log-level=warn {files}",
  },
];

const DEFAULT_CONFIG: Config = {
  enabled: true,
  fixers: DEFAULT_FIXERS,
  ignore: ["node_modules/", "dist/", "build/", ".git/", ".next/", "coverage/"],
  timeoutMs: 60_000,
  concurrency: 3,
};

const CONFIG_PATH = `${homedir()}/.pi/agent/auto-fix.json`;

function loadConfig(): Config {
  if (process.env.PI_AUTO_FIX === "0") {
    return { ...DEFAULT_CONFIG, enabled: false };
  }
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf-8"),
    ) as Partial<Config>;
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      fixers: parsed.fixers ?? DEFAULT_CONFIG.fixers,
      ignore: parsed.ignore ?? DEFAULT_CONFIG.ignore,
      timeoutMs: parsed.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      concurrency: parsed.concurrency ?? DEFAULT_CONFIG.concurrency,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function matchFixer(
  absPath: string,
  fixers: FixerRule[],
): FixerRule | undefined {
  const ext = extname(absPath).toLowerCase();
  if (!ext) return undefined;
  return fixers.find((f) => f.extensions.includes(ext));
}

function isIgnored(relPath: string, ignore: string[]): boolean {
  return ignore.some((p) => relPath.includes(p));
}

function mtimeSafe(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

async function runFixer(
  rule: FixerRule,
  files: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  const filesArg = files.map(shellQuote).join(" ");
  const command = rule.command.includes("{files}")
    ? rule.command.replace("{files}", filesArg)
    : `${rule.command} ${filesArg}`;

  // npx delegates to pnpm when package.json has "packageManager": "pnpm",
  // but pnpm exec doesn't auto-install like npx does. Use a neutral cwd
  // so npx resolves and auto-installs independently of the project's toolchain.
  const spawnCwd = command.startsWith("npx ") ? "/tmp" : cwd;

  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd: spawnCwd, shell: true });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, stderr });
    });
  });
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    },
  );
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  /** Absolute paths written during the current turn. */
  const pending = new Set<string>();

  function collect(rawPath: string, cwd: string): void {
    if (!rawPath) return;
    const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const rel = relative(cwd, absolutePath);
    if (rel.startsWith("..")) return; // outside cwd — skip
    if (isIgnored(rel, cfg.ignore)) return;
    pending.add(absolutePath);
  }

  // Reset between agent runs (turn boundary for pi's purposes).
  pi.on("agent_start", () => {
    pending.clear();
  });

  // Collector 1: direct edit/write tool results.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const rawPath = (event.input as { path?: string }).path;
    if (rawPath) collect(rawPath, ctx.cwd);
  });

  // Collector 2: any extension emitting the shared "file changed" bus
  // (multi-edit emits this after each real write).
  pi.events.on("context-guard:file-modified", (data: unknown) => {
    const path = (data as { path?: string } | null)?.path;
    if (!path) return;
    collect(path, process.cwd());
  });

  // End-of-turn flush.
  pi.on("agent_end", async (_event, ctx) => {
    if (!pending.size) return;
    const paths = [...pending];
    pending.clear();

    await flush(paths, ctx);
  });

  async function flush(paths: string[], ctx: ExtensionContext): Promise<void> {
    // Filter to existing files and group by fixer rule.
    const groups = new Map<FixerRule, string[]>();
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const rule = matchFixer(p, cfg.fixers);
      if (!rule) continue;
      const bucket = groups.get(rule) ?? [];
      bucket.push(p);
      groups.set(rule, bucket);
    }
    if (!groups.size) return;

    let changed = 0;
    const failures: string[] = [];
    const jobs = [...groups.entries()];

    await runWithConcurrency(jobs, cfg.concurrency, async ([rule, files]) => {
      // Snapshot mtimes *before* running this fixer group.
      const groupBefore = new Map(files.map((p) => [p, mtimeSafe(p)]));

      const result = await runFixer(rule, files, ctx.cwd, cfg.timeoutMs);

      // Count how many files this fixer actually changed.
      const groupChanged = files.filter(
        (p) => mtimeSafe(p) !== groupBefore.get(p),
      ).length;
      changed += groupChanged;

      // Only count as failure if the tool failed AND no files changed.
      // Some tools (eslint --fix) exit non-zero even when they fix things.
      if (!result.ok && groupChanged === 0) {
        failures.push(
          `${rule.label ?? rule.command.split(" ")[0]} (${files.length} file${files.length === 1 ? "" : "s"})`,
        );
      }

      // Re-emit file-modified for anything the fixer actually rewrote so
      // context-guard evicts its stale read cache.
      for (const p of files) {
        if (mtimeSafe(p) !== groupBefore.get(p)) {
          pi.events.emit("context-guard:file-modified", { path: p });
        }
      }
    });

    const total = [...groups.values()].reduce((n, b) => n + b.length, 0);
    if (changed > 0 || failures.length) {
      const parts: string[] = [
        `auto-fix: ${changed}/${total} file${total === 1 ? "" : "s"} updated`,
      ];
      if (failures.length) parts.push(`failed: ${failures.join(", ")}`);
      ctx.ui.notify(
        `[auto-fix] ${parts.join(" — ")}`,
        failures.length ? "warning" : "info",
      );
    }
  }
}
