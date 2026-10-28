import fs from "node:fs";
import path from "node:path";
import { log, run } from "./util.js";

/** Visual settles a moment after a cut; grab slightly after the change itself. */
const SETTLE_SEC = 1;

/** Scene-change timestamps for the whole video, cached in the work dir. Sampled at 5 fps / 320px for speed. */
export async function detectScenes(video: string, workDir: string, threshold = 0.3): Promise<number[]> {
  const cache = path.join(workDir, "scenes.json");
  if (fs.existsSync(cache)) {
    const c = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (c.threshold === threshold) return c.times;
  }
  log("Detecting scene changes");
  const res = await run("ffmpeg", ["-hide_banner", "-i", video, "-vf", `fps=5,scale=320:-2,select='gt(scene\\,${threshold})',showinfo`, "-f", "null", "-"]);
  const times = [...res.stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 10) / 10);
  fs.writeFileSync(cache, JSON.stringify({ threshold, times }));
  log(`Found ${times.length} scene changes`);
  return times;
}

/** First pass: the moment itself, plus the first cut after it (the visual often appears on that cut). */
export function firstShotTimes(t: number, scenes: number[]): number[] {
  const next = scenes.find((s) => s > t + 0.5 && s <= t + 15);
  return [t, next !== undefined ? next + SETTLE_SEC : t + 4];
}

/** Retry pass: other cuts near the moment, closest first; fixed offsets when the shot is static. */
export function retryShotTimes(t: number, scenes: number[], tried: number[]): number[] {
  const near = scenes
    .filter((s) => s >= t - 15 && s <= t + 20)
    .map((s) => s + SETTLE_SEC)
    .filter((s) => tried.every((x) => Math.abs(x - s) > 1.5))
    .sort((a, b) => Math.abs(a - t) - Math.abs(b - t))
    .slice(0, 3);
  return near.length ? near : [t - 3, t + 8, t + 12];
}

/**
 * Cuts far from any speech-derived moment: candidates for things shown but never mentioned.
 * At most one per bucket so fast-cut videos do not flood the check.
 */
export function silentCandidates(scenes: number[], momentTimes: number[], opts: { gap: number; bucket: number; max: number }): number[] {
  const out: number[] = [];
  let lastBucket = -1;
  for (const s of scenes) {
    if (momentTimes.some((m) => Math.abs(m - s) < opts.gap)) continue;
    const bucket = Math.floor(s / opts.bucket);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    out.push(s + SETTLE_SEC);
  }
  if (out.length <= opts.max) return out;
  const step = out.length / opts.max;
  return Array.from({ length: opts.max }, (_, i) => out[Math.floor(i * step)]);
}
