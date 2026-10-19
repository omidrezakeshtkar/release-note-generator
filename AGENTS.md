# AGENTS.md — release-note-generator

Rules for AI agents working in this repository. It overrides nothing globally; it is this repo's
specific layer.

## Repository

- GitHub: https://github.com/omidrezakeshtkar/release-note-generator
- **The primary and only long-lived branch is `master`.** New work happens either directly on
  `master` (small changes) or on short-lived feature branches merged back into `master`.
  Never introduce `main` as a parallel default.

## Git identity (local to this repo)

All commits in this repository use exactly this identity — do not fall back to any global git
config, and do not use another name/email:

```bash
git config user.name  "Omid Reza Keshtkar"
git config user.email "omidrezakeshtkar@outlook.com"
```

These are already written into `.git/config` locally. If a commit ever lands with a different
identity, stop and fix before pushing.

## Commit rules

- Never commit or push without the user's explicit approval (global safety rule; see
  `~/.zcode/AGENTS.md` → Git Safety).
- Commit message style: Conventional Commits, short and focused — `feat: …`, `fix: …`,
  `chore: …`, `docs: …`. No long explanations in the subject; optional body only when the
  "why" is not obvious from the diff.
- Version bumps: meaningful releases get a package.json version bump (`0.1.0` is the first
  release); small isolated fixes ride on commits. Never bump versions automatically.

## Never commit

- `config.local.json` (GLM key, personal defaults) — git-ignored.
- `data/` (web-UI release store; user data) — git-ignored.
- `node_modules/` — git-ignored.
- Any secret arriving via environment (`GH_TOKEN`, `GITLAB_TOKEN`,
  `RELEASE_NOTE_GLM_API_KEY`) — these must never be echoed into files, logs, or examples'
  real values.

## Verification before handing back

1. `npm run typecheck` — must pass.
2. `node --check public/app.js` after any `public/app.js` edit.
3. CLI smoke: `node src/cli.ts --help` and one usage-error exit code (expect 2).
4. For server/UI changes: boot `npm start` (port `RELEASE_NOTE_PORT`, default 4310, binds
   127.0.0.1 only) and probe the changed route.
5. Keep `config.local.json`, `data/releases/*` and any user data out of every verification
   artifact you paste or attach.
