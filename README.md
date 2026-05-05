# Visual Review Pages

Static visual review app for reg-viz/reg-actions screenshot reports.

This repository is the reusable source for the GitHub Pages review UI used by
Mission Control PR visual reports. The app is intentionally framework-free so a
CI publisher can copy the review assets, an `index.html` shell, and the
report-local `__reg__` image tree into any Pages directory. The queue app stays
framework-free. The image annotation page uses a prebuilt React bundle because
Agentation is distributed as a React component.

## Reviewer Features

- Three-pane review desk with a compact queue, image-first canvas, and sticky
  review brief for the selected snapshot.
- Review queue for changed, new, deleted, and unchanged snapshots, defaulting
  reviewers to open items instead of already-reviewed items.
- Search and group filters for large PR screenshot sets.
- Side-by-side, highlighter, overlay, and blink views for changed snapshots.
- Reviewer brief for producer-supplied snapshot metadata, expected
  state, review focus, tags, source files, Playwright annotations, and Storybook
  story IDs.
- Local approve/reject marks with JSON import/export and a copyable PR review
  summary.
- Optional GitHub token flow with a prefilled GitHub token-creation link for
  publishing shared PR review state and commit status updates from the static
  page.
- Main-branch reports can embed the merged PR's managed review state during CI
  publishing, so reviewers opening the report later see the approval/rejection
  decisions that unblocked that PR.
- Links back to the raw reg-viz report, workflow run, and pull request.
- Image annotation page for current/baseline/diff assets. Reviewers can open a
  screenshot, mark it with Agentation, and post GitHub PR comments that include
  image links, source links, and image coordinates for follow-up agents.
- Image annotations are bounded to the reviewed image. The app rejects clicks
  outside the image and stores coordinates in the image's natural pixel space,
  so markers stay attached to the same point while reviewers zoom or pan.

Review marks are stored in browser `localStorage` under a key that includes the
head SHA so stale approvals do not carry into a new commit. GitHub tokens are
stored only in tab-scoped `sessionStorage`. When configured, the app can also
publish the shared visual review state into a managed PR comment so reviewers
can continue the same approval/reject flow across browsers. Loading shared PR
state replaces local decisions for the current surface, which lets a reset PR
comment clear stale local approvals.

Annotation drafts are also stored in browser `localStorage`, scoped by
repository, PR number, visual surface, run key, head SHA, snapshot ID, and asset
type. This lets multiple PRs and surfaces stay open in separate tabs without
state bleed. GitHub tokens remain tab-scoped in `sessionStorage`.

Agentation is bundled under the PolyForm Shield 1.0.0 license. Keep
`third-party/agentation-LICENSE.txt` with any deployed bundle that includes
`dist/visual-annotation-app.js`.

## Producer Contract

See `docs/producer-contract.md` for the required inline JSON shape and static
file layout.

## Validation

```bash
npm run check
```

`npm run check` builds the annotation bundle and runs syntax plus unit tests.
