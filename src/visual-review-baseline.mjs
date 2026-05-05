import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const VISUAL_REVIEW_BASELINE_SCHEMA = 'visual-review-pages.visual-baseline-state.v1'

const BASELINE_REVIEWABLE_VARIANTS = ['changed', 'new']

export async function buildSurfaceBaselineReviewState({
  context = {},
  initialReviewState,
  payload,
  reportDir,
  surface,
  surfaceLabel = surface,
  updatedAt = new Date().toISOString(),
}) {
  const sourceSurface = initialReviewState?.surfaces?.[surface]
  const snapshots = {}
  const tests = {}

  for (const { item, variant } of baselineCandidateItems(payload)) {
    const fileName = itemFileName(item)
    if (!fileName) continue

    const decision = approvedDecisionForItem(sourceSurface, item, variant)
    if (!decision) continue

    const imageSha256 = await hashReportImage({ fileName, payload, reportDir })
    if (!imageSha256) continue

    const testIdentity = itemTestIdentity(item)
    const testKey = testIdentity ? testIdentityKey(testIdentity) : ''
    const entry = {
      decision: 'approved',
      group: String(decision.group || item.review?.domain || item.visualMetadata?.domain || 'ungrouped'),
      imageSha256,
      itemId: reviewItemId(item, variant),
      reviewer: String(decision.reviewer || ''),
      snapshot: fileName,
      sourceDecisionUpdatedAt: decision.updatedAt || null,
      sourcePrNumber: String(initialReviewState?.prNumber || context.sourcePullRequest?.number || ''),
      sourcePrUrl: String(initialReviewState?.prUrl || context.sourcePullRequest?.url || ''),
      sourceVariant: String(decision.variant || variant),
      testIdentity,
      testKey,
    }
    snapshots[fileName] = entry
    if (testKey) tests[testKey] = entry
  }

  const approved = Object.keys(snapshots).length
  const approvedTests = Object.keys(tests).length
  return {
    baseRef: String(context.baseRef || ''),
    headRef: String(context.headRef || ''),
    headSha: String(context.headSha || ''),
    reportHref: String(context.reportHref || ''),
    repository: String(context.repository || ''),
    snapshots,
    sourcePullRequest: context.sourcePullRequest || null,
    summary: {
      approved,
      snapshots: approved,
      tests: approvedTests,
    },
    surface: String(surface || ''),
    surfaceLabel: String(surfaceLabel || surface || ''),
    tests,
    updatedAt,
  }
}

export function mergeSurfaceBaselineReviewState(existingState, surfaceState) {
  return {
    repository: String(surfaceState.repository || existingState?.repository || ''),
    schema: VISUAL_REVIEW_BASELINE_SCHEMA,
    surfaces: {
      ...(existingState?.surfaces && typeof existingState.surfaces === 'object' ? existingState.surfaces : {}),
      [surfaceState.surface]: surfaceState,
    },
    updatedAt: surfaceState.updatedAt,
    version: 1,
  }
}

export async function applyBaselineReviewStateToPayload({
  baselineState,
  payload,
  reportDir,
  surface,
}) {
  const surfaceBaseline = baselineState?.surfaces?.[surface]
  if (!surfaceBaseline?.snapshots || typeof surfaceBaseline.snapshots !== 'object') {
    return payload
  }

  const baselineApprovedItems = []
  const failedItems = []
  for (const item of reportItems(payload, 'failedItems')) {
    if (await isBaselineApprovedItem({ baseline: surfaceBaseline, item, payload, reportDir, variant: 'changed' })) {
      baselineApprovedItems.push(baselinePassedItem(surfaceBaseline, item, 'changed'))
    } else {
      failedItems.push(item)
    }
  }

  const newItems = []
  for (const item of reportItems(payload, 'newItems')) {
    if (await isBaselineApprovedItem({ baseline: surfaceBaseline, item, payload, reportDir, variant: 'new' })) {
      baselineApprovedItems.push(baselinePassedItem(surfaceBaseline, item, 'new'))
    } else {
      newItems.push(item)
    }
  }

  return {
    ...payload,
    baselineApprovedItems,
    failedItems,
    newItems,
    passedItems: [
      ...reportItems(payload, 'passedItems'),
      ...baselineApprovedItems,
    ],
  }
}

async function isBaselineApprovedItem({ baseline, item, payload, reportDir, variant }) {
  const fileName = itemFileName(item)
  if (!fileName) return false

  const baselineEntry = baselineEntryForItem(baseline, item)
  if (baselineEntry?.decision !== 'approved' || !baselineEntry.imageSha256) return false

  const currentSha = await hashReportImage({ fileName, payload, reportDir })
  return Boolean(currentSha && currentSha === baselineEntry.imageSha256)
}

function baselinePassedItem(baseline, item, variant) {
  const baselineEntry = baselineEntryForItem(baseline, item) || {}
  return {
    ...item,
    baselineApproval: {
      baselineHeadSha: baseline.headSha || '',
      baselineReportHref: baseline.reportHref || '',
      imageSha256: baselineEntry.imageSha256 || '',
      sourcePrNumber: baselineEntry.sourcePrNumber || '',
      sourcePrUrl: baselineEntry.sourcePrUrl || '',
      sourceTestKey: baselineEntry.testKey || '',
      sourceVariant: baselineEntry.sourceVariant || variant,
    },
  }
}

function baselineEntryForItem(baseline, item) {
  const testIdentity = itemTestIdentity(item)
  if (testIdentity) {
    return baseline.tests?.[testIdentityKey(testIdentity)] || null
  }

  const fileName = itemFileName(item)
  return fileName ? baseline.snapshots?.[fileName] || null : null
}

function approvedDecisionForItem(surfaceState, item, variant) {
  if (!surfaceState?.decisions || typeof surfaceState.decisions !== 'object') return null

  const exact = surfaceState.decisions[reviewItemId(item, variant)]
  if (exact?.decision === 'approved') return exact

  const fileName = itemFileName(item)
  return Object.values(surfaceState.decisions).find((decision) => (
    decision?.decision === 'approved' &&
    String(decision.snapshot || '') === fileName
  )) || null
}

function baselineCandidateItems(payload) {
  return BASELINE_REVIEWABLE_VARIANTS.flatMap((variant) => (
    reportItems(payload, variant === 'changed' ? 'failedItems' : 'newItems')
      .map((item) => ({ item, variant }))
  ))
}

async function hashReportImage({ fileName, payload, reportDir }) {
  const actualDir = path.resolve(reportDir, payload.actualDir || '')
  const imagePath = resolveInside(actualDir, fileName)
  if (!existsSync(imagePath)) return ''

  const content = await readFile(imagePath)
  return createHash('sha256').update(content).digest('hex')
}

function reportItems(payload, key) {
  return Array.isArray(payload?.[key]) ? payload[key] : []
}

function itemFileName(item) {
  const fileName = item?.encoded || item?.raw
  return typeof fileName === 'string' && fileName.length > 0 ? fileName : null
}

function reviewItemId(item, variant) {
  const fileName = itemFileName(item)
  return fileName ? `${variant}-${fileName}`.replace(/[=?&]/g, '-') : ''
}

function itemTestIdentity(item) {
  const review = item?.review && typeof item.review === 'object' ? item.review : null
  if (!review) return null

  const kind = stringOrNull(review.kind) || 'visual'
  const sourceFile = normalizedSourceFile(review.sourceFile || review.subtitle)

  if (kind === 'playwright') {
    const testTitlePath = stringArray(review.testTitlePath)
    const testTitle = stringOrNull(review.testTitle) || stringOrNull(review.title) || testTitlePath.at(-1) || ''
    if (!sourceFile && testTitlePath.length === 0 && !testTitle) return null

    return compactIdentity({
      kind,
      sourceFile,
      testProjectName: stringOrNull(review.testProjectName) || '',
      testTitle,
      testTitlePath,
    })
  }

  if (kind === 'storybook') {
    const storyId = stringOrNull(review.storyId)
    const storyExportName = stringOrNull(review.storyExportName)
    const storyName = stringOrNull(review.storyName)
    const storyTitle = stringOrNull(review.storyTitle)
    if (!storyId && !sourceFile && !storyExportName && !storyName && !storyTitle) return null

    return compactIdentity({
      kind,
      sourceFile,
      storyExportName: storyExportName || '',
      storyId: storyId || '',
      storyName: storyName || '',
      storyTitle: storyTitle || '',
    })
  }

  const name = stringOrNull(review.name)
  const title = stringOrNull(review.title)
  if (!sourceFile && !name && !title) return null

  return compactIdentity({
    kind,
    name: name || '',
    sourceFile,
    title: title || '',
  })
}

function testIdentityKey(identity) {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function compactIdentity(identity) {
  return Object.fromEntries(
    Object.entries(identity).filter(([, value]) => (
      Array.isArray(value) ? value.length > 0 : value !== ''
    ))
  )
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
}

function normalizedSourceFile(value) {
  const sourceFile = stringOrNull(value)
  return sourceFile ? sourceFile.replace(/:\d+(?::\d+)?$/, '') : ''
}

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`visual report asset escapes expected directory: ${relativePath}`)
  }
  return resolved
}
