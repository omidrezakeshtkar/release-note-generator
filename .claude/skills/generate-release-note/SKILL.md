---
name: generate-release-note
description: Run the release-note-generator tool to turn a release's GitHub/GitLab issues into a polished release note (persona-grouped features, bug fixes, improvements, hotfixes first) and save it into the configured output folder. Invoke whenever asked to draft, generate, write, or save a release note for a release or version.
---

# Generate a release note with the release-note-generator tool

## Purpose

Produce a polished, user-facing release note in the established format — without hand-writing
it. The tool reads the release's issues (gh CLI locally, or a repo token in CI), drafts the note
with the GLM Coding Plan API, and streams it back as markdown. The format contract lives in
[samples/format-example.md](../../../samples/format-example.md); the tool's rules in
[../../AGENT.md](../../AGENT.md).

## When to use

- "Generate / draft / write the release note for version X" (with a release PR, issue list, label, or repo).
- "Update the release note and save it to the output folder."

## Preconditions

1. An issue source: `gh` installed and authenticated (`gh auth status`), or `GH_TOKEN` /
   `GITLAB_TOKEN` in the environment for the REST providers.
2. GLM API key configured: `config.local.json` (via the UI's ⚙ Settings) or the
   `RELEASE_NOTE_GLM_API_KEY` environment variable. It must be a **Personal (Coding Plan) key** —
   a Standard API key fails with HTTP 429.
3. Tool dependencies installed (`npm install`).

## Procedure

### 1 — Start the tool if it is not running

Probe, then start only if needed:

```bash
curl -sf http://127.0.0.1:4310/api/gh/status   # running?
# not running:
npm start                                      # leave it running in the background
```

### 2 — Select the issues

Three ways, all covered by the CLI (simplest for headless runs):

```bash
# Auto-discovery: every issue labeled like "Release v1.19", version from the label:
node src/cli.ts generate --repo owner/name --release-label-prefix --out /tmp/note.md

# One exact label:
node src/cli.ts generate --repo owner/name --label "Release v1.19" --out /tmp/note.md

# Explicit refs; a release PR's referenced issues expand automatically:
node src/cli.ts generate --repo owner/name --issue "#3492" --release-pr 3492 --out /tmp/note.md
```

### 3 — Mark the hotfixes

Hotfixes come from the release-gate context (run report, user instruction, `hotfix` labels):
`--hotfix 3487,3501` for explicit numbers, `--hotfix-label hotfix` for label-based marking.
Every hotfix lands in the note's `🔥 Hotfixes` section.

### 4 — Generate

The CLI writes the note to `--out` (or stdout) with progress on stderr:

```bash
node src/cli.ts generate --repo owner/name --release-label-prefix \
  --hotfix 3487 --instructions "emphasize the hotfix" --out /tmp/note.md
```

Exit 0 = note written; exit 1 = generation or (partial) fetch failure — the message on stderr
says which (401 → key problem in Settings). For interactive review, drive the web UI instead:
Releases → issues → Generate, then the Preview/Markdown tabs.

`--context-file` (repeatable) accepts previous notes or style guides for phrasing.

### 5 — Review and save

Show the user the draft before it ships. Saving from the UI's **Save to releases/** dialog is
append-only (`release-note-v<version>-<yyyymmdd>.md`, existing files are never overwritten).
From the CLI, write into the target folder yourself:

```bash
cp /tmp/note.md releases/release-note-v1.19-$(date +%Y%m%d).md   # check the name first
```

Never delete or edit an already-saved note — the folder is a record.

## Notes

- Issue bodies are clipped to 8k chars and comments to 5 × 3k per issue — a 90-issue release fits.
- Generation can be stopped; the partial note is kept and clearly marked in the UI.
- The API key never leaves the machine (local server, `config.local.json`; CI: env vars only).
