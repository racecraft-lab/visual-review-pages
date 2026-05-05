import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyBaselineReviewStateToPayload,
  buildSurfaceBaselineReviewState,
} from '../src/visual-review-baseline.mjs'

const repository = 'example-org/example-product'
const surface = 'playwright'
const snapshot = 'settings/default.png'

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

test('main publishing can store approved baseline snapshots with image hashes', async () => {
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
      payload: payload(),
      reportDir,
      surface,
      surfaceLabel: 'Playwright UI',
      updatedAt: '2026-05-05T00:00:00.000Z',
    })

    assert.equal(baseline.surface, surface)
    assert.equal(baseline.summary.approved, 1)
    assert.equal(baseline.snapshots[snapshot].decision, 'approved')
    assert.equal(baseline.snapshots[snapshot].sourcePrNumber, '26')
    assert.match(baseline.snapshots[snapshot].imageSha256, /^[a-f0-9]{64}$/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('PR publishing hides baseline-approved items only when current image hash matches', async () => {
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
      payload: payload(),
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
      payload: payload(),
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
      payload: payload(),
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
