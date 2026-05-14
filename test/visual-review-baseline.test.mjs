import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import {
  applyBaselineReviewStateToPayload,
  applyReviewScopeToPayload,
  buildSurfaceBaselineReviewState,
  inferReviewDomainsFromChangedFiles,
  mergeSurfaceBaselineReviewState,
  resolveChangedFileReviewScope,
} from '../src/visual-review-baseline.mjs'

const repository = 'example-org/example-product'
const surface = 'playwright'
const snapshot = 'settings/default.png'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function tempReport() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-baseline-'))
  const reportDir = path.join(tempDir, 'report')
  const actualDir = path.join(reportDir, '__reg__', '1_actual', 'settings')
  mkdirSync(actualDir, { recursive: true })
  return { actualDir, reportDir, tempDir }
}

function payload(fileName = snapshot) {
  return {
    actualDir: '__reg__/1_actual',
    deletedItems: [],
    diffDir: '__reg__/0_diff',
    expectedDir: '__reg__/2_expected',
    failedItems: [],
    newItems: [{ raw: fileName, encoded: fileName }],
    passedItems: [],
  }
}

test('review domain inference prefers visual source files over docs paths', () => {
  const domains = inferReviewDomainsFromChangedFiles({
    changedFiles: [
      'docs/ai/specs/SPEC-008-workflow.md',
      'src/components/panels/orchestration-bar.workflow-contracts.stories.tsx',
      'tests/e2e/workflow-contract-diagnostics.spec.ts',
    ],
    payload: {
      deletedItems: [],
      failedItems: [
        {
          raw: 'spec-008/budget.default.png',
          review: {
            domain: 'spec-008',
            sourceFile: 'tests/e2e/spec-008/budget.spec.ts',
          },
        },
      ],
      newItems: [
        {
          raw: 'workflow-contracts/contracts-diagnostics-redacted.png',
          review: {
            domain: 'workflow-contracts',
            sourceFile: 'tests/e2e/workflow-contract-diagnostics.spec.ts:12',
          },
        },
      ],
    },
  })

  assert.deepEqual(domains, ['workflow-contracts'])
})

test('changed-file auto scope filters all reviewable items when no visual domain matches', () => {
  const visualPayload = {
    deletedItems: [],
    failedItems: [],
    newItems: [
      {
        raw: 'spec-008/budget.default.png',
        review: {
          domain: 'spec-008',
          sourceFile: 'tests/e2e/spec-008/budget.spec.ts',
        },
      },
      {
        raw: 'workflow-contracts/contracts-diagnostics-redacted.png',
        review: {
          domain: 'workflow-contracts',
          sourceFile: 'tests/e2e/workflow-contract-diagnostics.spec.ts',
        },
      },
    ],
    passedItems: [
      {
        raw: 'spec-008/budget.passed.png',
        review: {
          domain: 'spec-008',
          sourceFile: 'tests/e2e/spec-008/budget.spec.ts',
        },
      },
    ],
  }

  const reviewScope = resolveChangedFileReviewScope({
    changedFiles: [
      'src/app/api/github/route.ts',
      'src/app/api/github/sync/route.ts',
    ],
    configuredReviewDomains: ['auto'],
    payload: visualPayload,
  })
  const scoped = applyReviewScopeToPayload({
    payload: visualPayload,
    reviewDomains: reviewScope.domains,
    emptyScopeReason: reviewScope.emptyScopeReason,
  })

  assert.deepEqual(reviewScope.domains, [])
  assert.equal(reviewScope.emptyScopeReason, 'changed-files-no-review-domain')
  assert.deepEqual(scoped.newItems, [])
  assert.deepEqual(scoped.passedItems, [])
  assert.equal(scoped.reviewScope.filtered, 3)
  assert.deepEqual(scoped.reviewScope.domains, [])
  assert.equal(scoped.reviewScope.reason, 'changed-files-no-review-domain')
})

function payloadForTestIdentity({
  fileName = snapshot,
  sourceFile = 'tests/e2e/settings.spec.ts',
  titlePath = ['settings.spec.ts', 'Settings panel', 'shows defaults'],
} = {}) {
  return {
    ...payload(fileName),
    newItems: [{
      raw: fileName,
      encoded: fileName,
      review: {
        kind: 'playwright',
        sourceFile: `${sourceFile}:42`,
        testTitle: titlePath.at(-1),
        testTitlePath: titlePath,
        title: titlePath.at(-1),
      },
    }],
  }
}

function payloadForTestSnapshots(fileNames, {
  sourceFile = 'tests/e2e/settings.spec.ts',
  titlePath = ['settings.spec.ts', 'Settings panel', 'captures key states'],
} = {}) {
  return {
    ...payload(fileNames[0]),
    newItems: fileNames.map((fileName) => ({
      raw: fileName,
      encoded: fileName,
      review: {
        kind: 'playwright',
        sourceFile: `${sourceFile}:42`,
        testTitle: titlePath.at(-1),
        testTitlePath: titlePath,
        title: titlePath.at(-1),
      },
    })),
  }
}

function sourceReviewState(fileName = snapshot) {
  return {
    prNumber: '26',
    prTitle: 'Approved baseline',
    prUrl: 'https://github.com/example-org/example-product/pull/26',
    repository,
    schema: 'visual-review-pages.visual-review-state.v1',
    surfaces: {
      [surface]: {
        decisions: {
          [`new-${fileName}`]: {
            decision: 'approved',
            group: 'settings',
            reviewer: 'reviewer',
            snapshot: fileName,
            updatedAt: '2026-05-04T20:00:00.000Z',
            variant: 'new',
          },
        },
        headSha: 'pr-head-sha',
        prNumber: '26',
        repository,
        summary: {
          approved: 1,
          open: 0,
          rejected: 0,
          reviewable: 1,
          reviewed: 1,
          status: 'approved',
        },
        surface,
        surfaceLabel: 'Playwright UI',
      },
    },
    updatedAt: '2026-05-04T20:00:00.000Z',
    version: 1,
  }
}

function sourceReviewStateForSnapshots(fileNames) {
  const state = sourceReviewState(fileNames[0])
  state.surfaces[surface].decisions = Object.fromEntries(fileNames.map((fileName) => [
    `new-${fileName}`,
    {
      decision: 'approved',
      group: 'settings',
      reviewer: 'reviewer',
      snapshot: fileName,
      updatedAt: '2026-05-04T20:00:00.000Z',
      variant: 'new',
    },
  ]))
  return state
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngBuffer({ changedPixels = [] } = {}) {
  const width = 20
  const height = 20
  const pixels = Array.from({ length: width * height }, () => [240, 244, 248])
  for (const { index, rgb } of changedPixels) pixels[index] = rgb

  const rows = []
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]))
    rows.push(Buffer.from(pixels.slice(y * width, (y + 1) * width).flat()))
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

test('main publishing can store approved baseline tests with image hashes', async () => {
  const { reportDir, tempDir } = tempReport()
  try {
    writeFileSync(path.join(reportDir, '__reg__', '1_actual', snapshot), 'approved-png')

    const baseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
        sourcePullRequest: {
          number: '26',
          url: 'https://github.com/example-org/example-product/pull/26',
        },
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity(),
      reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    assert.equal(baseline.surface, surface)
    assert.equal(baseline.summary.approved, 1)
    assert.equal(baseline.summary.tests, 1)
    assert.equal(baseline.snapshots[snapshot].decision, 'approved')
    assert.equal(baseline.snapshots[snapshot].sourcePrNumber, '26')
    assert.match(baseline.snapshots[snapshot].imageSha256, /^[a-f0-9]{64}$/)
    const baselineTest = Object.values(baseline.tests)[0]
    assert.equal(baselineTest.snapshots[snapshot].snapshot, snapshot)
    assert.equal(baselineTest.testIdentity.kind, 'playwright')
    assert.deepEqual(baselineTest.testIdentity.testTitlePath, ['settings.spec.ts', 'Settings panel', 'shows defaults'])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('main publishing accumulates approved baseline snapshots across merged PRs', () => {
  const existingSurface = {
    baseRef: 'main',
    headRef: 'main',
    headSha: 'old-main-sha',
    reportHref: 'https://example.github.io/example-product/playwright/latest/',
    repository,
    snapshots: {
      'settings/default.png': {
        decision: 'approved',
        group: 'settings',
        imageSha256: 'old-approved-hash',
        itemId: 'new-settings/default.png',
        reviewer: 'reviewer',
        snapshot: 'settings/default.png',
        sourcePrNumber: '26',
        sourceVariant: 'new',
        testKey: 'settings-default-test',
      },
    },
    summary: {
      approved: 1,
      snapshots: 1,
      tests: 1,
    },
    surface,
    surfaceLabel: 'Playwright UI',
    tests: {
      'settings-default-test': {
        decision: 'approved',
        group: 'settings',
        reviewer: 'reviewer',
        snapshots: {
          'settings/default.png': {
            decision: 'approved',
            group: 'settings',
            imageSha256: 'old-approved-hash',
            itemId: 'new-settings/default.png',
            reviewer: 'reviewer',
            snapshot: 'settings/default.png',
            sourcePrNumber: '26',
            sourceVariant: 'new',
            testKey: 'settings-default-test',
          },
        },
        testKey: 'settings-default-test',
      },
    },
    updatedAt: '2026-05-05T00:00:00.000Z',
  }
  const deltaSurface = {
    ...existingSurface,
    headSha: 'new-main-sha',
    snapshots: {
      'settings/new-mode.png': {
        decision: 'approved',
        group: 'settings',
        imageSha256: 'new-approved-hash',
        itemId: 'new-settings/new-mode.png',
        reviewer: 'reviewer',
        snapshot: 'settings/new-mode.png',
        sourcePrNumber: '28',
        sourceVariant: 'new',
        testKey: 'settings-new-mode-test',
      },
    },
    summary: {
      approved: 1,
      snapshots: 1,
      tests: 1,
    },
    tests: {
      'settings-new-mode-test': {
        decision: 'approved',
        group: 'settings',
        reviewer: 'reviewer',
        snapshots: {
          'settings/new-mode.png': {
            decision: 'approved',
            group: 'settings',
            imageSha256: 'new-approved-hash',
            itemId: 'new-settings/new-mode.png',
            reviewer: 'reviewer',
            snapshot: 'settings/new-mode.png',
            sourcePrNumber: '28',
            sourceVariant: 'new',
            testKey: 'settings-new-mode-test',
          },
        },
        testKey: 'settings-new-mode-test',
      },
    },
    updatedAt: '2026-05-07T00:00:00.000Z',
  }

  const merged = mergeSurfaceBaselineReviewState({
    repository,
    schema: 'visual-review-pages.visual-baseline-state.v1',
    surfaces: {
      [surface]: existingSurface,
    },
    updatedAt: '2026-05-05T00:00:00.000Z',
    version: 1,
  }, deltaSurface)

  assert.equal(merged.surfaces[surface].headSha, 'new-main-sha')
  assert.equal(merged.surfaces[surface].snapshots['settings/default.png'].imageSha256, 'old-approved-hash')
  assert.equal(merged.surfaces[surface].snapshots['settings/new-mode.png'].imageSha256, 'new-approved-hash')
  assert.equal(merged.surfaces[surface].tests['settings-default-test'].snapshots['settings/default.png'].imageSha256, 'old-approved-hash')
  assert.equal(merged.surfaces[surface].tests['settings-new-mode-test'].snapshots['settings/new-mode.png'].imageSha256, 'new-approved-hash')
  assert.deepEqual(merged.surfaces[surface].summary, {
    approved: 2,
    snapshots: 2,
    tests: 2,
  })
})

test('PR publishing keeps same-image snapshots reviewable when the test identity is new', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshot), 'approved-png')
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity({
        titlePath: ['settings.spec.ts', 'Settings panel', 'shows defaults'],
      }),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshot), 'approved-png')
    const filtered = await applyBaselineReviewStateToPayload({
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestIdentity({
        titlePath: ['settings.spec.ts', 'Settings panel', 'shows a new mode'],
      }),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 1)
    assert.equal(filtered.passedItems.length, 0)
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})

test('PR publishing without a baseline report directory hides items only when current image hash matches', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshot), 'approved-png')
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity(),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshot), 'approved-png')
    const filtered = await applyBaselineReviewStateToPayload({
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestIdentity(),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 0)
    assert.equal(filtered.passedItems.length, 1)
    assert.equal(filtered.passedItems[0].baselineApproval.sourcePrNumber, '26')

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshot), 'changed-png')
    const changed = await applyBaselineReviewStateToPayload({
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestIdentity(),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(changed.newItems.length, 1)
    assert.equal(changed.passedItems.length, 0)
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})

test('PR publishing hides baseline-approved new items when PNG pixels are identical despite different hashes', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshot), pngBuffer())
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity(),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(
      path.join(prReport.reportDir, '__reg__', '1_actual', snapshot),
      Buffer.concat([pngBuffer(), Buffer.from('metadata')])
    )
    const filtered = await applyBaselineReviewStateToPayload({
      baselineReportDir: baselineReport.reportDir,
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestIdentity(),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 0)
    assert.equal(filtered.passedItems.length, 1)
    assert.equal(filtered.passedItems[0].baselineApproval.matchKind, 'visual-tolerance')
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})

test('PR publishing keeps baseline-approved new items reviewable when PNG pixels differ', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshot), pngBuffer())
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity(),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshot), pngBuffer({
      changedPixels: Array.from({ length: 8 }, (_, index) => ({ index, rgb: [20, 30, 40] })),
    }))
    const filtered = await applyBaselineReviewStateToPayload({
      baselineReportDir: baselineReport.reportDir,
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestIdentity(),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 1)
    assert.equal(filtered.passedItems.length, 0)
    assert.deepEqual(filtered.newItems[0].baselineReference, {
      baselineHeadSha: 'main-head-sha',
      baselineReportHref: 'https://example.github.io/example-product/playwright/latest/',
      imageHref: 'https://example.github.io/example-product/playwright/latest/__reg__/1_actual/settings/default.png',
      imageSha256: surfaceBaseline.snapshots[snapshot].imageSha256,
      sourcePrNumber: '26',
      sourcePrUrl: 'https://github.com/example-org/example-product/pull/26',
      sourceTestKey: surfaceBaseline.snapshots[snapshot].testKey,
      sourceVariant: 'new',
    })
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})

test('PR baseline references use main report asset paths when reg-viz paths traverse upward', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-baseline-traversal-'))
  const reportDir = path.join(tempDir, 'pages', 'pr', '28', 'storybook', 'latest')
  const baselineActualDir = path.join(reportDir, '__reg__', '1_actual', 'settings')
  const currentActualDir = path.resolve(reportDir, '../../../__reg__/1_actual/settings')
  try {
    mkdirSync(baselineActualDir, { recursive: true })
    mkdirSync(currentActualDir, { recursive: true })
    writeFileSync(path.join(baselineActualDir, 'default.png'), pngBuffer())
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/storybook/latest/',
        repository,
      },
      initialReviewState: sourceReviewState(),
      payload: payloadForTestIdentity(),
      reportDir,
      surface,
      surfaceLabel: 'Storybook',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(currentActualDir, 'default.png'), pngBuffer({
      changedPixels: Array.from({ length: 8 }, (_, index) => ({ index, rgb: [20, 30, 40] })),
    }))
    const prPayload = {
      ...payloadForTestIdentity(),
      actualDir: '../../../__reg__/1_actual',
    }
    const filtered = await applyBaselineReviewStateToPayload({
      baselineReportDir: reportDir,
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: prPayload,
      reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 1)
    assert.equal(filtered.passedItems.length, 0)
    assert.equal(
      filtered.newItems[0].baselineReference.imageHref,
      'https://example.github.io/example-product/storybook/latest/__reg__/1_actual/settings/default.png'
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('PR publishing hides every item for an unchanged multi-snapshot test', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  const snapshots = ['settings/default.png', 'settings/expanded.png']
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshots[0]), 'default-png')
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshots[1]), 'expanded-png')
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewStateForSnapshots(snapshots),
      payload: payloadForTestSnapshots(snapshots),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshots[0]), 'default-png')
    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshots[1]), 'expanded-png')
    const filtered = await applyBaselineReviewStateToPayload({
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestSnapshots(snapshots),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 0)
    assert.equal(filtered.passedItems.length, 2)
    assert.equal(filtered.passedItems[0].baselineApproval.sourceTestKey, filtered.passedItems[1].baselineApproval.sourceTestKey)
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})

test('PR publishing keeps the whole multi-snapshot test reviewable when one snapshot changes', async () => {
  const baselineReport = tempReport()
  const prReport = tempReport()
  const snapshots = ['settings/default.png', 'settings/expanded.png']
  try {
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshots[0]), 'default-png')
    writeFileSync(path.join(baselineReport.reportDir, '__reg__', '1_actual', snapshots[1]), 'expanded-png')
    const surfaceBaseline = await buildSurfaceBaselineReviewState({
      context: {
        headRef: 'main',
        headSha: 'main-head-sha',
        reportHref: 'https://example.github.io/example-product/playwright/latest/',
        repository,
      },
      initialReviewState: sourceReviewStateForSnapshots(snapshots),
      payload: payloadForTestSnapshots(snapshots),
      reportDir: baselineReport.reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshots[0]), 'default-png')
    writeFileSync(path.join(prReport.reportDir, '__reg__', '1_actual', snapshots[1]), 'changed-expanded-png')
    const filtered = await applyBaselineReviewStateToPayload({
      baselineState: {
        repository,
        schema: 'visual-review-pages.visual-baseline-state.v1',
        surfaces: { [surface]: surfaceBaseline },
        updatedAt: '2026-05-05T00:00:00.000Z',
        version: 1,
      },
      payload: payloadForTestSnapshots(snapshots),
      reportDir: prReport.reportDir,
      surface,
    })

    assert.equal(filtered.newItems.length, 2)
    assert.equal(filtered.passedItems.length, 0)
  } finally {
    rmSync(baselineReport.tempDir, { recursive: true, force: true })
    rmSync(prReport.tempDir, { recursive: true, force: true })
  }
})
