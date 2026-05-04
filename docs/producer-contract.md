# Producer Contract

The app needs one HTML file, three static assets, and the image tree generated
by reg-viz/reg-actions. If image annotations are enabled, include the annotation
HTML shell, bundled annotation script, helper module, and bundled dependency
license notice as well.

## Directory Layout

```text
<report-dir>/
  index.html
  annotate.html
  reg-viz.html
  visual-review-app.css
  visual-review-app.js
  visual-review-annotations.mjs
  visual-review-state.mjs
  visual-annotation-app.js
  third-party/
    agentation-LICENSE.txt
  __reg__/
    0_diff/
    1_actual/
    2_expected/
```

`index.html` is the visual review queue app. `annotate.html` is the
Agentation-powered image annotation app. `reg-viz.html` is the raw fallback
report. The `__reg__` directory must preserve the original screenshot file
names referenced by the reg-viz payload.

## HTML Shell

```html
<link rel="stylesheet" href="./visual-review-app.css" />
<div id="visual-review-root"></div>
<script id="visual-review-data" type="application/json">
  {"context": {}, "payload": {}}
</script>
<script src="./visual-review-app.js" type="module"></script>
```

Escape `<`, `>`, and `&` in the inline JSON before writing it into the script
tag.

## Annotation Shell

```html
<link rel="stylesheet" href="./visual-review-app.css" />
<div id="visual-annotation-root"></div>
<script src="./visual-annotation-app.js" type="module"></script>
```

`annotate.html` can be deployed without inline JSON. It fetches the sibling
`index.html`, reads `#visual-review-data`, and resolves image URLs relative to
the current report directory. It falls back to parsing `reg-viz.html` only when
the review-data script is unavailable.

## Context Shape

Required fields:

```json
{
  "prNumber": "26",
  "prTitle": "PR title",
  "prUrl": "https://github.com/org/repo/pull/26",
  "prIndexHref": "https://org.github.io/repo/pr/26/",
  "surface": "storybook",
  "surfaceLabel": "Storybook Components",
  "workflowName": "Visual Storybook Snapshots",
  "runId": "123",
  "runKey": "123-attempt-1",
  "runUrl": "https://github.com/org/repo/actions/runs/123",
  "headRef": "feature-branch",
  "baseRef": "main",
  "headSha": "abcdef0",
  "regVizHref": "./reg-viz.html"
}
```

Optional fields can be included by producers and ignored by the current app.

The annotation workflow derives all GitHub API targets from this context. Never
hardcode repository, PR number, surface, run key, or head SHA in a deployed
bundle; those values must come from the report context so multiple PRs can be
reviewed at the same time.

## Payload Shape

Use the reg-viz `window.__reg__` payload after localizing:

```json
{
  "failedItems": [],
  "newItems": [],
  "deletedItems": [],
  "passedItems": [],
  "actualDir": "./__reg__/1_actual",
  "expectedDir": "./__reg__/2_expected",
  "diffDir": "./__reg__/0_diff",
  "diffImageExtention": "webp"
}
```

Each item should include `raw` and `encoded` file names. Changed snapshots are
read from `failedItems`; new snapshots from `newItems`; removed snapshots from
`deletedItems`; unchanged snapshots from `passedItems`.

Items may include a producer-supplied `review` object. The app treats this as
reviewer-facing metadata and uses it for display labels, filtering, search, and
the sticky reviewer brief beside the screenshot canvas. Producers should keep
`title`, `description`, `focus`, `sourceFile`, and story/test identifiers
readable because those fields are the primary reviewer orientation surface.

```json
{
  "failedItems": [
    {
      "raw": "spec-008/budget.50pct.png",
      "encoded": "spec-008/budget.50pct.png",
      "review": {
        "title": "SPEC-008 / Budget 50pct",
        "description": "Review the budget utilization visual state.",
        "expected": "The utilization bar and threshold copy should match the named state.",
        "focus": [
          "Budget threshold copy",
          "Progress bar fill",
          "Operator action controls"
        ],
        "tags": ["spec-008", "visual"],
        "domain": "spec-008",
        "kind": "playwright",
        "name": "budget.50pct",
        "sourceFile": "tests/e2e/spec-008/budgets.spec.ts:42",
        "testTitle": "shows budget utilization",
        "testTitlePath": ["budgets", "shows budget utilization"],
        "testAnnotations": [
          { "type": "review-focus", "description": "Check the budget labels." }
        ]
      }
    }
  ]
}
```

Storybook producers should keep CSF export names stable and can map Storybook
metadata into the same `review` object:

```json
{
  "review": {
    "title": "Governance / Budget Utilization Chart: Soft Threshold",
    "description": "Review the Soft Threshold Storybook state for the budget chart.",
    "focus": ["Story args and mocked state", "Responsive layout and spacing"],
    "tags": ["visual", "spec-008"],
    "domain": "spec-008",
    "kind": "storybook",
    "sourceFile": "src/components/governance/budget-utilization-chart.stories.tsx",
    "storyId": "governance-budget-utilization-chart--soft-threshold",
    "storyTitle": "governance/BudgetUtilizationChart",
    "storyName": "Soft Threshold",
    "storyExportName": "SoftThreshold"
  }
}
```

## Multi-PR State Isolation

Browser state is scoped by repository, PR number, surface, run key, head SHA,
snapshot ID, and asset type. Producers must keep those context fields accurate
for every report directory. This is what keeps paths such as
`/mission-control/pr/26/playwright/latest/` and
`/mission-control/pr/27/playwright/latest/` independent when opened in separate
tabs.
