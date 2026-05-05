# Visual Review Pages

Static visual review app for reg-viz/reg-actions screenshot reports.

This repository is the reusable source for GitHub Pages visual review reports
used by Mission Control and future repos. The app is intentionally
framework-free so a CI publisher can copy the review assets, an `index.html`
shell, and the report-local `__reg__` image tree into any Pages directory. The
queue app stays framework-free. The image annotation page uses a prebuilt React
bundle because Agentation is distributed as a React component.

## Reviewer Features

- Three-pane review desk with a compact queue, image-first canvas, and sticky
  review brief for the selected snapshot.
- Review queue for changed, new, deleted, and unchanged snapshots, defaulting
  reviewers to open items instead of already-reviewed items.
- Search and group filters for large PR screenshot sets.
- Persistent light/dark mode shared by the queue and image annotation pages.
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

## Reusable GitHub Workflows

Future repos should call the reusable workflows from this repo instead of
copying Mission Control-specific publisher scripts.

### Visual report workflow

Create a caller workflow in the product repo and delegate the report job to
`.github/workflows/visual-review-report.yml`:

```yaml
name: Visual Playwright Snapshots

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: write
  actions: read
  issues: write
  pull-requests: write

jobs:
  visual-report:
    uses: racecraft-lab/visual-review-pages/.github/workflows/visual-review-report.yml@main
    with:
      surface: playwright
      surface_label: Playwright UI E2E
      project_name: Example Product
      visual_test_command: pnpm test:e2e -- --update-snapshots
      manifest_command: pnpm visual:metadata
      manifest_dir: test-results/visual-metadata
      image_directory_path: test-results/visual-snapshots
      report_file_path: test-results/visual-report/report.html
      artifact_paths: |
        repo/test-results/
        repo/playwright-report/
      workflow_file: visual-playwright.yml
      pages_branch: visual-regression-pages
      base_url: https://example-org.github.io/example-product
```

The report workflow checks out the caller repo and this repo, runs the caller's
visual command, runs `reg-viz/reg-actions`, then runs
`publish-visual-review-pages` from this package. Pull request reports are
published under `/pr/<number>/<surface>/latest/`; main reports are published
under `/<surface>/<sha>/` and `/<surface>/latest/`. Set `artifact_paths` to the
caller repo's generated evidence paths, prefixed with `repo/` because the
reusable workflow checks the product repository out into that subdirectory.

### Approval status workflow

Create one caller workflow for the shared PR approval status:

```yaml
name: Visual Review Approval

on:
  pull_request:
  issue_comment:
    types: [created, edited, deleted]

permissions:
  contents: read
  issues: read
  pull-requests: read
  statuses: write

jobs:
  visual-approval:
    uses: racecraft-lab/visual-review-pages/.github/workflows/visual-review-approval.yml@main
    with:
      required_surfaces: playwright,storybook
      visual_review_paths: "src/**,tests/**,.storybook/**,playwright*.config.*"
```

The approval workflow runs `check-visual-review-approval` from this package. It
loads the managed hidden JSON from the PR comment, validates every required
surface, and writes the `visual-review-approval` commit status. Set
`visual_review_paths` to the caller repo's visual-producing files so docs-only
or backend-only PRs can pass without a visual review.

### GitHub Pages

Configure the product repo's GitHub Pages source to deploy from the
`visual-regression-pages` branch and `/` root, or pass another `pages_branch`.
The workflow token needs:

- `contents: write` for publishing the Pages branch.
- `issues: write` and `pull-requests: write` for reg-viz and managed review
  comments.
- `statuses: write` for the approval status workflow.
- `actions: read` so report metadata can link back to workflow runs.

`github.token` is enough when the repo's Actions permissions allow these
scopes. Use the optional `visual_review_token` secret only when organization
policy requires a stronger token.

### Direct CLI Usage

The workflows are the preferred interface, but custom CI can call the CLIs
directly after checking out this repo:

```bash
node visual-review-pages/bin/publish-visual-review-pages.mjs \
  --surface playwright \
  --surface-label "Playwright UI E2E" \
  --project-name "Example Product" \
  --report-file test-results/visual-report/report.html \
  --manifest-dir test-results/visual-metadata \
  --repository example-org/example-product

node visual-review-pages/bin/check-visual-review-approval.mjs \
  --repository example-org/example-product \
  --pr-number 42 \
  --required-surfaces playwright,storybook \
  --visual-review-paths "src/**,tests/**,.storybook/**" \
  --skip-if-no-visual-changes \
  --set-status
```

Set `VISUAL_REVIEW_PAGES_BRANCH`, `VISUAL_REVIEW_PAGES_BASE_URL`, and
`GITHUB_TOKEN` when publishing from custom CI.

## Producer Contract

See `docs/producer-contract.md` for the required inline JSON shape and static
file layout.

## Validation

```bash
npm run check
```

`npm run check` builds the annotation bundle and runs syntax plus unit tests.
