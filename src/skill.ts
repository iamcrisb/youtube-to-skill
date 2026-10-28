import fs from "node:fs";
import path from "node:path";
import { CliError, slugify } from "./util.js";

export interface SkillFile {
  path: string;
  content: string;
}

export function parseFileBlocks(text: string): SkillFile[] {
  const files: SkillFile[] = [];
  const re = /<file path="([^"]+)">\n?([\s\S]*?)\n?<\/file>/g;
  for (const m of text.matchAll(re)) {
    const p = path.posix.normalize(m[1].trim());
    if (p.startsWith("..") || path.isAbsolute(p)) continue;
    if (!(p === "SKILL.md" || /^references\/[\w.-]+\.md$/.test(p) || /^scripts\/[\w.-]+$/.test(p))) continue;
    files.push({ path: p, content: m[2].trimEnd() + "\n" });
  }
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new CliError("bad_model_output", "Model output did not contain a SKILL.md file block");
  }
  return files;
}

export function readFrontmatter(skillMd: string): { name?: string; description?: string } {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const get = (k: string) => {
    const line = m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: get("name"), description: get("description") };
}

/** Parses the JSON object in a model reply, tolerating code fences and stray prose around it. */
export function extractJson<T>(text: string): T {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const last = text.lastIndexOf("}");
  for (let i = text.indexOf("{"); i !== -1 && i < last; i = text.indexOf("{", i + 1)) candidates.push(text.slice(i, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {}
  }
  throw new CliError("bad_model_output", "Model returned invalid JSON");
}

export function writeSkill(args: {
  outRoot: string;
  files: SkillFile[];
  frames: { src: string; dest: string }[];
  nameOverride?: string;
  fallbackName: string;
  source: object;
  force: boolean;
}): { dir: string; name: string; description: string; files: string[] } {
  const skillMd = args.files.find((f) => f.path === "SKILL.md")!;
  const fm = readFrontmatter(skillMd.content);
  const name = slugify(args.nameOverride ?? fm.name ?? args.fallbackName) || "youtube-skill";
  const dir = path.resolve(args.outRoot, name);
  if (fs.existsSync(dir)) {
    if (!args.force) throw new CliError("output_exists", `Skill directory already exists: ${dir}`, "Pass --force to overwrite, or --name to pick another name.");
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Keep the frontmatter name in sync with the folder name agents will load.
  skillMd.content = skillMd.content.replace(/^(---\n[\s\S]*?^name:).*$/m, `$1 ${name}`);
  const written: string[] = [];
  for (const f of args.files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, { mode: f.path.startsWith("scripts/") ? 0o755 : 0o644 });
    written.push(f.path);
  }
  for (const fr of args.frames) {
    const p = path.join(dir, fr.dest);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(fr.src, p);
    written.push(fr.dest);
  }
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(args.source, null, 2) + "\n");
  written.push("source.json");
  return { dir, name, description: fm.description ?? "", files: written };
}
