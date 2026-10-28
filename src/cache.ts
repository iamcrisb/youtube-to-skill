import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./util.js";

/**
 * Per-run stage cache: each expensive stage stores its result under runs/<key>/<stage>.json,
 * so a rerun with the same inputs resumes after the last completed stage.
 */
export class StageCache {
  readonly dir: string;
  readonly hits: string[] = [];

  constructor(workDir: string, inputs: object, private fresh: boolean) {
    const key = crypto.createHash("sha1").update(JSON.stringify(inputs)).digest("hex").slice(0, 12);
    this.dir = path.join(workDir, "runs", key);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "inputs.json"), JSON.stringify(inputs, null, 2));
  }

  /** `keep` decides whether a result is complete enough to cache (e.g. not when windows were skipped). */
  async stage<T>(name: string, fn: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
    const file = path.join(this.dir, `${name}.json`);
    if (!this.fresh && fs.existsSync(file)) {
      log(`Reusing cached stage: ${name}`);
      this.hits.push(name);
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    const value = await fn();
    if (keep(value)) fs.writeFileSync(file, JSON.stringify(value, null, 2));
    else log(`Not caching stage ${name}: it finished with errors, a rerun will redo it`);
    return value;
  }
}
