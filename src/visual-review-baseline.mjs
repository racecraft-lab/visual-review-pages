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

  for (const { item, variant } of baselineCandidateItems(payload)) {
    const fileName = itemFileName(item)
    if (!fileName) continue

    const decision = approvedDecisionForItem(sourceSurface, item, variant)
    if (!decision) continue

    const imageSha256 = await hashReportImage({ fileName, payload, reportDir })
    if (!imageSha256) continue

    snapshots[fileName] = {
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
    }
  }

  const approved = Object.keys(snapshots).length
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
    },
    surface: String(surface || ''),
    surfaceLabel: String(surfaceLabel || surface || ''),
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

  const baselineEntry = baseline.snapshots[fileName]
  if (baselineEntry?.decision !== 'approved' || !baselineEntry.imageSha256) return false

  const currentSha = await hashReportImage({ fileName, payload, reportDir })
  return Boolean(currentSha && currentSha === baselineEntry.imageSha256)
}

function baselinePassedItem(baseline, item, variant) {
  const fileName = itemFileName(item)
  const baselineEntry = baseline.snapshots[fileName] || {}
  return {
    ...item,
    baselineApproval: {
      baselineHeadSha: baseline.headSha || '',
      baselineReportHref: baseline.reportHref || '',
      imageSha256: baselineEntry.imageSha256 || '',
      sourcePrNumber: baselineEntry.sourcePrNumber || '',
      sourcePrUrl: baselineEntry.sourcePrUrl || '',
      sourceVariant: baselineEntry.sourceVariant || variant,
    },
  }
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

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`visual report asset escapes expected directory: ${relativePath}`)
  }
  return resolved
}
