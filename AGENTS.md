# AGENTS

- Build/test: `bun test`; single file `bun test <path>`; single test `bun test -t "name"`; coverage `bun test --coverage`.
- Lint/format: `bun run lint`, `bun run lint:fix`, `bun run format`, `bun run format:check`.
- Maintenance: `bun run outdated` (deps), `bun run unused` (unused code/deps).
- Runtime: Bun only; use `Bun.serve()`, `Bun.file`, `bun:sqlite`, `Bun.redis`, `Bun.sql`.
- Env: Bun auto-loads `.env`; do not add `dotenv`.
- Project: ESM (`type: module`), TS 5; no emit; tests under `src/**/__test__`.
- TypeScript: `strict` on; bundler resolution; path alias `@/*`; `noImplicitAny` enforced.
- Preferences: type aliases over interfaces; arrow functions; async/await over raw Promises.
- Imports: sort third-party, blank, `@` imports, blank, relative (via Prettier plugin).
- Formatting (Prettier): single quotes; semicolons; 2 spaces; width 80; no trailing commas; `arrowParens: "avoid"`; EOL `lf`.
- ESLint: enforce type aliases; prefer arrows/const; forbid `var`; allow TS path resolver.
- Naming: camelCase (vars/functions), PascalCase (classes/types), SCREAMING_SNAKE_CASE (constants).
- Errors/events: wrap async ops in try/catch; use `src/helpers/log.ts`; events via `mitt`.
- Caching: LRU cache; background refresh; invalidate by key/prefix.
- Servers: prefer `Bun.serve()`; do not add Express.
- FS/IO: prefer `Bun.file`; avoid `node:fs` read/write when possible.
- Cursor rules: follow `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`.
- Cursor summary: use Bun for run/test/build/install; use Bun DB/IO APIs; avoid Node/vite/npm/pnpm.
