#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseTimestamp } from "./frames.js";
import { build, defaultCacheDir, framesAt, transcribe, transcriptManifest, type Effort } from "./pipeline.js";
import { claudeAccount } from "./llm.js";
import { CliError, run, setQuiet, which } from "./util.js";

const HELP = `yt2skill - turn a YouTube video into an Agent Skill (SKILL.md + frames), powered by Claude Code

Usage:
  yt2skill build <url> --prompt "<what the skill should teach>" [options]
  yt2skill transcript <url> [options]          Metadata + timestamped transcript only (no Claude).
  yt2skill frames <url> --at 1:23,2:05 [opts]  Grab frames at given timestamps (no Claude).
  yt2skill doctor                              Check dependencies.

How build works:
  1. Get the transcript (YouTube subtitles, else Whisper) and any GitHub code linked in the description.
  2. Claude scans the transcript window by window (default 3 min) and marks every
     moment that refers to something on screen relevant to the goal.
  3. Frames are grabbed at each moment and at the next scene change; Claude verifies them.
     Misses are retried at nearby scene changes, small text is re-grabbed in 4K with zoomed
     crops, and scrolling content is captured across its whole span and stitched together.
  4. Scene changes nobody talks about are checked for things shown without narration.
  5. Claude writes the skill from verified evidence, then a review pass fact-checks it and
     fixes unsupported claims. Unverified details are listed as gaps.
  Every stage is cached per video + inputs, so a rerun resumes where the last one stopped.
  Claude runs through \`claude -p\` on your Claude subscription.

Build options:
  -p, --prompt <text>        Goal for the skill (required, or --prompt-file)
      --prompt-file <path>   Read the goal from a file ("-" for stdin)
  -o, --out <dir>            Where to write the skill folder (default: ./skills)
      --name <name>          Skill name (kebab-case); default: chosen by Claude
      --model <model>        Model for writing and reviewing the skill (default: Claude Code's default)
      --scan-model <model>   Model for the transcript scan (default: same as --model)
      --check-model <model>  Model for frame checks, stitching, silent visuals, source picking (default: sonnet)
      --effort <level>       low | medium | high | xhigh | max (default: high)
      --max-frames <n>       Cap on screen moments (default: 80, 0 = text only)
      --window <sec>         Transcript window Claude scans at a time (default: 180)
      --concurrency <n>      Parallel \`claude -p\` calls (default: 4)
      --max-silent <n>       Scene changes checked for unnarrated visuals (default: 24, 0 = off)
      --hires-height <px>    Resolution for re-grabbing small text (default: 2160)
      --no-sources           Do not fetch GitHub code linked in the description
      --no-review            Skip the fact-check pass
      --fresh                Ignore cached stages and redo everything
      --force                Overwrite an existing skill folder

Shared options:
      --at <list>            (frames) Comma-separated timestamps: 83, 1:23, 01:02:03
      --lang <code>          Transcript language (default: video language, else en)
      --max-height <px>      Video download resolution cap (default: 720)
      --cache-dir <dir>      Work/cache directory (default: ~/.cache/yt2skill)
      --no-whisper           Fail instead of running Whisper when there are no subtitles
      --json                 Print one JSON object to stdout (logs stay on stderr)
  -q, --quiet                No progress logs
  -h, --help

Exit codes: 0 ok, 1 runtime error, 2 bad arguments.`;

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      "prompt-file": { type: "string" },
      out: { type: "string", short: "o", default: "./skills" },
      name: { type: "string" },
      model: { type: "string" },
      "scan-model": { type: "string" },
      "check-model": { type: "string", default: "sonnet" },
      "max-silent": { type: "string", default: "24" },
      "hires-height": { type: "string", default: "2160" },
      "no-sources": { type: "boolean", default: false },
      "no-review": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      effort: { type: "string", default: "high" },
      "max-frames": { type: "string", default: "80" },
      window: { type: "string", default: "180" },
      concurrency: { type: "string", default: "4" },
      at: { type: "string" },
      "max-height": { type: "string", default: "720" },
      lang: { type: "string" },
      "cache-dir": { type: "string" },
      "no-whisper": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

let parsed: ReturnType<typeof parseCli>;
try {
  parsed = parseCli();
} catch (err: any) {
  const error = { code: "bad_args", message: err?.message ?? String(err), hint: "Run yt2skill --help" };
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ ok: false, error }) + "\n");
  else process.stderr.write(`error [bad_args]: ${error.message}\n`);
  process.exit(2);
}
const { values, positionals } = parsed;

const asJson = values.json;
setQuiet(values.quiet);

function emit(obj: object) {
  process.stdout.write(JSON.stringify(obj, null, asJson ? 0 : 2) + "\n");
}

function num(name: string, v: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new CliError("bad_args", `--${name} must be a non-negative number`);
  return n;
}

async function doctor() {
  const tools = ["yt-dlp", "ffmpeg", "claude", "mlx_whisper", "whisper", "whisper-cli"];
  const found: Record<string, string | null> = {};
  for (const t of tools) found[t] = await which(t);
  const version = async (cmd: string) => (found[cmd] ? (await run(cmd, ["--version"], { allowFail: true })).stdout.trim().split("\n")[0] : null);
  const report = {
    ok: !!(found["yt-dlp"] && found.ffmpeg && found.claude),

    dependencies: {
      "yt-dlp": found["yt-dlp"] ? { path: found["yt-dlp"], version: await version("yt-dlp") } : null,
      ffmpeg: found.ffmpeg ? { path: found.ffmpeg } : null,
      claude: found.claude ? { path: found.claude, version: await version("claude") } : null,
    },
    claude_account: found.claude ? await claudeAccount() : null,
    whisper: found.mlx_whisper ? "mlx_whisper" : found.whisper ? "whisper" : found["whisper-cli"] && process.env.WHISPER_CPP_MODEL ? "whisper-cli" : null,
    cache_dir: path.resolve(values["cache-dir"] ?? defaultCacheDir()),
  };
  if (asJson) return emit(report);
  const mark = (b: unknown) => (b ? "ok " : "-- ");
  console.log(`${mark(found["yt-dlp"])} yt-dlp ${report.dependencies["yt-dlp"]?.version ?? "(missing: brew install yt-dlp)"}`);
  console.log(`${mark(found.ffmpeg)} ffmpeg ${found.ffmpeg ?? "(missing: brew install ffmpeg)"}`);
  console.log(`${mark(found.claude)} Claude Code ${report.dependencies.claude?.version ?? "(missing: https://claude.com/claude-code)"}`);
  const acc = report.claude_account;
  console.log(`${mark(acc?.loggedIn)} Claude account ${acc?.loggedIn ? `${acc.org ?? acc.email} (${acc.plan ?? "unknown plan"}); builds bill this account` : "(not logged in: claude auth login)"}`);
  console.log(`${mark(report.whisper)} Whisper fallback ${report.whisper ?? "(optional: pip install mlx-whisper or openai-whisper)"}`);
  console.log(report.ok ? "\nReady." : "\nNot ready: need yt-dlp, ffmpeg and Claude Code.");
  if (!report.ok) process.exitCode = 1;
}

async function main() {
  const [cmd, url] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  if (cmd === "doctor") return doctor();
  if (!["build", "transcript", "frames"].includes(cmd)) throw new CliError("bad_args", `Unknown command: ${cmd}`, "Run yt2skill --help");
  if (!url) throw new CliError("bad_args", "Missing YouTube URL");

  const source = {
    lang: values.lang,
    maxHeight: num("max-height", values["max-height"]),
    cacheDir: path.resolve(values["cache-dir"] ?? defaultCacheDir()),
    noWhisper: values["no-whisper"],
  };

  if (cmd === "transcript") {
    const t = await transcribe(url, source);
    return emit({ ok: true, ...transcriptManifest(t) });
  }

  if (cmd === "frames") {
    const times = (values.at ?? "").split(",").filter((s) => s.trim()).map(parseTimestamp);
    if (!times.length || times.some((t) => !Number.isFinite(t))) throw new CliError("bad_args", "--at needs timestamps like 83,1:23,01:02:03");
    return emit({ ok: true, ...(await framesAt(url, times, source)) });
  }

  let prompt = values.prompt;
  if (values["prompt-file"]) prompt = fs.readFileSync(values["prompt-file"] === "-" ? 0 : values["prompt-file"], "utf8");
  if (!prompt?.trim()) throw new CliError("bad_args", "Missing --prompt (what should the skill teach?)");
  const effort = values.effort as Effort;
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new CliError("bad_args", "--effort must be low|medium|high|xhigh|max");

  const result = await build(url, {
    ...source,
    prompt: prompt.trim(),
    out: values.out!,
    name: values.name,
    model: values.model,
    scanModel: values["scan-model"],
    checkModel: values["check-model"],
    maxSilent: num("max-silent", values["max-silent"]),
    hiresHeight: num("hires-height", values["hires-height"]),
    noSources: values["no-sources"],
    noReview: values["no-review"],
    fresh: values.fresh,
    effort,
    maxFrames: num("max-frames", values["max-frames"]),
    windowSec: Math.max(30, num("window", values.window)),
    concurrency: Math.max(1, Math.floor(num("concurrency", values.concurrency))),
    force: values.force,
  });
  if (asJson) emit({ ok: true, ...result });
  else {
    console.log(`\nSkill written: ${result.skill_dir}`);
    console.log(`  name: ${result.name}`);
    console.log(`  moments: ${result.moments_verified}/${result.moments_found} verified (${result.hires_frames} hi-res, ${result.scrolled_moments} scrolled), ${result.silent_frames} unnarrated, ${result.frames_linked} frames linked`);
    console.log(`  sources: ${result.source_files} files  review: ${result.review_issues} issues fixed  transcript: ${result.transcript_source}`);
    console.log(`  files: ${result.files.join(", ")}`);
  }
}

main().catch((err) => {
  const e = err instanceof CliError ? err : new CliError("internal_error", err?.message ?? String(err));
  if (asJson) emit({ ok: false, error: { code: e.code, message: e.message, hint: e.hint ?? null } });
  else {
    process.stderr.write(`error [${e.code}]: ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
  }
  process.exitCode = e.code === "bad_args" ? 2 : 1;
});
