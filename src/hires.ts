import fs from "node:fs";
import path from "node:path";
import type { Frame } from "./frames.js";
import { formatTs, log, run } from "./util.js";

/**
 * Downloads only [from, to] of the video at high resolution and grabs frames at the given times.
 * Used when a frame shows the right thing but its text is too small to read at the normal resolution.
 */
export async function grabHires(url: string, workDir: string, times: number[], maxHeight: number): Promise<Frame[]> {
  const dir = path.join(workDir, "hires");
  fs.mkdirSync(dir, { recursive: true });
  const from = Math.max(0, Math.min(...times) - 1);
  const to = Math.max(...times) + 1;
  const tag = `${formatTs(from).replace(/:/g, "")}-${formatTs(to).replace(/:/g, "")}`;
  let clip = fs.readdirSync(dir).find((f) => f.startsWith(`clip-${tag}.`));
  if (!clip) {
    log(`Downloading ${Math.round(to - from)}s at up to ${maxHeight}p around ${formatTs(from)}`);
    await run("yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "-f",
      `bv*[height<=${maxHeight}]/bv*`,
      "--download-sections",
      `*${from}-${to}`,
      "--force-keyframes-at-cuts",
      "-o",
      path.join(dir, `clip-${tag}.%(ext)s`),
      url,
    ]);
    clip = fs.readdirSync(dir).find((f) => f.startsWith(`clip-${tag}.`));
    if (!clip) return [];
  }
  const frames: Frame[] = [];
  for (const t of times) {
    const name = `${formatTs(t).replace(/:/g, "")}-hd.jpg`;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, t - from)), "-i", path.join(dir, clip), "-frames:v", "1", "-q:v", "2", file]);
    }
    if (fs.existsSync(file)) frames.push({ time: t, name, file });
  }
  return frames;
}

/**
 * Four overlapping quadrant crops (60% of width and height each). Image inputs get downscaled,
 * so cropping is what actually makes small text readable.
 */
export async function quadrantCrops(frame: Frame): Promise<Frame[]> {
  const crops: Frame[] = [];
  const positions: [string, string, string][] = [
    ["tl", "0", "0"],
    ["tr", "iw*0.4", "0"],
    ["bl", "0", "ih*0.4"],
    ["br", "iw*0.4", "ih*0.4"],
  ];
  for (const [tag, x, y] of positions) {
    const file = frame.file.replace(/\.jpg$/, `-${tag}.jpg`);
    if (!fs.existsSync(file)) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-i", frame.file, "-vf", `crop=iw*0.6:ih*0.6:${x}:${y}`, "-q:v", "2", file]);
    }
    crops.push({ time: frame.time, name: path.basename(file), file });
  }
  return crops;
}
