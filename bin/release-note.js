#!/usr/bin/env node
// npm bin bridge: symlinks created by `npm install -g` / `npm link` point here, and the
// extensionless path keeps Node from treating this file as the TS entry. Node >= 24 (see
// engines) runs the TypeScript CLI directly.
import('../src/cli.ts').catch((err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
