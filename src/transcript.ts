import fs from "node:fs";
import path from "node:path";
import { CliError, formatTs, log, run, which } from "./util.js";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

function parseVttTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Parses WebVTT into segments. YouTube auto-captions repeat each line across
 * rolling cues, so lines identical to recently emitted ones are dropped.
 */
export function parseVtt(content: string): Segment[] {
  const segments: Segment[] = [];
  const recent: string[] = [];
  const blocks = content.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [a, b] = lines[idx].split("-->");
    const start = parseVttTime(a);
    const end = parseVttTime(b.trim().split(/\s+/)[0]);
    for (const raw of lines.slice(idx + 1)) {
      const text = raw
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || recent.includes(text)) continue;
      segments.push({ start, end, text });
      recent.push(text);
      if (recent.length > 3) recent.shift();
    }
  }
  return segments;
}

/** Groups segments into ~windowSec paragraphs prefixed with [mm:ss] timestamps. */
export function toMarkdown(segments: Segment[], windowSec = 30): string {
  const out: string[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  for (const s of segments) {
    if (buf.length && s.start - bufStart >= windowSec) {
      out.push(`[${formatTs(bufStart)}] ${buf.join(" ")}`);
      buf = [];
    }
    if (!buf.length) bufStart = s.start;
    buf.push(s.text);
  }
  if (buf.length) out.push(`[${formatTs(bufStart)}] ${buf.join(" ")}`);
  return out.join("\n\n");
}

export function textAround(segments: Segment[], t: number, radius = 12): string {
  return segments
    .filter((s) => s.end >= t - radius && s.start <= t + radius)
    .map((s) => s.text)
    .join(" ");
}

async function extractAudio(video: string, workDir: string): Promise<string> {
  const wav = path.join(workDir, "audio.wav");
  if (!fs.existsSync(wav)) {
    log("Extracting audio for Whisper");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav]);
  }
  return wav;
}

/** Transcribes with whichever Whisper CLI is installed: mlx_whisper, openai-whisper, or whisper.cpp. */
export async function whisperTranscribe(video: string, workDir: string, lang?: string): Promise<Segment[]> {
  const wav = await extractAudio(video, workDir);
  const outJson = path.join(workDir, "audio.json");
  const langArgs = (flag: string) => (lang ? [flag, lang] : []);

  if (await which("mlx_whisper")) {
    log("Transcribing with mlx_whisper");
    await run("mlx_whisper", [wav, "--output-format", "json", "--output-dir", workDir, ...langArgs("--language")]);
  } else if (await which("whisper")) {
    log("Transcribing with openai-whisper");
    await run("whisper", [wav, "--model", process.env.YT2SKILL_WHISPER_MODEL ?? "base", "--output_format", "json", "--output_dir", workDir, ...langArgs("--language")]);
  } else if ((await which("whisper-cli")) && process.env.WHISPER_CPP_MODEL) {
    log("Transcribing with whisper.cpp");
    await run("whisper-cli", ["-m", process.env.WHISPER_CPP_MODEL, "-f", wav, "-oj", "-of", path.join(workDir, "audio"), ...langArgs("-l")]);
    const data = JSON.parse(fs.readFileSync(outJson, "utf8"));
    return (data.transcription ?? []).map((t: any) => ({
      start: t.offsets.from / 1000,
      end: t.offsets.to / 1000,
      text: String(t.text).trim(),
    }));
  } else {
    throw new CliError(
      "no_transcript",
      "Video has no subtitles and no Whisper CLI was found",
      "Install one of: `pip install mlx-whisper` (Apple Silicon), `pip install openai-whisper`, or whisper.cpp (`brew install whisper-cpp` + WHISPER_CPP_MODEL=/path/to/ggml-model.bin).",
    );
  }
  const data = JSON.parse(fs.readFileSync(outJson, "utf8"));
  return (data.segments ?? []).map((s: any) => ({ start: s.start, end: s.end, text: String(s.text).trim() }));
}
