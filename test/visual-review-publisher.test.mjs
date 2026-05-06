import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function extractReviewData(html) {
  const match = html.match(/<script id="visual-review-data" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('visual review data script not found')
  return JSON.parse(match[1])
}

function appAssetVersion(repoRoot, runKey) {
  const hash = createHash('sha256')
  for (const fileName of ['visual-review-app.css', 'visual-review-app.js']) {
    hash.update(fileName)
    hash.update('\0')
    hash.update(readFileSync(path.join(repoRoot, 'src', fileName), 'utf8'))
    hash.update('\0')
  }
  return `${runKey}-${hash.digest('hex').slice(0, 12)}`
}

test('publisher CLI creates a reusable PR visual report bundle with annotation assets', () => {
  const repoRoot = process.cwd()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-publisher-'))
  const reportDir = path.join(tempDir, 'visual-report')
  const actualDir = path.join(reportDir, '__reg__', '1_actual')
  const pagesDir = path.join(tempDir, 'pages')
  const snapshot = 'audit-widget--default.png'

  try {
    mkdirSync(actualDir, { recursive: true })
    writeFileSync(path.join(actualDir, snapshot), 'png')
    const payload = {
      actualDir: '__reg__/1_actual',
      deletedItems: [],
      diffDir: '__reg__/0_diff',
      expectedDir: '__reg__/2_expected',
      failedItems: [],
      newItems: [{ raw: snapshot, encoded: snapshot }],
      passedItems: [],
    }
    const reportFile = path.join(reportDir, 'audit.html')
    writeFileSync(reportFile, `<script>window['__reg__'] = ${JSON.stringify(payload)};</script>`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'publish-visual-review-pages.mjs'),
      '--surface',
      'audit',
      '--surface-label',
      'Audit Screens',
      '--workflow-file',
      'visual-audit.yml',
      '--workflow',
      'Audit Visuals',
      '--project-name',
      'Reusable Product',
      '--report-file',
      reportFile,
      '--pages-dir',
      pagesDir,
      '--repository',
      'example/reusable-product',
      '--pr-number',
      '12',
      '--head-ref',
      'feature/visuals',
      '--base-ref',
      'main',
      '--sha',
      'abcdef1234567890',
      '--run-id',
      '456',
      '--run-attempt',
      '1',
      '--base-url',
      'https://example.github.io/reusable-product',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: 'abcdef1234567890',
      },
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const latestDir = path.join(pagesDir, 'pr', '12', 'audit', 'latest')
    const latestHtml = readFileSync(path.join(latestDir, 'index.html'), 'utf8')
    const reviewData = extractReviewData(latestHtml)

    assert.equal(reviewData.context.surface, 'audit')
    assert.equal(reviewData.context.surfaceLabel, 'Audit Screens')
    assert.equal(reviewData.context.workflowFile, 'visual-audit.yml')
    assert.equal(reviewData.context.workflowName, 'Audit Visuals')
    assert.equal(reviewData.context.repository, 'example/reusable-product')
    assert.equal(reviewData.context.prNumber, '12')
    assert.equal(reviewData.payload.newItems[0].encoded, snapshot)
    const assetVersion = appAssetVersion(repoRoot, '456-attempt-1')
    assert.equal(latestHtml.includes(`href="./visual-review-app.css?v=${assetVersion}"`), true)
    assert.equal(latestHtml.includes(`src="./visual-review-app.js?v=${assetVersion}"`), true)

    assert.equal(existsSync(path.join(latestDir, 'visual-review-app.js')), true)
    assert.equal(existsSync(path.join(latestDir, 'visual-review-state.mjs')), true)
    assert.equal(existsSync(path.join(latestDir, 'visual-review-annotations.mjs')), true)
    assert.equal(existsSync(path.join(latestDir, 'visual-review-heatmap.mjs')), true)
    assert.equal(existsSync(path.join(latestDir, 'visual-annotation-app.js')), true)
    assert.equal(existsSync(path.join(latestDir, 'annotate.html')), true)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '1_actual', snapshot)), true)
    assert.match(readFileSync(path.join(latestDir, 'visual-review-app.js'), 'utf8'), /annotationPageHref\(\{ asset: 'current'/)

    const prIndex = readFileSync(path.join(pagesDir, 'pr', '12', 'index.html'), 'utf8')
    assert.match(prIndex, /Reusable Product visual reviews/)
    assert.match(prIndex, /Audit Screens/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('publisher CLI resolves changed-item filenames to actual PNG assets', () => {
  const repoRoot = process.cwd()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-publisher-png-assets-'))
  const reportDir = path.join(tempDir, 'visual-report')
  const actualDir = path.join(reportDir, '__reg__', '1_actual')
  const expectedDir = path.join(reportDir, '__reg__', '2_expected')
  const diffDir = path.join(reportDir, '__reg__', '0_diff')
  const pagesDir = path.join(tempDir, 'pages')
  const pngSnapshot = 'governance/dashboard.png'
  const webpSnapshot = 'governance/dashboard.webp'

  try {
    mkdirSync(path.join(actualDir, 'governance'), { recursive: true })
    mkdirSync(path.join(expectedDir, 'governance'), { recursive: true })
    mkdirSync(path.join(diffDir, 'governance'), { recursive: true })
    writeFileSync(path.join(actualDir, pngSnapshot), 'actual-png')
    writeFileSync(path.join(expectedDir, pngSnapshot), 'expected-png')
    writeFileSync(path.join(diffDir, webpSnapshot), 'diff-webp')

    const payload = {
      actualDir: '__reg__/1_actual',
      deletedItems: [],
      diffDir: '__reg__/0_diff',
      diffImageExtention: 'webp',
      expectedDir: '__reg__/2_expected',
      failedItems: [{ raw: webpSnapshot, encoded: webpSnapshot }],
      newItems: [],
      passedItems: [],
    }
    const reportFile = path.join(reportDir, 'audit.html')
    writeFileSync(reportFile, `<script>window['__reg__'] = ${JSON.stringify(payload)};</script>`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'publish-visual-review-pages.mjs'),
      '--surface',
      'audit',
      '--report-file',
      reportFile,
      '--pages-dir',
      pagesDir,
      '--repository',
      'example/reusable-product',
      '--pr-number',
      '12',
      '--head-ref',
      'feature/visuals',
      '--base-ref',
      'main',
      '--sha',
      'abcdef1234567890',
      '--run-id',
      '456',
      '--run-attempt',
      '1',
      '--base-url',
      'https://example.github.io/reusable-product',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: 'abcdef1234567890',
      },
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const latestDir = path.join(pagesDir, 'pr', '12', 'audit', 'latest')
    const reviewData = extractReviewData(readFileSync(path.join(latestDir, 'index.html'), 'utf8'))

    assert.equal(reviewData.payload.failedItems[0].encoded, pngSnapshot)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '1_actual', pngSnapshot)), true)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '2_expected', pngSnapshot)), true)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '0_diff', webpSnapshot)), true)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('publisher CLI filters PR items already approved in the main baseline state', () => {
  const repoRoot = process.cwd()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-publisher-baseline-'))
  const reportDir = path.join(tempDir, 'visual-report')
  const actualDir = path.join(reportDir, '__reg__', '1_actual')
  const pagesDir = path.join(tempDir, 'pages')
  const snapshot = 'audit-widget--default.png'
  const imageContent = 'approved-png'

  try {
    mkdirSync(actualDir, { recursive: true })
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(path.join(actualDir, snapshot), imageContent)
    writeFileSync(path.join(pagesDir, 'visual-baseline-state.json'), `${JSON.stringify({
      repository: 'example/reusable-product',
      schema: 'visual-review-pages.visual-baseline-state.v1',
      surfaces: {
        audit: {
          headSha: 'main-head',
          reportHref: 'https://example.github.io/reusable-product/audit/latest/',
          repository: 'example/reusable-product',
          snapshots: {
            [snapshot]: {
              decision: 'approved',
              imageSha256: createHash('sha256').update(imageContent).digest('hex'),
              snapshot,
              sourcePrNumber: '11',
              sourcePrUrl: 'https://github.com/example/reusable-product/pull/11',
              sourceVariant: 'new',
            },
          },
          summary: {
            approved: 1,
            snapshots: 1,
          },
          surface: 'audit',
          surfaceLabel: 'Audit Screens',
          updatedAt: '2026-05-05T00:00:00.000Z',
        },
      },
      updatedAt: '2026-05-05T00:00:00.000Z',
      version: 1,
    }, null, 2)}\n`)

    const payload = {
      actualDir: '__reg__/1_actual',
      deletedItems: [],
      diffDir: '__reg__/0_diff',
      expectedDir: '__reg__/2_expected',
      failedItems: [],
      newItems: [{ raw: snapshot, encoded: snapshot }],
      passedItems: [],
    }
    const reportFile = path.join(reportDir, 'audit.html')
    writeFileSync(reportFile, `<script>window['__reg__'] = ${JSON.stringify(payload)};</script>`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'publish-visual-review-pages.mjs'),
      '--surface',
      'audit',
      '--report-file',
      reportFile,
      '--pages-dir',
      pagesDir,
      '--repository',
      'example/reusable-product',
      '--pr-number',
      '12',
      '--head-ref',
      'feature/visuals',
      '--base-ref',
      'main',
      '--sha',
      'abcdef1234567890',
      '--run-id',
      '456',
      '--run-attempt',
      '1',
      '--base-url',
      'https://example.github.io/reusable-product',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: 'abcdef1234567890',
      },
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const latestDir = path.join(pagesDir, 'pr', '12', 'audit', 'latest')
    const reviewData = extractReviewData(readFileSync(path.join(latestDir, 'index.html'), 'utf8'))

    assert.equal(reviewData.payload.newItems.length, 0)
    assert.equal(reviewData.payload.passedItems.length, 1)
    assert.equal(reviewData.payload.passedItems[0].baselineApproval.sourcePrNumber, '11')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('publisher CLI can scope reviewable PR items by visual metadata domain', () => {
  const repoRoot = process.cwd()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-publisher-domain-scope-'))
  const reportDir = path.join(tempDir, 'visual-report')
    const actualDir = path.join(reportDir, '__reg__', '1_actual')
    const pagesDir = path.join(tempDir, 'pages')
    const keptSnapshot = 'workflow-contracts/contracts-diagnostics.png'
    const filteredSnapshot = 'spec-008/budget-default.png'
    const filteredPassedSnapshot = 'spec-008/budget-passed.png'

    try {
      mkdirSync(path.dirname(path.join(actualDir, keptSnapshot)), { recursive: true })
      mkdirSync(path.dirname(path.join(actualDir, filteredSnapshot)), { recursive: true })
      mkdirSync(path.dirname(path.join(actualDir, filteredPassedSnapshot)), { recursive: true })
      writeFileSync(path.join(actualDir, keptSnapshot), 'kept-png')
      writeFileSync(path.join(actualDir, filteredSnapshot), 'filtered-png')
      writeFileSync(path.join(actualDir, filteredPassedSnapshot), 'filtered-passed-png')
    writeFileSync(path.join(actualDir, 'workflow-contracts', 'contracts-diagnostics.visual.json'), `${JSON.stringify({
      version: 1,
      kind: 'playwright',
      domain: 'workflow-contracts',
      name: 'contracts-diagnostics',
      sourceFile: 'tests/e2e/workflow-contract-diagnostics.spec.ts',
    }, null, 2)}\n`)
      writeFileSync(path.join(actualDir, 'spec-008', 'budget-default.visual.json'), `${JSON.stringify({
        version: 1,
        kind: 'playwright',
        domain: 'spec-008',
        name: 'budget-default',
        sourceFile: 'tests/e2e/governance-budget.e2e.ts',
      }, null, 2)}\n`)
      writeFileSync(path.join(actualDir, 'spec-008', 'budget-passed.visual.json'), `${JSON.stringify({
        version: 1,
        kind: 'playwright',
        domain: 'spec-008',
        name: 'budget-passed',
        sourceFile: 'tests/e2e/governance-budget.e2e.ts',
      }, null, 2)}\n`)

    const payload = {
      actualDir: '__reg__/1_actual',
      deletedItems: [],
      diffDir: '__reg__/0_diff',
      expectedDir: '__reg__/2_expected',
      failedItems: [],
      newItems: [
        { raw: keptSnapshot, encoded: keptSnapshot },
        { raw: filteredSnapshot, encoded: filteredSnapshot },
      ],
      passedItems: [
        { raw: filteredPassedSnapshot, encoded: filteredPassedSnapshot },
      ],
    }
    const reportFile = path.join(reportDir, 'audit.html')
    writeFileSync(reportFile, `<script>window['__reg__'] = ${JSON.stringify(payload)};</script>`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'publish-visual-review-pages.mjs'),
      '--surface',
      'audit',
      '--report-file',
      reportFile,
      '--pages-dir',
      pagesDir,
      '--repository',
      'example/reusable-product',
      '--pr-number',
      '12',
      '--head-ref',
      'feature/visuals',
      '--base-ref',
      'main',
      '--sha',
      'abcdef1234567890',
      '--run-id',
      '456',
      '--run-attempt',
      '1',
      '--base-url',
      'https://example.github.io/reusable-product',
      '--review-domains',
      'workflow-contracts',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: 'abcdef1234567890',
      },
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const latestDir = path.join(pagesDir, 'pr', '12', 'audit', 'latest')
    const reviewData = extractReviewData(readFileSync(path.join(latestDir, 'index.html'), 'utf8'))

    assert.deepEqual(reviewData.payload.newItems.map((item) => item.raw), [keptSnapshot])
    assert.deepEqual(reviewData.payload.passedItems.map((item) => item.raw), [])
    assert.equal(reviewData.payload.reviewScope.filtered, 2)
    assert.deepEqual(reviewData.payload.reviewScope.domains, ['workflow-contracts'])
    assert.equal(existsSync(path.join(latestDir, '__reg__', '1_actual', keptSnapshot)), true)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '1_actual', filteredSnapshot)), false)
    assert.equal(existsSync(path.join(latestDir, '__reg__', '1_actual', filteredPassedSnapshot)), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('publisher CLI does not baseline-approve a new test that reuses an approved snapshot image', () => {
  const repoRoot = process.cwd()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'visual-review-publisher-test-baseline-'))
  const reportDir = path.join(tempDir, 'visual-report')
  const actualDir = path.join(reportDir, '__reg__', '1_actual')
  const pagesDir = path.join(tempDir, 'pages')
  const snapshot = 'audit-widget--default.png'
  const imageContent = 'approved-png'
  const oldTestIdentity = {
    kind: 'playwright',
    sourceFile: 'tests/e2e/audit.spec.ts',
    testTitle: 'shows the old approved state',
    testTitlePath: ['audit.spec.ts', 'Audit widget', 'shows the old approved state'],
  }
  const oldTestKey = createHash('sha256').update(JSON.stringify(oldTestIdentity)).digest('hex')

  try {
    mkdirSync(actualDir, { recursive: true })
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(path.join(actualDir, snapshot), imageContent)
    writeFileSync(path.join(actualDir, 'audit-widget--default.visual.json'), `${JSON.stringify({
      version: 1,
      kind: 'playwright',
      name: 'audit-widget--default',
      sourceFile: 'tests/e2e/audit.spec.ts',
      test: {
        title: 'shows a new unapproved state',
        titlePath: ['audit.spec.ts', 'Audit widget', 'shows a new unapproved state'],
        sourceFile: 'tests/e2e/audit.spec.ts',
        line: 42,
      },
    }, null, 2)}\n`)
    const baselineEntry = {
      decision: 'approved',
      imageSha256: createHash('sha256').update(imageContent).digest('hex'),
      snapshot,
      sourcePrNumber: '11',
      sourcePrUrl: 'https://github.com/example/reusable-product/pull/11',
      sourceVariant: 'new',
      testIdentity: oldTestIdentity,
      testKey: oldTestKey,
    }
    writeFileSync(path.join(pagesDir, 'visual-baseline-state.json'), `${JSON.stringify({
      repository: 'example/reusable-product',
      schema: 'visual-review-pages.visual-baseline-state.v1',
      surfaces: {
        audit: {
          headSha: 'main-head',
          reportHref: 'https://example.github.io/reusable-product/audit/latest/',
          repository: 'example/reusable-product',
          snapshots: {
            [snapshot]: baselineEntry,
          },
          summary: {
            approved: 1,
            snapshots: 1,
            tests: 1,
          },
          surface: 'audit',
          surfaceLabel: 'Audit Screens',
          tests: {
            [oldTestKey]: baselineEntry,
          },
          updatedAt: '2026-05-05T00:00:00.000Z',
        },
      },
      updatedAt: '2026-05-05T00:00:00.000Z',
      version: 1,
    }, null, 2)}\n`)

    const payload = {
      actualDir: '__reg__/1_actual',
      deletedItems: [],
      diffDir: '__reg__/0_diff',
      expectedDir: '__reg__/2_expected',
      failedItems: [],
      newItems: [{ raw: snapshot, encoded: snapshot }],
      passedItems: [],
    }
    const reportFile = path.join(reportDir, 'audit.html')
    writeFileSync(reportFile, `<script>window['__reg__'] = ${JSON.stringify(payload)};</script>`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'publish-visual-review-pages.mjs'),
      '--surface',
      'audit',
      '--report-file',
      reportFile,
      '--pages-dir',
      pagesDir,
      '--repository',
      'example/reusable-product',
      '--pr-number',
      '12',
      '--head-ref',
      'feature/visuals',
      '--base-ref',
      'main',
      '--sha',
      'abcdef1234567890',
      '--run-id',
      '456',
      '--run-attempt',
      '1',
      '--base-url',
      'https://example.github.io/reusable-product',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: 'abcdef1234567890',
      },
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const latestDir = path.join(pagesDir, 'pr', '12', 'audit', 'latest')
    const reviewData = extractReviewData(readFileSync(path.join(latestDir, 'index.html'), 'utf8'))

    assert.equal(reviewData.payload.newItems.length, 1)
    assert.equal(reviewData.payload.passedItems.length, 0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('publisher retries rejected Pages pushes from a fresh remote snapshot', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'visual-review-publisher.mjs'), 'utf8')

  assert.match(source, /push rejected; refreshing/)
  assert.match(source, /reset', '--hard', 'FETCH_HEAD/)
  assert.doesNotMatch(source, /pull', '--rebase'/)
})
