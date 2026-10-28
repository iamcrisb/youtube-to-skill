import { spawn } from "node:child_process";

/** Error with a stable machine-readable code, surfaced in --json output. */
export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
    /** Fatal errors (usage limit, logged out) stop the run instead of being skipped per window/batch. */
    public fatal = false,
  ) {
    super(message);
  }
}

export const isFatal = (err: unknown) => err instanceof CliError && err.fatal;

let quiet = false;
export function setQuiet(q: boolean) {
  quiet = q;
}

/** Progress goes to stderr so stdout stays clean for machine-readable output. */
export function log(msg: string) {
  if (!quiet) process.stderr.write(`[yt2skill] ${msg}\n`);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; allowFail?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new CliError("missing_dependency", `Command not found: ${cmd}`, `Install ${cmd} and make sure it is on PATH. Run \`yt2skill doctor\`.`));
      } else reject(err);
    });
    child.on("close", (code) => {
      const res = { stdout, stderr, code: code ?? 1 };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new CliError("command_failed", `${cmd} exited with ${res.code}: ${stderr.trim().split("\n").slice(-5).join("\n")}`));
      } else resolve(res);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function which(cmd: string): Promise<string | null> {
  const res = await run("/usr/bin/env", ["which", cmd], { allowFail: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export function formatTs(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function slugify(s: string, max = 64): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** Maps over items with at most `limit` promises in flight, keeping order. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
