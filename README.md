# yt2skill

Turn a YouTube video into an [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills): a `SKILL.md` with instructions, reference files and the frames that actually matter. Runs on your Claude subscription through Claude Code (`claude -p`). No API key needed.

```
YouTube URL ─yt-dlp─▶ transcript (subtitles, else Whisper)  +  GitHub code linked in the description
                          │
                          ▼
   1. Claude scans the transcript in 3-minute windows (in parallel) and marks EVERY moment
      that refers to something on screen relevant to the goal ("span" for scrolling content)
                          │
                          ▼
   2. Shots at each moment and at the next scene change (ffmpeg scene detection)
   3. Claude verifies each shot:
        missing    → retry at nearby scene changes
        illegible  → re-download those seconds in 4K, add zoomed crops, read again
        scrolling  → frames across the whole span, stitched into one transcription
   4. Scene changes nobody talks about are checked for things shown without narration
                          │
                          ▼
   5. Claude writes the skill from verified evidence + source files
   6. A review pass fact-checks every claim and the skill is revised to fix what it flags
```

Every stage is cached per video and inputs (`~/.cache/yt2skill/<id>/runs/`), so a failed or repeated run resumes where it stopped. The transcript scan, writing and review use `--model` (the scan is where missing a moment costs the most). The high-volume checks (frame verification, stitching, silent visuals, source picking) run on `--check-model`, `sonnet` by default.

Frames are chosen from what is being said, not by scene detection, so the skill gets the details that only appear on screen (exact Dockerfiles, flags, button locations). Auto-captions often mangle technical terms, and the frames correct them.

## Install

Requirements: Node 20+, `yt-dlp`, `ffmpeg`, and [Claude Code](https://claude.com/claude-code) logged in with your subscription. Optional: `mlx-whisper` / `openai-whisper` / whisper.cpp for videos without subtitles.

```bash
brew install yt-dlp ffmpeg
npm install && npm link
yt2skill doctor
```

## Usage

```bash
yt2skill build "https://www.youtube.com/watch?v=Gjnup-PuquQ" \
  -p "Teach an agent to containerize an app with Docker" \
  -o ~/.claude/skills
```

```
~/.claude/skills/docker-containerize-basics/
├── SKILL.md
├── references/video-outline.md
├── assets/frames/0129.jpg   0136.jpg   0142.jpg   # only frames the skill links
└── source.json                                   # provenance: prompt, every moment + verification, source files, review issues
```

| Command | What it does |
|---|---|
| `build <url> -p "..."` | Full pipeline, writes the skill folder |
| `transcript <url>` | Metadata + timestamped transcript only (no Claude) |
| `frames <url> --at 1:23,95` | Frames at given timestamps (no Claude) |
| `doctor` | Checks dependencies |

Useful flags: `--model opus`, `--check-model sonnet|haiku`, `--scan-model`, `--window 180`, `--concurrency 4`, `--max-frames 80` (`0` = text-only), `--max-silent 24`, `--hires-height 2160`, `--no-sources`, `--no-review`, `--fresh`, `--effort xhigh`, `--lang ro`, `--name`, `--force`. See `yt2skill --help`.

`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the environment before `claude` is called, so runs always use your subscription. Claude runs with only the `Read` tool.

## For AI agents

Everything is non-interactive. `--json` prints exactly one JSON object to stdout, with logs on stderr and stable error codes. [AGENT_USAGE.md](AGENT_USAGE.md) is a ready-made skill that teaches an agent to use this CLI. Copy it to `~/.claude/skills/youtube-to-skill/SKILL.md`.

An agent that is itself Claude can skip the nested call: run `transcript`, decide the moments, run `frames --at ...`, then write the skill itself.

Downloads and transcripts are cached in `~/.cache/yt2skill/<video-id>/`.
