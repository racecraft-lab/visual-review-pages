# Repository Guidelines

## Project Structure & Module Organization

This package builds static visual review pages and reusable GitHub Actions
workflows for screenshot review reports. Source modules live in `src/`, with
browser UI assets in `src/visual-review-app.js` and
`src/visual-review-app.css`, reusable ESM modules in `src/*.mjs`, and the React
annotation entrypoint in `src/visual-annotation-app.jsx`. CLI entrypoints live
in `bin/`. Tests are in `test/*.test.mjs`. Documentation belongs in `docs/`,
workflow callers are under `.github/workflows/`, examples are in `examples/`,
and the committed annotation bundle is `dist/visual-annotation-app.js`.

## Build, Test, and Development Commands

Use npm; `package-lock.json` is the lockfile.

- `npm install` installs dependencies for local work.
- `npm run build` runs Vite and rebuilds the annotation bundle in `dist/`.
- `node --test` runs the Node test suite only.
- `npm run check` is the required validation command: it builds, syntax-checks
  source and CLI files with `node --check`, then runs `node --test`.

There is no dedicated dev-server script. For static UI checks, rebuild and open
the relevant HTML/report shell locally.

## Coding Style & Naming Conventions

Use ESM syntax, two-space indentation, single quotes, and omit semicolons to
match the existing code. Keep filenames descriptive and aligned with the
package exports, for example `visual-review-state.mjs` and
`visual-review-publisher.mjs`. Prefer small pure helpers in `src/*.mjs`; keep
browser-only behavior in the app entrypoints. When editing the React annotation
app, rebuild and include the updated `dist/visual-annotation-app.js`.

## Testing Guidelines

Tests use Node's built-in `node:test` with `node:assert/strict`. Name new tests
`test/visual-review-<area>.test.mjs` and keep fixtures inline unless sharing
them reduces real duplication. Add coverage for publisher, state, baseline,
approval, and annotation behavior when changing those contracts.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit subjects such as
`fix: persist visual baseline approval state`. Use concise `fix:`, `feat:`,
`docs:`, or `test:` subjects. PRs should describe the changed review surface,
list validation run (`npm run check`), link the consuming workflow or issue when
relevant, and include screenshots or a Pages/report URL for visible UI changes.

## Security & Configuration Tips

Do not persist GitHub tokens outside the documented browser/session storage
flow. Keep `third-party/agentation-LICENSE.txt` with any deployed Agentation
bundle, and avoid committing generated report data from consuming repos.
