import fs from "node:fs";
import path from "node:path";
import { formatTs, run } from "./util.js";

export interface Frame {
  time: number;
  name: string;
  file: string;
}

/**
 * Grabs one frame per timestamp. Names come from the timestamp only (0123.jpg),
 * so a name never claims content the frame may not show.
 */
export async function extractFramesAt(
  video: string,
  workDir: string,
  times: number[],
  duration: number,
  width = 1280,
): Promise<Frame[]> {
  const dir = path.join(workDir, "frames");
  fs.mkdirSync(dir, { recursive: true });
  const frames: Frame[] = [];
  const seen = new Set<string>();
  for (const t of times) {
    const time = Math.max(0, Math.min(t, duration > 1 ? duration - 0.5 : t));
    const name = `${formatTs(time).replace(/:/g, "")}.jpg`;
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(time), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", file]);
    }
    if (fs.existsSync(file)) frames.push({ time, name, file });
  }
  return frames;
}

/** Accepts seconds ("83", "83.5") or clock timestamps ("1:23", "01:02:03"). */
export function parseTimestamp(s: string): number {
  const parts = s.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
