import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

export const VISUAL_REVIEW_BASELINE_SCHEMA = 'visual-review-pages.visual-baseline-state.v1'

const BASELINE_REVIEWABLE_VARIANTS = ['changed', 'new']
const BASELINE_REPORT_ACTUAL_DIR = '__reg__/1_actual'
const BASELINE_VISUAL_DIFF_THRESHOLD = 0

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
    if (testKey) {
      tests[testKey] = tests[testKey] || {
        decision: 'approved',
        group: entry.group,
        reviewer: entry.reviewer,
        sourceDecisionUpdatedAt: entry.sourceDecisionUpdatedAt,
        sourcePrNumber: entry.sourcePrNumber,
        sourcePrUrl: entry.sourcePrUrl,
        snapshots: {},
        testIdentity,
        testKey,
      }
      tests[testKey].snapshots[fileName] = entry
    }
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
  baselineReportDir,
  baselineState,
  payload,
  reportDir,
  surface,
  visualDiffThreshold = BASELINE_VISUAL_DIFF_THRESHOLD,
}) {
  const surfaceBaseline = baselineState?.surfaces?.[surface]
  if (!surfaceBaseline?.snapshots || typeof surfaceBaseline.snapshots !== 'object') {
    return payload
  }

  const approvalPlan = await baselineApprovalPlan({
    baseline: surfaceBaseline,
    baselineReportDir,
    payload,
    reportDir,
    visualDiffThreshold,
  })
  const baselineApprovedItems = []
  const failedItems = []
  for (const item of reportItems(payload, 'failedItems')) {
    const baselineEntry = approvalPlan.get(itemApprovalKey(item, 'changed'))
    if (baselineEntry) {
      baselineApprovedItems.push(baselinePassedItem(surfaceBaseline, item, 'changed', baselineEntry))
    } else {
      failedItems.push(item)
    }
  }

  const newItems = []
  for (const item of reportItems(payload, 'newItems')) {
    const baselineEntry = approvalPlan.get(itemApprovalKey(item, 'new'))
    if (baselineEntry) {
      baselineApprovedItems.push(baselinePassedItem(surfaceBaseline, item, 'new', baselineEntry))
    } else {
      newItems.push(itemWithBaselineReference(surfaceBaseline, payload, item))
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

export function applyReviewScopeToPayload({
  payload,
  reviewDomains = [],
}) {
  const domains = normalizeReviewDomains(reviewDomains)
  if (domains.length === 0) return payload

  const domainSet = new Set(domains)
  const reviewScopeFilteredItems = []
  const scopeItems = (items, variant) => {
    const scoped = []
    for (const item of reportItems(payload, items)) {
      if (itemMatchesReviewDomain(item, domainSet)) {
        scoped.push(item)
      } else {
        reviewScopeFilteredItems.push({ ...item, reviewScopeVariant: variant })
      }
    }
    return scoped
  }

  const failedItems = scopeItems('failedItems', 'changed')
  const newItems = scopeItems('newItems', 'new')
  const deletedItems = scopeItems('deletedItems', 'deleted')
  const passedItems = scopeItems('passedItems', 'passed')
  const baselineApprovedItems = scopeItems('baselineApprovedItems', 'baseline-approved')

  return {
    ...payload,
    baselineApprovedItems,
    deletedItems,
    failedItems,
    hasDeleted: deletedItems.length > 0,
    hasFailed: failedItems.length > 0,
    hasNew: newItems.length > 0,
    newItems,
    passedItems,
    reviewScope: {
      domains,
      filtered: reviewScopeFilteredItems.length,
    },
    reviewScopeFilteredItems,
  }
}

export function inferReviewDomainsFromChangedFiles({
  changedFiles = [],
  payload,
}) {
  const reviewableItems = [
    ...reportItems(payload, 'failedItems'),
    ...reportItems(payload, 'newItems'),
    ...reportItems(payload, 'deletedItems'),
  ]
  const domains = normalizeReviewDomains(reviewableItems.map(itemReviewDomain))
  if (domains.length === 0) return []

  const changedPaths = Array.isArray(changedFiles)
    ? changedFiles.map(normalizeRepoPath).filter(Boolean)
    : []
  if (changedPaths.length === 0) return []

  const changedPathSet = new Set(changedPaths)
  const domainsBySourceFile = normalizeReviewDomains(
    reviewableItems
      .filter((item) => changedPathSet.has(itemReviewSourceFile(item)))
      .map(itemReviewDomain)
  )
  if (domainsBySourceFile.length > 0) return domainsBySourceFile

  const changedText = changedPaths
    .filter(pathCanInferReviewDomain)
    .map((filePath) => normalizeDomainToken(filePath))
    .join('\n')
  if (!changedText) return []

  return domains.filter((domain) => {
    const token = normalizeDomainToken(domain)
    return token && changedText.includes(token)
  })
}

function baselinePassedItem(baseline, item, variant, baselineEntry = null) {
  const entry = baselineEntry || baselineEntryForItem(baseline, item) || {}
  return {
    ...item,
    baselineApproval: {
      baselineHeadSha: baseline.headSha || '',
      baselineReportHref: baseline.reportHref || '',
      imageSha256: entry.imageSha256 || '',
      sourcePrNumber: entry.sourcePrNumber || '',
      sourcePrUrl: entry.sourcePrUrl || '',
      sourceTestKey: entry.testKey || '',
      sourceVariant: entry.sourceVariant || variant,
      matchKind: entry.matchKind || 'hash',
    },
  }
}

function itemWithBaselineReference(baseline, payload, item) {
  const reference = baselineReferenceForItem(baseline, payload, item)
  return reference ? { ...item, baselineReference: reference } : item
}

function baselineReferenceForItem(baseline, payload, item) {
  const entry = baselineEntryForItem(baseline, item)
  const fileName = itemFileName(item)
  if (!entry || !fileName) return null

  return {
    baselineHeadSha: baseline.headSha || '',
    baselineReportHref: baseline.reportHref || '',
    imageHref: joinHref(baseline.reportHref, BASELINE_REPORT_ACTUAL_DIR, fileName),
    imageSha256: entry.imageSha256 || '',
    sourcePrNumber: entry.sourcePrNumber || '',
    sourcePrUrl: entry.sourcePrUrl || '',
    sourceTestKey: entry.testKey || '',
    sourceVariant: entry.sourceVariant || 'new',
  }
}

function baselineEntryForItem(baseline, item) {
  const testIdentity = itemTestIdentity(item)
  if (testIdentity) {
    const fileName = itemFileName(item)
    return testBaselineEntryForFile(baseline.tests?.[testIdentityKey(testIdentity)], fileName)
  }

  const fileName = itemFileName(item)
  return fileName ? baseline.snapshots?.[fileName] || null : null
}

async function baselineApprovalPlan({
  baseline,
  baselineReportDir,
  payload,
  reportDir,
  visualDiffThreshold,
}) {
  const plan = new Map()
  const candidates = [
    ...reportItems(payload, 'failedItems').map((item) => ({ item, variant: 'changed' })),
    ...reportItems(payload, 'newItems').map((item) => ({ item, variant: 'new' })),
  ]
  const grouped = new Map()

  for (const candidate of candidates) {
    const fileName = itemFileName(candidate.item)
    if (!fileName) continue

    const identity = itemTestIdentity(candidate.item)
    if (!identity) {
      const entry = baseline.snapshots?.[fileName]
      const match = await matchingBaselineEntry({
        allowVisualTolerance: candidate.variant === 'new',
        baselineReportDir,
        entry,
        fileName,
        payload,
        reportDir,
        visualDiffThreshold,
      })
      if (match) {
        plan.set(itemApprovalKey(candidate.item, candidate.variant), match)
      }
      continue
    }

    const testKey = testIdentityKey(identity)
    if (!grouped.has(testKey)) grouped.set(testKey, [])
    grouped.get(testKey).push({ ...candidate, fileName })
  }

  for (const [testKey, group] of grouped) {
    const testBaseline = baseline.tests?.[testKey]
    if (!testBaseline) continue

    const matches = []
    for (const candidate of group) {
      const entry = testBaselineEntryForFile(testBaseline, candidate.fileName)
      const match = await matchingBaselineEntry({
        allowVisualTolerance: candidate.variant === 'new',
        baselineReportDir,
        entry,
        fileName: candidate.fileName,
        payload,
        reportDir,
        visualDiffThreshold,
      })
      if (!match) {
        matches.length = 0
        break
      }
      matches.push({ ...candidate, entry: match })
    }

    for (const match of matches) {
      plan.set(itemApprovalKey(match.item, match.variant), match.entry)
    }
  }

  return plan
}

async function matchingBaselineEntry({
  allowVisualTolerance = false,
  baselineReportDir,
  entry,
  fileName,
  payload,
  reportDir,
  visualDiffThreshold,
}) {
  if (entry?.decision !== 'approved' || !entry.imageSha256) return null

  const currentPath = reportImagePath({ fileName, payload, reportDir })
  const currentSha = await hashFile(currentPath)
  if (currentSha && currentSha === entry.imageSha256) return { ...entry, matchKind: 'hash' }
  if (!allowVisualTolerance || !baselineReportDir || !currentSha) return null

  const baselinePath = baselineReportImagePath({ baselineReportDir, fileName })
  const diffRatio = pngPixelDiffRatio(currentPath, baselinePath)
  if (diffRatio !== null && diffRatio <= visualDiffThreshold) {
    return { ...entry, matchKind: 'visual-tolerance', visualDiffRatio: diffRatio }
  }

  return null
}

function testBaselineEntryForFile(testBaseline, fileName) {
  if (!testBaseline || !fileName) return null
  if (testBaseline.snapshots && typeof testBaseline.snapshots === 'object') {
    return testBaseline.snapshots[fileName] || null
  }

  return testBaseline.snapshot === fileName ? testBaseline : null
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
  return hashFile(reportImagePath({ fileName, payload, reportDir }))
}

async function hashFile(imagePath) {
  if (!existsSync(imagePath)) return ''

  const content = await readFile(imagePath)
  return createHash('sha256').update(content).digest('hex')
}

function reportImagePath({ fileName, payload, reportDir }) {
  const actualDir = path.resolve(reportDir, payload.actualDir || '')
  return resolveInside(actualDir, fileName)
}

function baselineReportImagePath({ baselineReportDir, fileName }) {
  return resolveInside(path.join(baselineReportDir, BASELINE_REPORT_ACTUAL_DIR), fileName)
}

function pngPixelDiffRatio(currentPath, baselinePath) {
  try {
    if (!existsSync(currentPath) || !existsSync(baselinePath)) return null

    const current = decodePngPixels(currentPath)
    const baseline = decodePngPixels(baselinePath)
    if (
      current.width !== baseline.width ||
      current.height !== baseline.height ||
      current.bytesPerPixel !== baseline.bytesPerPixel
    ) {
      return null
    }

    let diffPixels = 0
    for (let index = 0; index < current.pixels.length; index += current.bytesPerPixel) {
      for (let offset = 0; offset < current.bytesPerPixel; offset += 1) {
        if (current.pixels[index + offset] !== baseline.pixels[index + offset]) {
          diffPixels += 1
          break
        }
      }
    }

    return diffPixels / (current.width * current.height)
  } catch {
    return null
  }
}

function decodePngPixels(filePath) {
  const file = readFileSync(filePath)
  const signature = file.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') throw new Error('invalid PNG signature')

  const chunks = []
  const idatChunks = []
  let offset = 8
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.subarray(offset + 4, offset + 8).toString('ascii')
    const data = file.subarray(offset + 8, offset + 8 + length)
    chunks.push({ data, type })
    if (type === 'IDAT') idatChunks.push(data)
    offset += 12 + length
    if (type === 'IEND') break
  }

  const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data
  if (!header) throw new Error('missing PNG header')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bitDepth !== 8 || !bytesPerPixel) throw new Error(`unsupported PNG format: ${bitDepth}/${colorType}`)

  const inflated = inflateSync(Buffer.concat(idatChunks))
  const rowStride = width * bytesPerPixel
  const pixels = Buffer.alloc(height * rowStride)
  let readOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[readOffset]
    readOffset += 1
    const row = inflated.subarray(readOffset, readOffset + rowStride)
    readOffset += rowStride
    const output = pixels.subarray(y * rowStride, (y + 1) * rowStride)
    const previous = y > 0 ? pixels.subarray((y - 1) * rowStride, y * rowStride) : null

    for (let x = 0; x < rowStride; x += 1) {
      output[x] = (row[x] + pngFilterPrediction({ bytesPerPixel, filter, output, previous, x })) & 0xff
    }
  }

  return { bytesPerPixel, height, pixels, width }
}

function pngFilterPrediction({ bytesPerPixel, filter, output, previous, x }) {
  const left = x >= bytesPerPixel ? output[x - bytesPerPixel] : 0
  const above = previous ? previous[x] : 0
  const upperLeft = previous && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0

  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return above
  if (filter === 3) return Math.floor((left + above) / 2)
  if (filter !== 4) throw new Error(`unsupported PNG filter: ${filter}`)

  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

function reportItems(payload, key) {
  return Array.isArray(payload?.[key]) ? payload[key] : []
}

function itemMatchesReviewDomain(item, domainSet) {
  const domain = itemReviewDomain(item)
  if (domain && domainSet.has(domain)) return true

  const tags = Array.isArray(item?.review?.tags) ? item.review.tags : []
  return tags.some((tag) => domainSet.has(normalizeReviewDomain(tag)))
}

function itemReviewDomain(item) {
  return normalizeReviewDomain(item?.review?.domain || item?.visualMetadata?.domain || '')
}

function itemReviewSourceFile(item) {
  return normalizeRepoPath(item?.review?.sourceFile || item?.visualMetadata?.sourceFile || '')
}

function normalizeReviewDomains(values) {
  const entries = Array.isArray(values) ? values : String(values || '').split(/[,\n]/)
  return uniqueStrings(entries.map(normalizeReviewDomain))
}

function normalizeReviewDomain(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeDomainToken(value) {
  return normalizeReviewDomain(value).replace(/[^a-z0-9]+/g, '-')
}

function normalizeRepoPath(value) {
  return normalizeReviewDomain(value)
    .replace(/:\d+(?::\d+)?$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
}

function pathCanInferReviewDomain(value) {
  return /^(src|test|tests|stories|storybook|\.storybook)\//.test(value) ||
    /\.[cm]?[jt]sx?$/.test(value)
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function itemFileName(item) {
  const fileName = item?.encoded || item?.raw
  return typeof fileName === 'string' && fileName.length > 0 ? fileName : null
}

function reviewItemId(item, variant) {
  const fileName = itemFileName(item)
  return fileName ? `${variant}-${fileName}`.replace(/[=?&]/g, '-') : ''
}

function itemApprovalKey(item, variant) {
  return reviewItemId(item, variant)
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

function joinHref(base, ...parts) {
  const root = String(base || '').replace(/\/+$/, '')
  const suffix = parts
    .map((part) => String(part || '').replace(/^\.?\//, '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/')
  return suffix ? `${root}/${suffix}` : root
}

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`visual report asset escapes expected directory: ${relativePath}`)
  }
  return resolved
}
