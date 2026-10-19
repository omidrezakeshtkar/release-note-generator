# Release Note Generator

Turn a release's GitHub/GitLab issues into a polished, persona-grouped release note — with AI
doing the writing and you keeping the editorial control.

**https://github.com/omidrezakeshtkar/release-note-generator**

Select the issues of one release (paste refs, pick a label, or let the tool discover the current
`Release vX.Y` issue group automatically), let the [GLM Coding Plan](https://z.ai) API draft the
note in your format, preview it as rendered markdown, then copy it, download it, save it into your
repo, or wire the whole thing into CI so a tagged release produces its note by itself.

One self-contained tool, three surfaces:

| Surface | What it is for |
|---|---|
| **Web UI** (`release-note serve`) | Interactive drafting: releases, live streaming preview, editable markdown, hotfix toggles |
| **CLI** (`release-note generate …`) | Scriptable one-shot generation on your machine |
| **CI recipes** | GitHub Actions / GitLab CI jobs that use the repo's own token and read issues unattended |

No databases, no services, no build step — a Node server, a browser page, and a folder of
markdown notes.

---

## Contents

1. [Requirements](#requirements)
2. [Install & run](#install--run)
3. [The GLM key: Personal vs Standard (read this first)](#the-glm-key-personal-vs-standard-read-this-first)
4. [Configuration](#configuration)
5. [The web UI](#the-web-ui)
6. [The CLI](#the-cli)
7. [Issue selection & automatic versioning](#issue-selection--automatic-versioning)
8. [Providers: gh CLI vs repo tokens](#providers-gh-cli-vs-repo-tokens)
9. [GitHub Actions](#github-actions)
10. [GitLab CI](#gitlab-ci)
11. [Customizing the output format](#customizing-the-output-format)
12. [Where your data lives](#where-your-data-lives)
13. [Troubleshooting](#troubleshooting)
14. [Development](#development)

---

## Requirements

- **Node ≥ 24** — the server and CLI run TypeScript directly (`node src/cli.ts`), no build step.
- **A GLM key** — must be a **Personal (Coding Plan) key**, not a Standard API key; see
  [the next section](#the-glm-key-personal-vs-standard-read-this-first). Only generation uses
  it; fetch/check operations do not.
- **One issue source**, depending on how you run it:
  - locally: the [gh CLI](https://cli.github.com/) installed and authenticated (`gh auth login`);
  - GitHub Actions: nothing extra — the job's own `GITHUB_TOKEN`;
  - GitLab CI: a project access token with `read_api`.

## Install & run

```bash
git clone https://github.com/omidrezakeshtkar/release-note-generator.git
cd release-note-generator
npm install
npm start                  # web UI  → http://127.0.0.1:4310
npm run cli -- --help      # or the CLI directly: node src/cli.ts
```

After a global install the `release-note` command and its man page are on your PATH:

```bash
npm install -g .           # from this folder
release-note --help
man release-note           # the full manual (same as: release-note man)
```

First launch: open **⚙ Settings** in the web UI (or `release-note config set glmApiKey …`) and
paste your **Personal (Coding Plan) API key** — see the next section for why the key *type*
matters. It is stored in `config.local.json`, which is git-ignored and never committed.

## The GLM key: Personal vs Standard (read this first)

💡 **Tip:** Z.ai issues two different kinds of keys, and only one works here. **You must create a
Personal (Coding Plan) API key — a Standard API key will not work.**

| | Personal (Coding Plan) key ✅ | Standard API key ❌ |
|---|---|---|
| Where to create | **API Keys → Personal Coding Plan** (Team plans: *Team Coding Plan → My Plan*) | **API Keys → Standard** |
| Billing | Your Coding Plan subscription quota | Pay-as-you-go credit |
| Works with this tool | **Yes** | **No — generation fails with HTTP 429** |

A Standard API key never consumes Coding Plan quota, even when pointed at the Coding Plan
endpoint (`…/api/coding/paas/v4`). So if generation fails with `HTTP 429` or a "no resource
package" message, you are almost certainly holding a Standard key — go create a **Personal
Coding Plan key** and paste that instead. Either key can be verified in one second:

```bash
release-note test-key
```

The Settings dialog shows the same tip next to the key field.

## Configuration

Settings live in `config.local.json` next to the source, with environment-variable overrides for
CI. Resolution order per field: **environment variable → config file → built-in default**.

| Field | Env override | Default | Purpose |
|---|---|---|---|
| `glmApiKey` | `RELEASE_NOTE_GLM_API_KEY` | — | GLM Coding Plan key |
| `glmBaseUrl` | `RELEASE_NOTE_GLM_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` | OpenAI-compatible endpoint |
| `glmModel` | `RELEASE_NOTE_GLM_MODEL` | `glm-5.3-flash` | Any model your plan covers |
| `defaultRepo` | `RELEASE_NOTE_DEFAULT_REPO` | — | `owner/name` used when none is given |
| `productName` | `RELEASE_NOTE_PRODUCT_NAME` | — | Product name in the note header (empty → generic wording) |
| `outputDir` | `RELEASE_NOTE_OUTPUT_DIR` | `releases/` | Where notes are saved (relative → the tool folder) |

Manage without editing JSON: `release-note config list|get|set|path`.

```bash
release-note config set glmApiKey zpka_…
release-note config set productName "My Product"
release-note config set outputDir ../my-repo/release-notes
release-note config set glmApiKey ""     # clear a field → default applies
```

Other environment variables: `RELEASE_NOTE_PROVIDER` (force `gh-cli` / `github-api` /
`gitlab-api`) and `RELEASE_NOTE_PORT` (web UI port, default 4310).

## The web UI

```bash
release-note serve [--port 5000]
```

The server binds `127.0.0.1` only and has no auth by design — it is a personal, local tool; never
expose it to a network.

1. **Releases** — *New* creates one (version + date, with semver suggestion chips computed from
   your previous notes); the dropdown switches; *Delete* removes. A refresh never loses anything.
2. **Repository** — enter `owner/name`, press **Check access** to verify the gh account can read it.
3. **Issues** — paste links or `#123` numbers and press **Fetch issues** (a server-side job, so
   refreshing is safe). Release **PRs** are special: their referenced issues — including the
   "Issues for this release" bot comment — expand into the list automatically. Each row shows
   title, labels, and a **hotfix** toggle.
4. **Context files** — optionally attach local files (previous notes, style guides) as extra context.
5. **Generate** — the note streams in live with a rendered markdown preview (`marked` + DOMPurify)
   and a live stage line (prompt built → waiting for first tokens → writing, with character
   counts). Stop keeps the partial note. Switch to the **Markdown** tab to edit by hand.
6. **Save to releases/** — writes `release-note-v<version>-<date>.md` into the configured
   output folder; existing files are never overwritten.

If the server restarts mid-job, the release is marked `stopped` at next boot — content kept,
never a silent "generating" forever.

## The CLI

`release-note <command> —help` (or `release-note help <command>`) prints full help for every
command below; `man release-note` holds the complete manual.

| Command | Purpose |
|---|---|
| `generate` | Select issues → fetch → generate the note (stdout by default, `--out file` to write) |
| `serve` | Start the web UI |
| `config` | `list` / `get` / `set` / `path` for the stored settings |
| `check` | Verify provider auth and repo access before running anything |
| `test-key` | Verify the GLM key with an 8-token request |
| `man` | Show the manual page |

Exit codes: `0` success · `1` runtime failure (including partially failed fetches — the note may
still exist) · `2` usage error. Progress goes to **stderr**, the note itself to **stdout**, so
piping works: `release-note generate … | less`.

```bash
# The whole current release — issues AND version come from the "Release v1.19" labels:
release-note generate --repo owner/repo --release-label-prefix

# Explicit issues + a release PR (its referenced issues are pulled in) + hotfix + version bump:
release-note generate --repo owner/repo --issue "#101 #102" --release-pr 312 \
    --hotfix 101 --bump minor --out releases/release-note-v1.20.md

# One exact label, note straight into a file:
release-note generate --repo owner/repo --label "Release v1.19" --out note.md
```

Useful `generate` flags: `--date YYYY-MM-DD`, `--instructions "…"`,
`--instructions-file`, `--context-file` (repeatable), `--hotfix-label hotfix`,
`--product "My Product"`, `--provider`, `--api-key/--base-url/--model`, `--force` (overwrite
`--out`), `--quiet`.

## Issue selection & automatic versioning

All selection sources combine; every source feeds the same fetcher (dedup included, 300-issue
cap, per-issue bodies clipped so huge releases fit the model context):

- **Refs** — `#123`, `123`, full URLs, `@file` (one per line), `-` (stdin).
- **Release PRs** (`--release-pr 312`) — every issue referenced in the PR body *or its comments*
  is fetched. If your release bot posts an "Issues for this release" comment, pasting the release
  PR alone pulls in the entire release.
- **Exact labels** (`--label "Release v1.19"`, repeatable, union).
- **Release-label discovery** (`--release-label-prefix`, default prefix `Release v`) — every
  issue/PR whose labels start with the prefix is grouped by the version inside the label
  (`Release v1.19` → `1.19`); the **newest** group is selected.

**Version resolution order:** explicit `--version` → the highest release label found on the
selected issues → `--bump patch|minor|major` from `--from` (or the newest saved
`release-note-v*.md` in the output folder) → otherwise an error listing your options.

So the CI flow needs zero inputs: tag the release's issues `Release v1.19`, run the job, and the
note is written for version 1.19 — the label is both the issue filter and the version.

Semver display follows the common reading: `major` → `2.0`, `minor` → `1.19`, `patch` → `1.18.1`.

## Providers: gh CLI vs repo tokens

One interface, three backends — chosen by `--provider`, the `RELEASE_NOTE_PROVIDER` env var, or
auto-detection:

| Provider | Auth | Typical place |
|---|---|---|
| `gh-cli` *(default)* | Your `gh auth login` | Local terminals, the web UI |
| `github-api` | `GH_TOKEN` / `GITHUB_TOKEN` | GitHub Actions (`GITHUB_ACTIONS=true` → auto) |
| `gitlab-api` | `GITLAB_TOKEN` | GitLab CI (`GITLAB_CI=true` → auto) |

The web UI always uses the gh CLI (it is local and interactive). A stray token on a laptop never
silently flips the backend — auto-detection only reacts inside real CI environments. Endpoints:
`GITHUB_API_URL` (GitHub Enterprise) and `GITLAB_API_URL` / `GITLAB_HOST` / `CI_SERVER_HOST`
(self-hosted GitLab) are respected.

Check everything before a CI run with:

```bash
release-note check --provider github-api --repo owner/repo
```

## GitHub Actions

Copy [`examples/github-actions-release-note.yml`](examples/github-actions-release-note.yml) into
your product repo as `.github/workflows/release-note.yml`. The essentials:

```yaml
permissions:
  issues: read
  pull-requests: read
  contents: write            # only if you publish a Release from the job

steps:
  - uses: actions/setup-node@v4
    with: { node-version: 24 }
  - run: npm install -g git+https://github.com/your-org/release-note-generator.git
  - env:
      GH_TOKEN: ${{ github.token }}          # the repo's own key — no personal token
      # RELEASE_NOTE_GLM_API_KEY: ${{ secrets.GLM_API_KEY }}
    run: release-note generate --provider github-api --repo "$GITHUB_REPOSITORY" \
           --release-label-prefix --out release-notes/release-note.md --force
```

The default `GITHUB_TOKEN` needs no secrets setup — `issues: read` is enough for generation.
The example workflow runs on `workflow_dispatch` and a monthly schedule, uploads the note as an
artifact, and optionally drafts a GitHub Release with it.

## GitLab CI

Copy the `release_note` job from
[`examples/gitlab-ci-release-note.yml`](examples/gitlab-ci-release-note.yml) into your
`.gitlab-ci.yml`. One-time setup on the product repo:

1. **Settings → Access tokens → Project access token**: role *Reporter* (or higher), scope
   `read_api`.
2. Store it as a masked CI/CD variable `RELEASE_NOTE_TOKEN`.

```yaml
release_note:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "web"       # manual run; add "schedule" as needed
  variables:
    GITLAB_TOKEN: $RELEASE_NOTE_TOKEN        # the repo's own key
  script:
    - npm install -g git+https://git.example.com/your-org/release-note-generator.git
    - release-note generate --provider gitlab-api --release-label-prefix --out release-note.md
  artifacts:
    paths: [release-note.md]
```

The repo is taken from `CI_PROJECT_PATH` automatically. Note: GitLab's ephemeral `CI_JOB_TOKEN`
cannot read the issues API — the project token above is required. A GitLab token on a GitHub
repo (or vice versa) fails fast with a clear message.

## Customizing the output format

The generated note's structure, headings, and tone are pinned by
[`samples/format-example.md`](samples/format-example.md) — the prompt includes it verbatim and
tells the model to imitate it exactly. To adopt the tool for another product:

1. Replace `samples/format-example.md` with one of your real past release notes.
2. Optionally set `productName` (Settings, `config set`, or env) — it names the product in the
   prompt header and keeps role-group wording aligned with your personas.

Built-in output rules: first line `🚀   Release Notes – Version <X.Y>`, then `Release Date:`,
then — when present — `🔥 Hotfixes` first, `✨ New Features & Improvements` grouped by
persona/role, `🐞 Bug Fixes`, `♻️ Improvement`. User-facing English only: no issue numbers, no
branches, no dev jargon. Bugs and stale drafts are fixed by improving the example or the
instructions — never by weakening those rules.

## Where your data lives

| Path | What | Committed? |
|---|---|---|
| `config.local.json` | GLM key, defaults, product name, output dir | **No** (git-ignored) |
| `data/releases/*.json` | Web-UI release store (issues, notes, stats) | **No** (git-ignored) |
| `releases/` (or `outputDir`) | Saved notes — plain markdown, append-only | Your choice |

Security posture: the web server binds `127.0.0.1` with no auth; the GLM key never leaves your
machine except to the configured endpoint; CI tokens arrive via environment variables and are
never written to disk by the tool.

## Troubleshooting

- **HTTP 429 with an active plan?** See [The GLM key: Personal vs Standard](#the-glm-key-personal-vs-standard-read-this-first)
  — a **Standard API key** never consumes Coding Plan quota, even on the coding endpoint. Create
  a **Personal (Coding Plan) key** and use that one; `release-note test-key` tells you exactly
  this on failure.
- **`gh: not authenticated`** in the web UI → `gh auth login`. The UI never uses tokens; that is
  what the CLI/CI providers are for.
- **"No GitHub token" / "No GitLab token"** → set `GH_TOKEN` / `GITLAB_TOKEN`; see the provider
  table. On GitLab, `CI_JOB_TOKEN` is not enough — use a project access token with `read_api`.
- **A release PR was fetched but nothing expanded** → the referenced-issue scan reads the PR body
  and its comments (`#123` and full issue URLs). If your bot's comment is on a different issue,
  paste that one too.
- **Wrong version picked** → version resolution is explicit `--version` > highest
  `Release vX.Y` label > `--bump`. Remove stale labels from older issues or pass `--version`.
- **Generation stopped mid-stream?** The partial note is kept (both UI and CLI), and you can
  re-run or edit by hand.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit — the only static check
npm start             # web UI on 127.0.0.1:4310 (RELEASE_NOTE_PORT to change)
npm run cli -- …      # run the CLI from source
npm run man           # render the man page
```

Runtime layout: `src/server.ts` (HTTP API + static UI), `src/cli.ts` (commands), `src/pipeline.ts`
(selection → fetch → generate), `src/providers` (`provider.ts` + `provider-github.ts` +
`provider-gitlab.ts` + the gh-CLI wrapper `gh.ts`), `src/glm.ts` (streaming GLM client),
`src/prompt.ts` (system/user prompt), `src/store.ts` + `src/jobs.ts` (web-UI persistence and
background jobs), `public/` (no-build vanilla front end). Engineering rules and invariants:
[AGENT.md](AGENT.md). No test suite — the verification ladder is `typecheck`, targeted `curl`
probes against `127.0.0.1:4310`, CLI smoke runs, and a browser pass for UI changes.
