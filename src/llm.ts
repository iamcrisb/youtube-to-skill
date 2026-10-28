import fs from "node:fs";
import path from "node:path";
import { extractJson } from "./skill.js";
import { CliError, isFatal, log, run, which } from "./util.js";

export type Part = { type: "text"; text: string } | { type: "image"; path: string; label: string };

export interface ClaudeRequest {
  system: string;
  parts: Part[];
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Directory Claude is allowed to read images from. */
  readDir: string;
  model?: string;
}

/**
 * Runs headless Claude Code (`claude -p`) on the user's Claude subscription.
 * Images are passed as file paths that Claude opens with its Read tool.
 */
export async function askClaude(req: ClaudeRequest): Promise<string> {
  const prompt = req.parts
    .map((p) => (p.type === "text" ? p.text : `${p.label}\nImage file: ${p.path}`))
    .join("\n\n");
  const hasImages = req.parts.some((p) => p.type === "image");
  const instructions =
    "\n\nYou are running non-interactively inside a CLI tool." +
    (hasImages ? " Use the Read tool to view every image file referenced in the prompt before answering." : "") +
    " Do not create or edit files. Your final message must contain only the requested output format.";
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--add-dir",
    req.readDir,
    "--no-session-persistence",
    "--effort",
    req.effort,
    "--append-system-prompt",
    req.system + instructions,
  ];
  if (req.model) args.push("--model", req.model);

  // Drop API credentials so Claude Code always runs on the logged-in subscription.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const res = await run("claude", args, { input: prompt, cwd: req.readDir, allowFail: true, env });
  let out: any;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    throw new CliError(
      "claude_failed",
      `claude -p failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
      "Run `claude` once interactively and log in with your Claude subscription.",
    );
  }
  if (out.is_error) {
    const msg = String(out.result ?? out.subtype);
    if (/limit resets|spend limit|usage limit|hit your .*limit/i.test(msg)) {
      throw new CliError("usage_limit", `Claude usage limit reached: ${msg}`, "Wait for the limit to reset, then rerun the same command; completed stages are reused.", true);
    }
    if (/not logged in|\/login|authenticat|invalid api key/i.test(msg)) {
      throw new CliError("claude_auth", `Claude Code is not logged in: ${msg}`, "Run `claude` once interactively and log in with your Claude subscription.", true);
    }
    throw new CliError("claude_failed", `claude -p returned an error: ${msg}`);
  }
  return String(out.result ?? "");
}

export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  org: string | null;
  plan: string | null;
}

/** The account `claude -p` will bill, from `claude auth status`. */
export async function claudeAccount(): Promise<ClaudeAccount | null> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const res = await run("claude", ["auth", "status"], { allowFail: true, env });
  try {
    const s = JSON.parse(res.stdout);
    return { loggedIn: !!s.loggedIn, email: s.email ?? null, org: s.orgName ?? null, plan: s.subscriptionType ?? null };
  } catch {
    return null;
  }
}

export async function ensureClaude(): Promise<ClaudeAccount | null> {
  if (!(await which("claude"))) {
    throw new CliError("missing_dependency", "Claude Code (`claude`) is not installed", "Install it from https://claude.com/claude-code and log in once with `claude`.");
  }
  const account = await claudeAccount();
  if (account && !account.loggedIn) {
    throw new CliError("claude_auth", "Claude Code is not logged in", "Run `claude auth login` and pick the account to bill.", true);
  }
  if (account) log(`Billing Claude usage to: ${account.org ?? account.email} (${account.plan ?? "unknown plan"})`);
  return account;
}

let debugCounter = 0;

/** askClaude for a JSON reply: retries once with a reminder, keeps bad replies for debugging. */
export async function askClaudeJson<T>(req: ClaudeRequest): Promise<T> {
  let raw = await askClaude(req);
  try {
    return extractJson<T>(raw);
  } catch (err) {
    if (isFatal(err)) throw err;
    const debug = path.join(req.readDir, "debug");
    fs.mkdirSync(debug, { recursive: true });
    fs.writeFileSync(path.join(debug, `bad-json-${++debugCounter}.txt`), raw);
    log("Reply was not valid JSON, retrying once");
    raw = await askClaude({
      ...req,
      parts: [...req.parts, { type: "text", text: "Reply with only the JSON object in the exact shape requested. Escape any double quotes inside string values." }],
    });
    return extractJson<T>(raw);
  }
}
