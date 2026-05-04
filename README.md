# Visual Review Pages

Static visual review app for reg-viz/reg-actions screenshot reports.

This repository is the reusable source for the GitHub Pages review UI used by
Mission Control PR visual reports. The app is intentionally framework-free so a
CI publisher can copy `src/visual-review-app.css`, `src/visual-review-app.js`,
`src/visual-review-state.mjs`, an `index.html` shell, and the report-local
`__reg__` image tree into any Pages directory.

## Reviewer Features

- Review queue for changed, new, deleted, and unchanged snapshots.
- Search and group filters for large PR screenshot sets.
- Side-by-side, highlighter, overlay, and blink views for changed snapshots.
- Reviewer context cards for producer-supplied snapshot metadata, expected
  state, review focus, tags, source files, Playwright annotations, and Storybook
  story IDs.
- Local approve/reject marks with JSON import/export and a copyable PR review
  summary.
- Optional GitHub token flow for publishing shared PR review state and commit
  status updates from the static page.
- Links back to the raw reg-viz report, workflow run, and pull request.

Review marks are stored in browser `localStorage`; GitHub tokens are stored only
in tab-scoped `sessionStorage`. When configured, the app can also publish the
shared visual review state into a managed PR comment so reviewers can continue
the same approval/reject flow across browsers.

## Producer Contract

See `docs/producer-contract.md` for the required inline JSON shape and static
file layout.

## Validation

```bash
npm run check
```
