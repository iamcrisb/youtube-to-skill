import fs from "node:fs";
import path from "node:path";
import { log, run } from "./util.js";

export interface SourceFile {
  /** e.g. "owner/repo:src/index.ts" */
  label: string;
  url: string;
  size: number;
  /** Absolute path of the downloaded copy. */
  file: string;
}

type GithubLink =
  | { kind: "repo"; owner: string; repo: string; ref?: string; subdir?: string; url: string }
  | { kind: "blob"; owner: string; repo: string; ref: string; filePath: string; url: string }
  | { kind: "gist"; id: string; url: string };

// First path segments on github.com that are site pages, not users or orgs.
const RESERVED = new Set(["sponsors", "features", "orgs", "topics", "login", "signup", "marketplace", "settings", "about", "pricing", "explore", "collections", "trending", "apps", "enterprise", "readme", "site", "security", "customer-stories", "events", "team", "notifications", "new"]);
const TEXT_EXT = /\.(md|mdx|txt|py|ipynb|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|toml|ini|cfg|env\.example|sh|bash|zsh|ps1|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sql|html|css|scss|vue|svelte|astro|lua|r|dart|ex|exs|tf|gradle|xml|graphql|prisma|proto)$/i;
const TEXT_NAMES = /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|\.env\.example|\.gitignore|docker-compose\.ya?ml)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|vendor|\.next|__pycache__|\.venv|venv|target|coverage)(\/|$)/;
const MAX_FILE_BYTES = 200_000;
const MAX_TARBALL_BYTES = 50_000_000;
const MAX_REPOS = 3;

export function findGithubLinks(text: string): GithubLink[] {
  const links: GithubLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(gist\.)?github\.com\/[^\s)<>"']+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    let link: GithubLink | null = null;
    if (m[1]) {
      const id = parts[parts.length - 1];
      if (id && /^[0-9a-f]{8,}$/i.test(id)) link = { kind: "gist", id, url };
    } else if (parts.length >= 2 && !RESERVED.has(parts[0].toLowerCase())) {
      const [owner, repoRaw, type, ref, ...rest] = parts;
      const repo = repoRaw.replace(/\.git$/, "");
      if (type === "blob" && ref && rest.length) link = { kind: "blob", owner, repo, ref, filePath: rest.join("/"), url };
      else if (type === "tree" && ref) link = { kind: "repo", owner, repo, ref, subdir: rest.join("/") || undefined, url };
      else if (!type) link = { kind: "repo", owner, repo, url };
    }
    if (!link) continue;
    const key = JSON.stringify({ ...link, url: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

async function download(url: string, dest: string, maxBytes: number): Promise<boolean> {
  const res = await fetch(url, { headers: { "User-Agent": "yt2skill" }, redirect: "follow" });
  if (!res.ok || !res.body) return false;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) return false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) return false;
    chunks.push(chunk);
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
  return true;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const rel = path.relative(base, p);
    if (SKIP_DIRS.test(rel)) continue;
    if (entry.isDirectory()) out.push(...walk(p, base));
    else if (entry.isFile() && (TEXT_EXT.test(entry.name) || TEXT_NAMES.test(entry.name))) out.push(rel);
  }
  return out;
}

/**
 * Downloads GitHub repos, files and gists linked in the video description. Contents are only
 * read as text and handed to Claude as reference data; nothing downloaded is executed.
 */
export async function fetchDescriptionSources(description: string, workDir: string): Promise<SourceFile[]> {
  const links = findGithubLinks(description);
  if (!links.length) return [];
  const root = path.join(workDir, "sources");
  fs.mkdirSync(root, { recursive: true });
  const files: SourceFile[] = [];
  let repos = 0;

  for (const link of links) {
    try {
      if (link.kind === "repo") {
        if (repos >= MAX_REPOS) continue;
        repos++;
        const dir = path.join(root, `${link.owner}-${link.repo}-${(link.ref ?? "HEAD").replace(/[^\w.-]/g, "_")}`);
        if (!fs.existsSync(dir)) {
          log(`Fetching GitHub repo ${link.owner}/${link.repo}`);
          const tgz = `${dir}.tar.gz`;
          const ok = await download(`https://codeload.github.com/${link.owner}/${link.repo}/tar.gz/${link.ref ?? "HEAD"}`, tgz, MAX_TARBALL_BYTES);
          if (!ok) {
            log(`Warning: could not download ${link.url}`);
            continue;
          }
          fs.mkdirSync(dir, { recursive: true });
          await run("tar", ["-xzf", tgz, "-C", dir, "--strip-components", "1"]);
          fs.rmSync(tgz);
        }
        const base = link.subdir ? path.join(dir, link.subdir) : dir;
        if (!fs.existsSync(base)) continue;
        for (const rel of walk(base)) {
          const file = path.join(base, rel);
          const size = fs.statSync(file).size;
          if (size > MAX_FILE_BYTES || size === 0) continue;
          const repoPath = link.subdir ? `${link.subdir}/${rel}` : rel;
          files.push({ label: `${link.owner}/${link.repo}:${repoPath}`, url: link.url, size, file });
        }
      } else if (link.kind === "blob") {
        const file = path.join(root, `${link.owner}-${link.repo}-${link.filePath.replace(/\//g, "__")}`);
        if (!fs.existsSync(file)) {
          const ok = await download(`https://raw.githubusercontent.com/${link.owner}/${link.repo}/${link.ref}/${link.filePath}`, file, MAX_FILE_BYTES);
          if (!ok) continue;
        }
        files.push({ label: `${link.owner}/${link.repo}:${link.filePath}`, url: link.url, size: fs.statSync(file).size, file });
      } else {
        const dir = path.join(root, `gist-${link.id}`);
        if (!fs.existsSync(dir)) {
          const res = await fetch(`https://api.github.com/gists/${link.id}`, { headers: { "User-Agent": "yt2skill", Accept: "application/vnd.github+json" } });
          if (!res.ok) continue;
          const gist: any = await res.json();
          fs.mkdirSync(dir, { recursive: true });
          for (const [name, f] of Object.entries<any>(gist.files ?? {})) {
            if (typeof f.content === "string" && f.content.length <= MAX_FILE_BYTES) fs.writeFileSync(path.join(dir, path.basename(name)), f.content);
          }
        }
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          files.push({ label: `gist ${link.id}:${name}`, url: link.url, size: fs.statSync(file).size, file });
        }
      }
    } catch (err) {
      log(`Warning: could not fetch ${link.url}: ${(err as Error).message}`);
    }
  }
  if (files.length) log(`Fetched ${files.length} source files from ${links.length} GitHub links in the description`);
  return files;
}
