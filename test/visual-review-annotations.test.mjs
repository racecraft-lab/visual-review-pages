import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annotationCommentBody,
  annotationPageHref,
  annotationStorageKey,
  imageCoordinatesFromAnnotation,
  resolvePullRequestCommentPlacement,
} from '../src/visual-review-annotations.mjs'

const context26 = {
  baseRef: 'main',
  headSha: 'abcdef1234567890',
  prNumber: '26',
  repository: 'racecraft-lab/mission-control',
  runKey: '123-attempt-1',
  runUrl: 'https://github.com/racecraft-lab/mission-control/actions/runs/123',
  surface: 'playwright',
  surfaceLabel: 'Playwright UI E2E',
}

const context27 = {
  ...context26,
  headSha: 'fedcba0987654321',
  prNumber: '27',
  runKey: '456-attempt-1',
  surface: 'storybook',
  surfaceLabel: 'Storybook Components',
}

test('annotation storage keys are isolated by PR, surface, run, head, snapshot, and asset', () => {
  const key26 = annotationStorageKey({
    asset: 'current',
    context: context26,
    itemId: 'new-product-line-switcher/keyboard-listbox-focus.png',
  })
  const key27 = annotationStorageKey({
    asset: 'current',
    context: context27,
    itemId: 'new-product-line-switcher/keyboard-listbox-focus.png',
  })

  assert.match(key26, /racecraft-lab\/mission-control:26:playwright:123-attempt-1:abcdef1234567890:/)
  assert.match(key26, /:current$/)
  assert.notEqual(key26, key27)
})

test('annotation page URLs stay inside the deployed report directory', () => {
  const href = annotationPageHref({
    asset: 'current',
    basePath: 'https://racecraft-lab.github.io/mission-control/pr/26/playwright/latest/index.html?id=old',
    itemId: 'new-product-line-switcher/keyboard-listbox-focus.png',
  })

  assert.equal(
    href,
    'https://racecraft-lab.github.io/mission-control/pr/26/playwright/latest/annotate.html?id=new-product-line-switcher%2Fkeyboard-listbox-focus.png&asset=current'
  )
})

test('image coordinates are stored as natural pixels and percentages', () => {
  const coords = imageCoordinatesFromAnnotation({
    annotation: {
      boundingBox: { height: 100, width: 200, x: 500, y: 300 },
      comment: 'Copy clips here',
      id: 'ann-1',
    },
    imageRect: { height: 400, width: 800, x: 100, y: 100 },
    naturalSize: { height: 800, width: 1600 },
  })

  assert.equal(coords.pixelX, 1000)
  assert.equal(coords.pixelY, 500)
  assert.equal(coords.xPct, 62.5)
  assert.equal(coords.yPct, 62.5)
  assert.deepEqual(coords.boxPct, { height: 25, width: 25, x: 50, y: 50 })
})

test('PR placement prefers exact right-side diff lines', () => {
  const placement = resolvePullRequestCommentPlacement({
    files: [{
      filename: 'tests/e2e/spec.ts',
      patch: [
        '@@ -39,6 +39,7 @@ test',
        ' context',
        ' context',
        '+await expect(page).toHaveScreenshot()',
      ].join('\n'),
    }],
    target: { line: 41, path: 'tests/e2e/spec.ts' },
  })

  assert.deepEqual(placement, {
    body: { line: 41, side: 'RIGHT' },
    kind: 'line',
    reason: '',
  })
})

test('PR placement falls back to file-level and timeline comments', () => {
  const filePlacement = resolvePullRequestCommentPlacement({
    files: [{ filename: 'src/component.tsx', patch: '@@ -1,1 +1,1 @@\n context' }],
    target: { line: 20, path: 'src/component.tsx' },
  })
  const timelinePlacement = resolvePullRequestCommentPlacement({
    files: [],
    target: { line: 20, path: 'src/component.tsx' },
  })

  assert.equal(filePlacement.kind, 'file')
  assert.deepEqual(filePlacement.body, { subject_type: 'file' })
  assert.match(filePlacement.reason, /exact line is not part of the diff/)
  assert.equal(timelinePlacement.kind, 'timeline')
  assert.match(timelinePlacement.reason, /not present in this PR diff/)
})

test('annotation comments include links, coordinates, and a multi-PR marker', () => {
  const body = annotationCommentBody({
    annotation: {
      id: 'ann-123',
      comment: 'The label is clipped.',
      image: {
        pixelX: 1000,
        pixelY: 600,
        rawFile: 'product-line-switcher/keyboard-listbox-focus.png',
        url: 'https://racecraft-lab.github.io/mission-control/pr/26/playwright/latest/__reg__/1_actual/product-line-switcher/keyboard-listbox-focus.png',
        xPct: 62.5,
        yPct: 75,
      },
      review: {
        annotationPageUrl: 'https://racecraft-lab.github.io/mission-control/pr/26/playwright/latest/annotate.html?id=new-product-line-switcher%2Fkeyboard-listbox-focus.png&asset=current',
        asset: 'current',
        headSha: context26.headSha,
        itemId: 'new-product-line-switcher/keyboard-listbox-focus.png',
        prNumber: context26.prNumber,
        repository: context26.repository,
        runKey: context26.runKey,
        runUrl: context26.runUrl,
        snapshot: 'product-line-switcher/keyboard-listbox-focus.png',
        surface: context26.surface,
      },
      target: {
        href: 'https://github.com/racecraft-lab/mission-control/blob/abcdef1234567890/tests/e2e/spec.ts#L41',
        line: 41,
        path: 'tests/e2e/spec.ts',
      },
    },
    placementReason: 'The exact line is not part of the diff.',
  })

  assert.match(body, /^The label is clipped\./)
  assert.match(body, /Image coordinates: `1000, 600` px \(`62.5%, 75%`\)/)
  assert.match(body, /Visual annotation:/)
  assert.match(body, /Raw image:/)
  assert.match(body, /Related source file:/)
  assert.match(body, /Placement note: The exact line is not part of the diff\./)
  assert.match(body, /<!-- visual-review-pages-annotation:v1 /)
  assert.match(body, /"prNumber":"26"/)
  assert.match(body, /"surface":"playwright"/)
  assert.match(body, /"annotationId":"ann-123"/)
})
