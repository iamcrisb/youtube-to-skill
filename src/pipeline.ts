import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StageCache } from "./cache.js";
import { extractFramesAt, type Frame } from "./frames.js";
import { grabHires, quadrantCrops } from "./hires.js";
import { askClaude, askClaudeJson, ensureClaude, type Part } from "./llm.js";
import {
  ANALYZE_SYSTEM,
  DISCOVER_SYSTEM,
  GENERATE_SYSTEM,
  REVIEW_SYSTEM,
  SELECT_SOURCES_SYSTEM,
  VERIFY_SYSTEM,
  analyzeWindowPrompt,
  combinePrompt,
  discoverPrompt,
  generatePrompt,
  hiresVerifyPrompt,
  reviewPrompt,
  revisePrompt,
  selectSourcesPrompt,
  verifyPrompt,
} from "./prompts.js";
import { detectScenes, firstShotTimes, retryShotTimes, silentCandidates } from "./scenes.js";
import { parseFileBlocks, writeSkill, type SkillFile } from "./skill.js";
import { fetchDescriptionSources, type SourceFile } from "./sources.js";
import { parseVtt, textAround, toMarkdown, whisperTranscribe, type Segment } from "./transcript.js";
import { CliError, formatTs, isFatal, log, pMap, slugify } from "./util.js";
import { downloadSubtitles, downloadVideo, fetchMeta, type VideoMeta } from "./youtube.js";

// Bump when stage outputs change shape, so old caches are not reused.
const PIPELINE_VERSION = 4;
const MERGE_WITHIN_SEC = 5;
const VERIFY_BATCH = 6;
const HIRES_BATCH = 3;
const DISCOVER_BATCH = 8;
const SPAN_MIN_SEC = 5;
const SPAN_MAX_SEC = 40;
const SPAN_MAX_FRAMES = 8;
const SOURCES_MAX_BYTES = 150_000;
const SOURCES_MAX_FILES = 20;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface SourceOptions {
  lang?: string;
  maxHeight: number;
  cacheDir: string;
  noWhisper: boolean;
}

export interface BuildOptions extends SourceOptions {
  prompt: string;
  out: string;
  name?: string;
  model?: string;
  /** Model for the transcript scan (recall matters most here); defaults to `model`. */
  scanModel?: string;
  /** Model for the high-volume checks: frame verification, stitching, silent visuals, source picking. */
  checkModel?: string;
  maxFrames: number;
  maxSilent: number;
  windowSec: number;
  concurrency: number;
  hiresHeight: number;
  effort: Effort;
  noSources: boolean;
  noReview: boolean;
  fresh: boolean;
  force: boolean;
}

export interface Transcribed {
  meta: VideoMeta;
  workDir: string;
  source: "subtitles" | "auto-captions" | "whisper";
  lang: string | null;
  segments: Segment[];
  file: string;
}

export const defaultCacheDir = () => path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "yt2skill");

/** Metadata + transcript. Downloads the video only when Whisper is needed. */
export async function transcribe(url: string, opts: SourceOptions): Promise<Transcribed> {
  const { meta, workDir } = await fetchMeta(url, opts.cacheDir);
  let segments: Segment[] = [];
  let source: Transcribed["source"] = "subtitles";
  let lang: string | null = null;
  const subs = await downloadSubtitles(meta, workDir, opts.lang);
  if (subs) {
    segments = parseVtt(fs.readFileSync(subs.file, "utf8"));
    source = subs.auto ? "auto-captions" : "subtitles";
    lang = subs.lang;
  }
  if (!segments.length) {
    if (opts.noWhisper) throw new CliError("no_transcript", "No subtitles available and Whisper fallback is disabled");
    const video = await downloadVideo(meta, workDir, opts.maxHeight);
    segments = await whisperTranscribe(video, workDir, opts.lang);
    source = "whisper";
    lang = opts.lang ?? null;
  }
  if (!segments.length) throw new CliError("no_transcript", "Transcript is empty");
  const file = path.join(workDir, "transcript.md");
  fs.writeFileSync(file, toMarkdown(segments, 10) + "\n");
  fs.writeFileSync(path.join(workDir, "transcript.json"), JSON.stringify(segments));
  log(`Transcript: ${segments.length} segments from ${source}`);
  return { meta, workDir, source, lang, segments, file };
}

export function transcriptManifest(t: Transcribed) {
  return {
    video: { id: t.meta.id, title: t.meta.title, channel: t.meta.channel, url: t.meta.url, duration: t.meta.duration, chapters: t.meta.chapters },
    work_dir: t.workDir,
    transcript: { source: t.source, lang: t.lang, file: t.file, json: path.join(t.workDir, "transcript.json") },
  };
}

/** Downloads the video (cached) and grabs frames at the given timestamps. */
export async function framesAt(url: string, times: number[], opts: SourceOptions) {
  const { meta, workDir } = await fetchMeta(url, opts.cacheDir);
  const video = await downloadVideo(meta, workDir, opts.maxHeight);
  log(`Extracting ${times.length} frames`);
  const frames = await extractFramesAt(video, workDir, times, meta.duration);
  return { video: { id: meta.id, title: meta.title, url: meta.url }, work_dir: workDir, frames: frames.map((f) => ({ time: f.time, timestamp: formatTs(f.time), file: f.file })) };
}

interface Moment {
  time: number;
  /** Seconds the content scrolls or builds up on screen; 0 for a static shot. */
  span: number;
  look_for?: string;
  why?: string;
}

type Status = "match" | "illegible" | "missing";

interface Verified {
  moment: Moment;
  kind: "still" | "scrolled" | "silent";
  status: Status;
  frame: Frame | null;
  visible: string;
  hires: boolean;
}

interface Ctx {
  t: Transcribed;
  opts: BuildOptions;
  video: string;
  scenes: number[];
}

const ask = <T>(ctx: Ctx, system: string, parts: Part[]) =>
  askClaudeJson<T>({ system, parts, effort: "medium", readDir: ctx.t.workDir, model: ctx.opts.checkModel });

// Soft failures (a batch whose reply could not be parsed) in the current stage; such stages are not cached.
let softFailures = 0;
const complete = () => {
  const ok = softFailures === 0;
  softFailures = 0;
  return ok;
};

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Step 1: Claude scans the transcript window by window for references to the screen. */
async function findMoments(t: Transcribed, opts: BuildOptions, chapters: string): Promise<{ moments: Moment[]; skipped: string[] }> {
  const end = Math.max(t.meta.duration, t.segments[t.segments.length - 1]?.end ?? 0);
  const windows: { from: number; to: number }[] = [];
  for (let from = 0; from < end; from += opts.windowSec) windows.push({ from, to: Math.min(end, from + opts.windowSec) });

  const skipped: string[] = [];
  let done = 0;
  const perWindow = await pMap(windows, opts.concurrency, async (w) => {
    // A little overlap so a reference split across the boundary is not lost.
    const segs = t.segments.filter((s) => s.end >= w.from - 15 && s.start < w.to);
    if (!segs.length) return [];
    let reply: { moments?: Moment[] };
    try {
      reply = await askClaudeJson<{ moments?: Moment[] }>({
        system: ANALYZE_SYSTEM,
        parts: [{ type: "text", text: analyzeWindowPrompt({ goal: opts.prompt, title: t.meta.title, chapters, window: toMarkdown(segs, 10), from: formatTs(w.from), to: formatTs(w.to) }) }],
        effort: "medium",
        readDir: t.workDir,
        model: opts.scanModel ?? opts.model,
      });
    } catch (err) {
      if (isFatal(err)) throw err;
      // One bad window should not sink a long run.
      log(`Warning: skipped window ${formatTs(w.from)}-${formatTs(w.to)}: ${(err as Error).message}`);
      skipped.push(`${formatTs(w.from)}-${formatTs(w.to)}`);
      return [];
    }
    log(`Scanned ${++done}/${windows.length} transcript windows`);
    return (reply.moments ?? [])
      .map((m) => ({ ...m, time: Number(m.time), span: Math.max(0, Number(m.span) || 0) }))
      .filter((m) => Number.isFinite(m.time) && m.time >= w.from - 15 && m.time <= w.to + 5);
  });

  // Merge moments that point at the same thing from adjacent windows.
  const merged: Moment[] = [];
  for (const m of perWindow.flat().sort((a, b) => a.time - b.time)) {
    const prev = merged[merged.length - 1];
    if (prev && m.time - prev.time < MERGE_WITHIN_SEC) {
      prev.look_for = `${prev.look_for ?? ""}; ${m.look_for ?? ""}`;
      prev.span = Math.max(prev.span, m.span);
    } else merged.push({ ...m });
  }
  return { moments: merged.slice(0, opts.maxFrames), skipped };
}

/** Asks Claude which shot (if any) shows each moment's expected content, and whether it is legible. */
async function verifyShots(ctx: Ctx, items: { moment: Moment; shots: Frame[] }[]): Promise<{ status: Status; best: Frame | null; visible: string }[]> {
  const results = await pMap(batches(items, VERIFY_BATCH), ctx.opts.concurrency, async (batch) => {
    const listing = batch
      .map((it, i) => `Moment ${i + 1} at ${formatTs(it.moment.time)}. Expected: ${it.moment.look_for ?? "(unspecified)"}\nShots: ${it.shots.map((f) => f.name).join(", ")}`)
      .join("\n\n");
    const parts: Part[] = [{ type: "text", text: verifyPrompt(listing) }];
    batch.forEach((it, i) => it.shots.forEach((f) => parts.push({ type: "image", path: f.file, label: `Moment ${i + 1}, shot ${f.name}:` })));
    let res: { moment: number; status?: string; best: string | null; visible?: string }[] = [];
    try {
      res = (await ask<{ results?: typeof res }>(ctx, VERIFY_SYSTEM, parts)).results ?? [];
    } catch (err) {
      if (isFatal(err)) throw err;
      // Unverified moments become gaps rather than failing the run.
      softFailures++;
      log(`Warning: verification batch failed: ${(err as Error).message}`);
    }
    return batch.map((it, i) => {
      const r = res.find((x) => Number(x.moment) === i + 1);
      const best = it.shots.find((f) => f.name === r?.best) ?? null;
      const status: Status = r?.status === "illegible" && best ? "illegible" : r?.status === "match" && best ? "match" : best && !r?.status ? "match" : "missing";
      return { status, best, visible: r?.visible ?? "" };
    });
  });
  return results.flat();
}

/** Re-grabs illegible moments at high resolution with zoomed crops and checks them again. */
async function hiresPass(ctx: Ctx, items: Verified[]): Promise<void> {
  if (!items.length) return;
  log(`Re-grabbing ${items.length} moments in high resolution`);
  const grabbed = await pMap(items, ctx.opts.concurrency, async (v) => {
    const [hd] = await grabHires(ctx.t.meta.url, ctx.t.workDir, [v.frame!.time], ctx.opts.hiresHeight).catch(() => []);
    return hd ? { v, hd, crops: await quadrantCrops(hd) } : null;
  });
  const ok = grabbed.filter((g): g is NonNullable<typeof g> => !!g);
  await pMap(batches(ok, HIRES_BATCH), ctx.opts.concurrency, async (batch) => {
    const listing = batch.map((g, i) => `Moment ${i + 1} at ${formatTs(g.hd.time)}. Expected: ${g.v.moment.look_for ?? "(unspecified)"}`).join("\n");
    const parts: Part[] = [{ type: "text", text: hiresVerifyPrompt(listing) }];
    batch.forEach((g, i) => {
      parts.push({ type: "image", path: g.hd.file, label: `Moment ${i + 1}, full frame:` });
      g.crops.forEach((c) => parts.push({ type: "image", path: c.file, label: `Moment ${i + 1}, crop ${c.name}:` }));
    });
    try {
      const res = (await ask<{ results?: { moment: number; status?: string; visible?: string }[] }>(ctx, VERIFY_SYSTEM, parts)).results ?? [];
      batch.forEach((g, i) => {
        const r = res.find((x) => Number(x.moment) === i + 1);
        if (r?.status === "match") Object.assign(g.v, { status: "match", frame: g.hd, visible: r.visible ?? g.v.visible, hires: true });
      });
    } catch (err) {
      if (isFatal(err)) throw err;
      softFailures++;
      log(`Warning: high-resolution check failed: ${(err as Error).message}`);
    }
  });
}

/** Moments whose content scrolls or builds up: frames across the stretch, combined into one transcription. */
async function spanPass(ctx: Ctx, moments: Moment[]): Promise<Verified[]> {
  if (!moments.length) return [];
  log(`Capturing ${moments.length} scrolling/building moments across their span`);
  return pMap(moments, ctx.opts.concurrency, async (m): Promise<Verified> => {
    const span = Math.min(m.span, SPAN_MAX_SEC);
    const step = Math.max(2, span / SPAN_MAX_FRAMES);
    const times: number[] = [];
    for (let x = m.time; x <= m.time + span + 0.01; x += step) times.push(Math.round(x * 10) / 10);
    const combine = async (frames: Frame[]) => {
      const parts: Part[] = [{ type: "text", text: combinePrompt({ lookFor: m.look_for ?? "(unspecified)", frames: frames.map((f) => `${f.name} (${formatTs(f.time)})`).join("\n") }) }];
      frames.forEach((f) => parts.push({ type: "image", path: f.file, label: `Frame ${f.name}:` }));
      return ask<{ status?: string; best?: string; content?: string }>(ctx, VERIFY_SYSTEM, parts);
    };
    const miss: Verified = { moment: m, kind: "scrolled", status: "missing", frame: null, visible: "", hires: false };
    try {
      let frames = await extractFramesAt(ctx.video, ctx.t.workDir, times, ctx.t.meta.duration);
      let r = await combine(frames);
      let hires = false;
      if (r.status === "illegible") {
        const hd = await grabHires(ctx.t.meta.url, ctx.t.workDir, times, ctx.opts.hiresHeight).catch(() => []);
        if (hd.length) {
          frames = hd;
          r = await combine(hd);
          hires = true;
        }
      }
      if (r.status !== "complete" && r.status !== "partial") return { ...miss, visible: r.content ?? "" };
      const best = frames.find((f) => f.name === r.best) ?? frames[frames.length - 1];
      const note = r.status === "partial" ? " (partly visible; [...] marks parts never shown)" : "";
      return { moment: m, kind: "scrolled", status: "match", frame: best, visible: `${r.content ?? ""}${note}`, hires };
    } catch (err) {
      if (isFatal(err)) throw err;
      softFailures++;
      log(`Warning: could not combine moment at ${formatTs(m.time)}: ${(err as Error).message}`);
      return miss;
    }
  });
}

/** Steps 2-3: shots at scene-aware offsets, verification, retries, high-res re-grabs, spans. */
async function captureVerified(ctx: Ctx, moments: Moment[]): Promise<Verified[]> {
  const stills = moments.filter((m) => m.span < SPAN_MIN_SEC);
  const scrolled = moments.filter((m) => m.span >= SPAN_MIN_SEC);
  const shoot = (times: number[]) => extractFramesAt(ctx.video, ctx.t.workDir, times, ctx.t.meta.duration);

  const tried = new Map<Moment, number[]>();
  const first = await pMap(stills, ctx.opts.concurrency, async (moment) => {
    const times = firstShotTimes(moment.time, ctx.scenes);
    tried.set(moment, times);
    return { moment, shots: await shoot(times) };
  });
  log(`Verifying ${stills.length} moments`);
  const round1 = await verifyShots(ctx, first);
  const out: Verified[] = stills.map((moment, i) => ({ moment, kind: "still", status: round1[i].status, frame: round1[i].best, visible: round1[i].visible, hires: false }));

  const misses = out.filter((v) => v.status === "missing");
  if (misses.length) {
    log(`Retrying ${misses.length} moments at nearby scene changes`);
    const retry = await pMap(misses, ctx.opts.concurrency, async (v) => ({ moment: v.moment, shots: await shoot(retryShotTimes(v.moment.time, ctx.scenes, tried.get(v.moment) ?? [])) }));
    const round2 = await verifyShots(ctx, retry);
    misses.forEach((v, k) => {
      if (round2[k].status !== "missing") Object.assign(v, { status: round2[k].status, frame: round2[k].best, visible: round2[k].visible });
      else if (round2[k].visible) v.visible = round2[k].visible;
    });
  }

  await hiresPass(ctx, out.filter((v) => v.status === "illegible"));
  const spans = await spanPass(ctx, scrolled);
  const all = [...out, ...spans].sort((a, b) => a.moment.time - b.moment.time);
  log(`Verified ${all.filter((v) => v.status === "match").length}/${all.length} moments (${all.filter((v) => v.hires).length} via high resolution)`);
  return all;
}

/** Things shown on screen but never mentioned: frames at scene changes far from any moment. */
async function discoverSilent(ctx: Ctx, covered: number[]): Promise<Verified[]> {
  const times = silentCandidates(ctx.scenes, covered, { gap: 20, bucket: 30, max: ctx.opts.maxSilent });
  if (!times.length) return [];
  log(`Checking ${times.length} scene changes with no narration about the screen`);
  const frames = await extractFramesAt(ctx.video, ctx.t.workDir, times, ctx.t.meta.duration);
  const found = await pMap(batches(frames, DISCOVER_BATCH), ctx.opts.concurrency, async (batch) => {
    const items = batch.map((f) => `Frame ${f.name} at ${formatTs(f.time)}. Said around it: "${textAround(ctx.t.segments, f.time, 10).slice(0, 300)}"`).join("\n");
    const parts: Part[] = [{ type: "text", text: discoverPrompt({ goal: ctx.opts.prompt, items }) }];
    batch.forEach((f) => parts.push({ type: "image", path: f.file, label: `Frame ${f.name}:` }));
    try {
      const res = (await ask<{ results?: { frame: string; keep?: boolean; visible?: string }[] }>(ctx, DISCOVER_SYSTEM, parts)).results ?? [];
      return batch.flatMap((f): Verified[] => {
        const r = res.find((x) => x.frame === f.name);
        return r?.keep ? [{ moment: { time: f.time, span: 0, look_for: "shown without narration" }, kind: "silent", status: "match", frame: f, visible: r.visible ?? "", hires: false }] : [];
      });
    } catch (err) {
      if (isFatal(err)) throw err;
      softFailures++;
      log(`Warning: silent-visual check failed: ${(err as Error).message}`);
      return [];
    }
  });
  const kept = found.flat();
  log(`Kept ${kept.length} frames shown without narration`);
  return kept;
}

/** GitHub files from the description, narrowed to what matters for the goal when there are many. */
async function pickSources(ctx: { t: Transcribed; opts: BuildOptions }): Promise<SourceFile[]> {
  const all = await fetchDescriptionSources(ctx.t.meta.description, ctx.t.workDir);
  if (!all.length) return [];
  let chosen = all;
  const total = all.reduce((n, f) => n + f.size, 0);
  if (total > SOURCES_MAX_BYTES || all.length > SOURCES_MAX_FILES) {
    const tree = all.slice(0, 2000).map((f) => `${f.label} (${f.size})`).join("\n");
    try {
      const res = await askClaudeJson<{ files?: string[] }>({
        system: SELECT_SOURCES_SYSTEM,
        parts: [{ type: "text", text: selectSourcesPrompt({ goal: ctx.opts.prompt, title: ctx.t.meta.title, tree, maxFiles: SOURCES_MAX_FILES }) }],
        effort: "low",
        readDir: ctx.t.workDir,
        model: ctx.opts.checkModel,
      });
      const wanted = new Set(res.files ?? []);
      chosen = all.filter((f) => wanted.has(f.label));
    } catch (err) {
      if (isFatal(err)) throw err;
      log(`Warning: source selection failed, using README files only: ${(err as Error).message}`);
      chosen = all.filter((f) => /readme/i.test(f.label));
    }
  }
  const kept: SourceFile[] = [];
  let bytes = 0;
  for (const f of chosen) {
    if (bytes + f.size > SOURCES_MAX_BYTES) continue;
    kept.push(f);
    bytes += f.size;
  }
  log(`Using ${kept.length} source files from the description`);
  return kept;
}

function sourcesText(files: SourceFile[]): string {
  return files.map((f) => `<source_file label="${f.label}">\n${fs.readFileSync(f.file, "utf8")}\n</source_file>`).join("\n\n");
}

function evidenceText(verified: Verified[]): string {
  return verified
    .filter((v) => v.status === "match" && v.frame)
    .map((v) => {
      const tag = v.kind === "scrolled" ? "[scrolled] " : v.kind === "silent" ? "[shown without narration] " : "";
      const when = v.kind === "scrolled" ? `${formatTs(v.moment.time)}-${formatTs(v.moment.time + v.moment.span)}` : formatTs(v.frame!.time);
      return `- ${tag}assets/frames/${v.frame!.name} (${when}): ${v.visible || v.moment.look_for || ""}`;
    })
    .join("\n");
}

function filesText(files: SkillFile[]): string {
  return files.map((f) => `<file path="${f.path}">\n${f.content}</file>`).join("\n");
}

export async function build(url: string, opts: BuildOptions) {
  const account = await ensureClaude();
  const t = await transcribe(url, opts);
  const transcriptMd = fs.readFileSync(t.file, "utf8");
  const chapters = t.meta.chapters.map((c) => `- ${formatTs(c.start_time)} ${c.title}`).join("\n");

  const scanInputs = { v: PIPELINE_VERSION, prompt: opts.prompt, scanModel: opts.scanModel ?? opts.model ?? null, checkModel: opts.checkModel ?? null, window: opts.windowSec, maxFrames: opts.maxFrames, maxSilent: opts.maxSilent, hires: opts.hiresHeight, sources: !opts.noSources };
  const scan = new StageCache(t.workDir, scanInputs, opts.fresh);
  const gen = new StageCache(t.workDir, { scan: scanInputs, model: opts.model ?? null, effort: opts.effort, name: opts.name ?? null, review: !opts.noReview }, opts.fresh);

  // The video and its scene changes are needed for frames; fetch them while Claude scans the transcript.
  const visualP =
    opts.maxFrames > 0
      ? downloadVideo(t.meta, t.workDir, opts.maxHeight).then(async (video) => ({ video, scenes: await detectScenes(video, t.workDir) }))
      : null;
  const sourcesP = opts.noSources ? Promise.resolve([] as SourceFile[]) : scan.stage("sources", () => pickSources({ t, opts }));

  let verified: Verified[] = [];
  let skippedWindows: string[] = [];
  if (visualP) {
    log(`Claude is scanning the transcript in ${Math.round(opts.windowSec / 60)}-minute windows`);
    const found = await scan.stage("moments", () => findMoments(t, opts, chapters), (r) => r.skipped.length === 0);
    skippedWindows = found.skipped;
    log(`Found ${found.moments.length} moments that refer to the screen`);
    const { video, scenes } = await visualP;
    const ctx: Ctx = { t, opts, video, scenes };
    complete();
    verified = await scan.stage("verified", () => captureVerified(ctx, found.moments), complete);
    if (opts.maxSilent > 0) {
      const covered = verified.flatMap((v) => [v.moment.time, v.moment.time + v.moment.span]);
      verified = [...verified, ...(await scan.stage("silent", () => discoverSilent(ctx, covered), complete))].sort((a, b) => a.moment.time - b.moment.time);
    }
    fs.writeFileSync(path.join(t.workDir, "moments.json"), JSON.stringify(verified.map((v) => ({ ...v.moment, kind: v.kind, status: v.status, frame: v.frame?.name ?? null, hires: v.hires, visible: v.visible })), null, 2));
  }
  const sources = await sourcesP;

  const confirmed = verified.filter((v): v is Verified & { frame: Frame } => v.status === "match" && !!v.frame);
  // Two moments can settle on the same shot; send each image once.
  const uniqueFrames = [...new Map(confirmed.map((v) => [v.frame.name, v.frame])).values()];
  const evidence = evidenceText(verified);
  const srcText = sourcesText(sources);
  const unverified = verified
    .filter((v) => v.status !== "match")
    .map((v) => `- ${formatTs(v.moment.time)}: expected ${v.moment.look_for ?? "(unspecified)"}${v.status === "illegible" ? " (on screen, but text too small to read even in high resolution)" : ""}${v.visible ? `; frames showed: ${v.visible}` : ""}`)
    .join("\n")
    .concat(skippedWindows.length ? `\n- Transcript windows ${skippedWindows.join(", ")} could not be scanned for on-screen references.` : "");

  // Step 4: write the skill.
  const draft = await gen.stage("draft", async () => {
    log(`Claude is writing the skill from ${uniqueFrames.length} verified frames${sources.length ? ` and ${sources.length} source files` : ""}`);
    const parts: Part[] = [
      {
        type: "text",
        text: generatePrompt({
          goal: opts.prompt,
          nameHint: opts.name ? slugify(opts.name) : undefined,
          meta: { title: t.meta.title, channel: t.meta.channel, url: t.meta.url, duration: formatTs(t.meta.duration), description: t.meta.description, chapters },
          transcript: transcriptMd,
          frameList: evidence,
          unverified,
          sources: srcText,
        }),
      },
      ...uniqueFrames.map((f): Part => ({ type: "image", path: f.file, label: `Frame assets/frames/${f.name}:` })),
    ];
    return askClaude({ system: GENERATE_SYSTEM, parts, effort: opts.effort, readDir: t.workDir, model: opts.model });
  });
  let files = parseFileBlocks(draft);

  // Step 5: fact-check the draft against the evidence, then fix what the reviewer flags.
  let issues: { file?: string; quote?: string; problem?: string; fix?: string }[] = [];
  if (!opts.noReview) {
    issues = await gen.stage("review", async () => {
      log("Claude is fact-checking the skill against the video");
      try {
        const res = await askClaudeJson<{ issues?: typeof issues }>({
          system: REVIEW_SYSTEM,
          parts: [{ type: "text", text: reviewPrompt({ skill: filesText(files), transcript: transcriptMd, evidence, sources: srcText }) }],
          effort: "high",
          readDir: t.workDir,
          model: opts.model,
        });
        return res.issues ?? [];
      } catch (err) {
        if (isFatal(err)) throw err;
        log(`Warning: review failed, keeping the draft: ${(err as Error).message}`);
        return [];
      }
    });
    if (issues.length) {
      const revised = await gen.stage("revised", async () => {
        log(`Fixing ${issues.length} issues found by the review`);
        return askClaude({
          system: GENERATE_SYSTEM,
          parts: [{ type: "text", text: revisePrompt({ skill: filesText(files), issues: JSON.stringify(issues, null, 2), evidence, sources: srcText, transcript: transcriptMd }) }],
          effort: opts.effort,
          readDir: t.workDir,
          model: opts.model,
        });
      });
      try {
        files = parseFileBlocks(revised);
      } catch {
        log("Warning: revision output could not be parsed, keeping the draft");
      }
    }
  }
  fs.writeFileSync(path.join(t.workDir, "last-generation.txt"), filesText(files));

  // Only frames the skill actually links are kept.
  const linked = uniqueFrames.filter((f) => files.some((file) => file.content.includes(`assets/frames/${f.name}`)));

  const result = writeSkill({
    outRoot: opts.out,
    files,
    frames: linked.map((f) => ({ src: f.file, dest: `assets/frames/${f.name}` })),
    nameOverride: opts.name,
    fallbackName: t.meta.title,
    force: opts.force,
    source: {
      generator: "yt2skill",
      generated_at: new Date().toISOString(),
      prompt: opts.prompt,
      model: opts.model ?? null,
      scan_model: opts.scanModel ?? opts.model ?? null,
      check_model: opts.checkModel ?? null,
      video: { id: t.meta.id, title: t.meta.title, channel: t.meta.channel, url: t.meta.url },
      transcript_source: t.source,
      source_files: sources.map((f) => ({ label: f.label, url: f.url })),
      review_issues: issues,
      moments: verified.map((v) => ({
        time: v.moment.time,
        span: v.moment.span,
        kind: v.kind,
        look_for: v.moment.look_for ?? null,
        status: v.status,
        hires: v.hires,
        frame: v.frame && v.status === "match" ? `assets/frames/${v.frame.name}` : null,
        linked: !!v.frame && linked.includes(v.frame),
        visible: v.visible || null,
      })),
    },
  });

  return {
    skill_dir: result.dir,
    skill_md: path.join(result.dir, "SKILL.md"),
    name: result.name,
    description: result.description,
    files: result.files,
    video: { id: t.meta.id, title: t.meta.title, url: t.meta.url },
    transcript_source: t.source,
    moments_found: verified.filter((v) => v.kind !== "silent").length,
    moments_verified: confirmed.filter((v) => v.kind !== "silent").length,
    scrolled_moments: verified.filter((v) => v.kind === "scrolled" && v.status === "match").length,
    silent_frames: verified.filter((v) => v.kind === "silent").length,
    hires_frames: verified.filter((v) => v.hires).length,
    frames_linked: linked.length,
    source_files: sources.length,
    review_issues: issues.length,
    windows_skipped: skippedWindows,
    cached_stages: [...scan.hits, ...gen.hits],
    billed_account: account,
    work_dir: t.workDir,
  };
}
