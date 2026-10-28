import fs from "node:fs";
import path from "node:path";
import { CliError, log, run } from "./util.js";

export interface VideoMeta {
  id: string;
  title: string;
  channel: string;
  url: string;
  duration: number;
  description: string;
  language: string | null;
  chapters: { start_time: number; end_time: number; title: string }[];
  subtitles: Record<string, unknown>;
  automatic_captions: Record<string, unknown>;
}

export async function fetchMeta(url: string, workRoot: string): Promise<{ meta: VideoMeta; workDir: string }> {
  log(`Fetching metadata for ${url}`);
  const res = await run("yt-dlp", ["-J", "--no-playlist", "--no-warnings", url]);
  let raw: any;
  try {
    raw = JSON.parse(res.stdout);
  } catch {
    throw new CliError("metadata_failed", "Could not parse yt-dlp metadata output");
  }
  const meta: VideoMeta = {
    id: raw.id,
    title: raw.title ?? raw.id,
    channel: raw.channel ?? raw.uploader ?? "",
    url: raw.webpage_url ?? url,
    duration: raw.duration ?? 0,
    description: raw.description ?? "",
    language: raw.language ?? null,
    chapters: raw.chapters ?? [],
    subtitles: raw.subtitles ?? {},
    automatic_captions: raw.automatic_captions ?? {},
  };
  const workDir = path.join(workRoot, meta.id);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "meta.json"), JSON.stringify({ ...meta, subtitles: Object.keys(meta.subtitles), automatic_captions: undefined }, null, 2));
  return { meta, workDir };
}

export async function downloadVideo(meta: VideoMeta, workDir: string, maxHeight: number): Promise<string> {
  const out = path.join(workDir, "video.mp4");
  if (fs.existsSync(out)) {
    log("Video already downloaded (cached)");
    return out;
  }
  log(`Downloading video (<= ${maxHeight}p)`);
  await run("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "-f",
    `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    "--merge-output-format",
    "mp4",
    "-o",
    path.join(workDir, "video.%(ext)s"),
    meta.url,
  ]);
  if (!fs.existsSync(out)) throw new CliError("download_failed", "yt-dlp finished but video.mp4 was not produced");
  return out;
}

/** Picks the best subtitle track: manual in the wanted language, then auto-captions, then any manual track. */
function pickSubtitleTrack(meta: VideoMeta, lang: string | undefined): { key: string; auto: boolean } | null {
  const want = lang ?? meta.language ?? "en";
  // YouTube reports regional codes ("en-US") while tracks are often keyed by base language ("en-orig").
  const wants = [...new Set([want, want.split("-")[0]])];
  const manual = Object.keys(meta.subtitles).filter((k) => k !== "live_chat");
  const auto = Object.keys(meta.automatic_captions);
  for (const w of wants) {
    const m = manual.find((k) => k === w || k.startsWith(`${w}-`));
    if (m) return { key: m, auto: false };
  }
  for (const w of wants) {
    const a = auto.find((k) => k === `${w}-orig`) ?? auto.find((k) => k === w);
    if (a) return { key: a, auto: true };
  }
  if (manual.length) return { key: manual[0], auto: false };
  return null;
}

export async function downloadSubtitles(meta: VideoMeta, workDir: string, lang?: string): Promise<{ file: string; lang: string; auto: boolean } | null> {
  const track = pickSubtitleTrack(meta, lang);
  if (!track) return null;
  const existing = fs.readdirSync(workDir).find((f) => f.startsWith("subs.") && f.endsWith(".vtt"));
  if (existing) return { file: path.join(workDir, existing), lang: track.key, auto: track.auto };
  log(`Downloading ${track.auto ? "auto-generated" : "manual"} subtitles (${track.key})`);
  await run("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    track.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    track.key,
    "--sub-format",
    "vtt",
    "-o",
    path.join(workDir, "subs.%(ext)s"),
    meta.url,
  ]);
  const file = fs.readdirSync(workDir).find((f) => f.startsWith("subs.") && f.endsWith(".vtt"));
  return file ? { file: path.join(workDir, file), lang: track.key, auto: track.auto } : null;
}
