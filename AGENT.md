# release-note — agent instructions

Standalone tool: turns a release's GitHub/GitLab issues into a persona-grouped release note via
the GLM Coding Plan API. Three surfaces share one core: the local web UI, the CLI
(`release-note`), and CI runs (GitHub Actions / GitLab CI) driven by the repo's own token.

---

## Tech Stack

Node ≥ 24 native TypeScript (type stripping — **erasable syntax only**, no enums/namespaces, and
**explicit `.ts` extensions on every relative import**) · zero server runtime dependencies ·
`marked` + `dompurify` served from `node_modules` to the browser · vanilla-JS front end · **npm**.

---

## Directory Structure

```
bin/release-note.js     npm bin bridge (symlink → src/cli.ts)
src/cli.ts              CLI commands, help texts, exit codes (0 ok / 1 failure / 2 usage)
src/args.ts             zero-dependency argument parser (UsageError → exit 2)
src/pipeline.ts         headless flow: selection → fetch → version resolution → generate
src/provider.ts         provider interface, gh-cli wiring, CI auto-detection, factory
src/provider-github.ts  GitHub REST v3 (GH_TOKEN / GITHUB_TOKEN, GITHUB_API_URL)
src/provider-gitlab.ts  GitLab REST v4 (GITLAB_TOKEN, CI_PROJECT_PATH, GITLAB_API_URL)
src/gh.ts               gh CLI wrapper (spawn, 30s timeout): auth, repo/issue/pr view, list
src/rest.ts             shared fetch plumbing for the REST providers (RestError, pagination)
src/issues.ts           input parsing (URL/#N, GitHub+GitLab), dedupe, concurrency-5 resolution
src/version.ts          pure semver helpers: label→version, bumps, newest-note scan
src/glm.ts              OpenAI-compatible SSE chat-completions client (stream: true)
src/prompt.ts           system + user prompt; clips bodies (8k) and comments (5 × 3k)
src/config.ts           config.local.json + env overrides + CONFIG_DEFAULTS
src/store.ts            web-UI release persistence: data/releases/<id>.json, atomic writes
src/jobs.ts             web-UI background jobs (fetch / generate) — server-owned
src/server.ts           HTTP server: routes, NDJSON streaming relay, /api/save
public/                 index.html + styles.css + app.js (single page, no build step)
samples/format-example.md   the release-note output contract — format + tone exemplar
docs/release-note.1     man page (npm "man" field + `release-note man`)
examples/               GitHub Actions workflow + GitLab CI job for consumer repos
data/                   git-ignored web-UI store — user data, never commit
config.local.json       git-ignored: GLM key, defaults, product name, output dir
```

---

## Development Commands

```bash
npm install
npm start               # web UI → http://127.0.0.1:4310   (RELEASE_NOTE_PORT=… to change)
npm run cli -- --help   # CLI from source
npm run typecheck       # tsc --noEmit — the only static check
node --check public/app.js   # frontend syntax gate after any app.js edit
```

There is no test suite. The verification ladder: `typecheck` → `node --check public/app.js` (for
UI edits) → CLI smoke (`--help`, `config list`, usage-error exit codes) → targeted live probes
with `curl` against `127.0.0.1:4310` → a browser pass for UI changes. REST providers get probed
with a real token when available; otherwise their live paths are reported as unverified.

---

## Invariants

- **Local-only web UI.** The server binds `127.0.0.1` and has no auth by design. Never expose it
  to the network, and never persist the API key anywhere but `config.local.json` (git-ignored).
- **Provider split.** The web UI always uses the gh CLI. Headless runs (CLI/CI) may use the
  token-based REST providers (`github-api`, `gitlab-api`). Tokens come from environment variables
  only (`GH_TOKEN`, `GITLAB_TOKEN`, …) — never from config files, code, or CI script echoes.
  Auto-detection reacts to real CI envs only (`GITHUB_ACTIONS`+token, `GITLAB_CI`+token); a stray
  local token never flips the default away from gh-cli.
- **Empty settings mean "use the default"; env beats file.** `effectiveConfig()` resolves
  env var → stored config → `CONFIG_DEFAULTS` (CI never needs a local config; `--api-key`-style
  overrides write to the env). Touching config means keeping
  `CONFIG_DEFAULTS`, `CONFIG_ENV_VARS`, `IAppConfig`, the `/api/config` POST key list, and the
  UI placeholders in sync.
- **`samples/format-example.md` is the output contract.** The note format (role-grouped features,
  🐞 Bug Fixes, ♻️ Improvement, 🔥 Hotfixes first) changes there first, then in `src/prompt.ts`.
  Never weaken the "no issue numbers / no dev jargon" prompt rules to make a bad draft pass.
  The product name is config (`productName`), never hardcoded — the tool is product-agnostic.
- **Version resolution is explicit > label > bump.** `--version` wins; then the highest
  `<prefix><semver>` label on the selected issues (prefix defaults to `Release v`); then
  `--bump` from `--from` or the newest note file in the output dir. Keep this order intact.
- **CLI output contract.** The note goes to stdout, progress to stderr, so piping works.
  `--out file` never overwrites without `--force`. Partial fetch failures exit 1 *after*
  writing the note, listing what failed.
- **`/api/generate` NDJSON contract:** lines `{"type":"delta","text"}` · `{"type":"error","message"}`
  · `{"type":"done","characters"}`. The client loop must recompute the newline index after every
  slice and must surface a stream that ends without `done` — don't reintroduce a silent hang.
- **`/api/save` is append-only:** writes only into the resolved output dir (the `outputDir`
  setting, relative → tool folder; default `releases/`), sanitizes the filename, refuses
  overwrite. Saved notes are records — never edit or delete existing ones.
- **Jobs are server-owned.** Fetch and generate run in `src/jobs.ts`, not in the request — the
  browser may refresh or disconnect freely; the client only polls `GET /api/releases/:id`.
  Persist every wave/throttle during streaming; a job's final save must be skipped if the release
  was deleted meanwhile (`releaseExists` guard). One job per release (409 on overlap); editing via
  PATCH is refused while a job runs.
- **`data/releases/` is user data** — never commit it, never delete a release outside an explicit
  user request. On boot, releases stuck in `fetching`/`generating` are marked `stopped` (content
  kept), never silently resumed or dropped.
- Streamed generation is stoppable; a stopped run keeps the partial note.
