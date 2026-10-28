---
name: youtube-to-skill
description: Turn a YouTube tutorial into a reusable Agent Skill (SKILL.md, reference files and key video frames) with the yt2skill CLI. Use when the user shares a YouTube link and asks to "make a skill from this video", "learn this from YouTube", "turn this tutorial into instructions", or wants an agent to gain a capability shown in a video.
---

# youtube-to-skill

`yt2skill` gets a YouTube video's transcript and any GitHub code linked in its description. Claude scans the transcript window by window for every moment that refers to the screen, then grabs frames there and verifies them. Misses are retried at nearby scene changes, small text is re-read in 4K, and scrolling content is stitched together. It also checks scene changes nobody talks about. Finally it writes the skill from verified evidence and fact-checks it with a review pass. It runs on the user's Claude subscription through `claude -p`.

## Check readiness first

```bash
yt2skill doctor --json
```

Proceed only if `ok` is `true`. Otherwise tell the user which dependency is missing (yt-dlp, ffmpeg or Claude Code).

## Option A: one call

```bash
yt2skill build "<youtube-url>" --prompt "<what the skill should teach, in the user's words>" --out <skills-dir> --json
```

- Always pass `--json`. stdout then holds exactly one JSON object; progress logs go to stderr.
- Success: `{"ok": true, "skill_dir", "skill_md", "name", "description", "files", "moments_found", "moments_verified", "hires_frames", "scrolled_moments", "silent_frames", "source_files", "review_issues", "cached_stages", ...}`. Read `skill_md` and summarize it for the user.
- Failure: `{"ok": false, "error": {"code", "message", "hint"}}`, exit code 1 (runtime) or 2 (bad arguments). Act on `hint`.
- On `output_exists`, ask the user before re-running with `--force`.
- If a run fails midway, rerun the same command: completed stages are reused from cache (`cached_stages`). Pass `--fresh` only to redo everything.
- A run takes a few minutes for short videos and 10+ minutes for long talks. Run it in the background if your harness supports that.

## Option B: do the reasoning yourself (no nested Claude call)

1. `yt2skill transcript "<url>" --json`, then read `transcript.file`. Every line starts with a `[mm:ss]` timestamp.
2. Go through the transcript a few minutes at a time and note every moment where the speaker refers to something on screen that matters: code, commands, file contents, UI, posts, diagrams. Visuals usually appear 1 to 4 seconds after they are mentioned, so request two times per moment.
3. `yt2skill frames "<url>" --at 1:23,1:27,2:05,2:09 --json`, then view each `frames[].file`. If no shot shows what you expected, retry at other offsets (e.g. -3s, +8s, +12s). Do not guess details you could not see.
4. Write the SKILL.md yourself, copying the frames you link into `assets/frames/`.

## Error codes

| code | meaning |
|---|---|
| `missing_dependency` | yt-dlp / ffmpeg / claude not on PATH |
| `command_failed` | yt-dlp or ffmpeg failed; often an outdated yt-dlp (`brew upgrade yt-dlp`) |
| `no_transcript` | no subtitles and no Whisper installed |
| `usage_limit` | the user's Claude usage limit is reached; tell them when it resets (in `message`), then rerun the same command |
| `claude_auth` | Claude Code is not logged in; the user must run `claude` once and log in |
| `claude_failed` | `claude -p` failed for another reason |
| `bad_model_output` | Claude's response could not be parsed; retry once |
| `output_exists` | the skill folder already exists |
