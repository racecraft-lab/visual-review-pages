#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyBaselineReviewStateToPayload,
  buildSurfaceBaselineReviewState,
  mergeSurfaceBaselineReviewState,
} from './visual-review-baseline.mjs'
import {
  resolveInitialReviewStateSource,
} from './visual-review-producer.mjs'

const DEFAULT_SURFACES = {
  playwright: {
    label: 'Playwright UI E2E',
    workflowFile: 'playwright-visual.yml',
  },
  storybook: {
    label: 'Storybook Components',
    workflowFile: 'visual-storybook.yml',
  },
}

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`)
    }

    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }

    args[key] = next
    i += 1
  }

  return args
}

function readJsonIfPresent(filePath, fallback) {
  if (!filePath || !existsSync(filePath)) return fallback

  return readFile(filePath, 'utf8')
    .then((content) => JSON.parse(content))
    .catch(() => fallback)
}

async function readGitHubEvent() {
  return readJsonIfPresent(process.env.GITHUB_EVENT_PATH, {})
}

function repoParts(repository) {
  const [owner, repo] = String(repository || '').split('/')
  if (!owner || !repo) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo')
  }

  return { owner, repo }
}

function pageBaseUrl(repository, explicitBaseUrl) {
  if (explicitBaseUrl) return explicitBaseUrl.replace(/\/+$/, '')

  const { owner, repo } = repoParts(repository)
  return `https://${owner}.github.io/${repo}`
}

function githubServerUrl() {
  return process.env.GITHUB_SERVER_URL || 'https://github.com'
}

function githubApiUrl() {
  return process.env.GITHUB_API_URL || 'https://api.github.com'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  })

  if (result.status === 0) return result
  if (options.allowFailure) return result

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  throw new Error(`${command} ${args.join(' ')} failed${output ? `\n${output}` : ''}`)
}

function pagesGitEnv() {
  if (!process.env.VISUAL_REVIEW_PAGES_SSH_COMMAND) return undefined
  return {
    ...process.env,
    GIT_SSH_COMMAND: process.env.VISUAL_REVIEW_PAGES_SSH_COMMAND,
  }
}

function pagesRemoteUrl(repository, token) {
  if (process.env.VISUAL_REVIEW_PAGES_REMOTE_URL) {
    return process.env.VISUAL_REVIEW_PAGES_REMOTE_URL
  }

  if (process.env.VISUAL_REVIEW_PAGES_SSH_COMMAND) {
    return `git@github.com:${repository}.git`
  }

  if (!token) {
    throw new Error('GITHUB_TOKEN is required when --pages-dir is not provided')
  }

  return `https://x-access-token:${token}@github.com/${repository}.git`
}

function safeBranchName(branch) {
  return String(branch || 'unknown').replace(/[^\w./-]+/g, '-')
}

function titleFromToken(value) {
  return String(value || '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
}

function projectNameForOptions(options, repository) {
  if (options['project-name']) return options['project-name']
  if (process.env.VISUAL_REVIEW_PROJECT_NAME) return process.env.VISUAL_REVIEW_PROJECT_NAME
  if (process.env.MC_VISUAL_PROJECT_NAME) return process.env.MC_VISUAL_PROJECT_NAME
  return repoParts(repository).repo
}

function surfaceConfig(surface, options = {}) {
  const defaults = DEFAULT_SURFACES[surface] || {}
  return {
    label: options['surface-label'] || defaults.label || titleFromToken(surface) || surface,
    workflowFile: options['workflow-file'] || defaults.workflowFile || '',
  }
}

function surfaceLabelForReport(report) {
  return report.surfaceLabel || DEFAULT_SURFACES[report.surface]?.label || titleFromToken(report.surface) || report.surface
}

function scriptAssetUrl(fileName) {
  return new URL(`./${fileName}`, import.meta.url)
}

function rootAssetUrl(fileName) {
  return new URL(`../${fileName}`, import.meta.url)
}

function distAssetUrl(fileName) {
  return new URL(`../dist/${fileName}`, import.meta.url)
}

function extractReportPayload(reportHtml) {
  const match = reportHtml.match(/(window\[['"]__reg__['"]\]\s*=\s*)(\{[\s\S]*?\})(;\s*<\/script>)/)
  if (!match) {
    throw new Error('visual report does not contain window.__reg__ payload')
  }

  try {
    return {
      prefix: match[1],
      payload: JSON.parse(match[2]),
      suffix: match[3],
      token: match[0],
    }
  } catch (error) {
    throw new Error(`unable to parse visual report payload: ${error.message}`)
  }
}

function localizeReportAssetPaths(reportHtml, extracted, payload) {
  const localizedPayload = localizedReportPayload(payload)

  return reportHtml.replace(
    extracted.token,
    `${extracted.prefix}${JSON.stringify(localizedPayload)}${extracted.suffix}`
  )
}

function localizedReportPayload(payload) {
  return {
    ...payload,
    actualDir: './__reg__/1_actual',
    expectedDir: './__reg__/2_expected',
    diffDir: './__reg__/0_diff',
  }
}

function manifestFileName(fileName) {
  const parsed = path.parse(fileName)
  return parsed.dir ? `${parsed.dir}/${parsed.name}.visual.json` : `${parsed.name}.visual.json`
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function manifestPathCandidates(baseDir, fileName) {
  const candidates = [fileName]
  try {
    candidates.push(decodeURIComponent(fileName))
  } catch {
    // Keep the encoded candidate only.
  }
  return uniqueStrings(candidates).flatMap((candidate) => {
    try {
      return [resolveInside(baseDir, manifestFileName(candidate))]
    } catch {
      return []
    }
  })
}

function fallbackDisplayName(input) {
  return String(input || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
}

function annotationArray(value) {
  return Array.isArray(value)
    ? value
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        type: stringOrNull(entry.type) || 'note',
        description: stringOrNull(entry.description) || '',
      }))
    : []
}

function storyDisplayName(story, fallback) {
  const name = typeof story?.name === 'string' && story.name
    ? story.name
    : typeof story?.id === 'string'
      ? story.id.split('--').pop()
      : fallback
  return fallbackDisplayName(name)
}

function reviewMetadataFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const sourceFile = manifest.test?.sourceFile || manifest.story?.sourceFile || manifest.sourceFile || null
  const line = manifest.test?.line ? `:${manifest.test.line}` : ''
  const review = manifest.review && typeof manifest.review === 'object' ? manifest.review : {}
  const reviewTags = stringArray(review.tags)
  const manifestTags = stringArray(manifest.tags)

  if (manifest.kind === 'playwright') {
    const titlePath = Array.isArray(manifest.test?.titlePath)
      ? manifest.test.titlePath.filter(Boolean)
      : []
    return {
      description: stringOrNull(review.description) || '',
      domain: manifest.domain || null,
      expected: stringOrNull(review.expected) || '',
      focus: stringArray(review.focus),
      kind: manifest.kind,
      name: manifest.name || null,
      sourceFile: sourceFile ? `${sourceFile}${line}` : null,
      subtitle: titlePath.length > 1 ? titlePath.join(' > ') : sourceFile,
      tags: reviewTags.length ? reviewTags : manifestTags,
      testAnnotations: annotationArray(manifest.test?.annotations),
      testProjectName: stringOrNull(manifest.test?.projectName),
      testTitle: stringOrNull(manifest.test?.title),
      testTitlePath: titlePath,
      title: stringOrNull(review.title) || stringOrNull(manifest.test?.title) || fallbackDisplayName(manifest.name),
    }
  }

  if (manifest.kind === 'storybook') {
    const title = manifest.story?.title || manifest.name || null
    const storyName = storyDisplayName(manifest.story, manifest.name)
    const storyTags = stringArray(manifest.story?.tags)
    return {
      description: stringOrNull(review.description) || '',
      domain: manifest.domain || null,
      expected: stringOrNull(review.expected) || '',
      focus: stringArray(review.focus),
      kind: manifest.kind,
      name: manifest.name || null,
      sourceFile,
      subtitle: sourceFile,
      tags: reviewTags.length ? reviewTags : (storyTags.length ? storyTags : manifestTags),
      storyExportName: stringOrNull(manifest.story?.exportName),
      storyId: stringOrNull(manifest.story?.id),
      storyName,
      storyTitle: stringOrNull(title),
      title: stringOrNull(review.title) || (title && storyName ? `${title} / ${storyName}` : (title || storyName || null)),
    }
  }

  return {
    description: stringOrNull(review.description) || '',
    domain: manifest.domain || null,
    expected: stringOrNull(review.expected) || '',
    focus: stringArray(review.focus),
    kind: manifest.kind || null,
    name: manifest.name || null,
    sourceFile,
    subtitle: sourceFile,
    tags: reviewTags.length ? reviewTags : manifestTags,
    title: stringOrNull(review.title) || fallbackDisplayName(manifest.name),
  }
}

async function readVisualMetadata(baseDirs, fileName) {
  if (!fileName) return null
  for (const baseDir of baseDirs.filter(Boolean)) {
    for (const candidate of manifestPathCandidates(baseDir, fileName)) {
      if (!existsSync(candidate)) continue
      try {
        return reviewMetadataFromManifest(JSON.parse(await readFile(candidate, 'utf8')))
      } catch {
        return null
      }
    }
  }
  return null
}

async function attachVisualMetadata(items, baseDirs) {
  const enriched = []
  for (const item of items) {
    const fileName = itemFileName(item)
    const review = await readVisualMetadata(baseDirs, fileName)
    enriched.push(review ? { ...item, review } : item)
  }
  return enriched
}

function defaultManifestDir(surface) {
  const root = process.env.VISUAL_REVIEW_OUTPUT_DIR ||
    process.env.MC_VISUAL_OUTPUT_DIR ||
    path.join(process.cwd(), 'test-results', 'visual-current')
  return path.join(root, surface)
}

function manifestDirsForOptions(options) {
  return uniqueStrings([
    options['manifest-dir'],
    defaultManifestDir(options.surface),
  ])
}

async function enrichReportPayload(payload, reportDir, manifestDirs = []) {
  const actualDir = path.resolve(reportDir, payload.actualDir)
  const expectedDir = path.resolve(reportDir, payload.expectedDir)
  const externalManifestDirs = manifestDirs.filter((dir) => dir && existsSync(dir))

  return {
    ...payload,
    deletedItems: await attachVisualMetadata(reportItems(payload, 'deletedItems'), [
      expectedDir,
      actualDir,
      ...externalManifestDirs,
    ]),
    failedItems: await attachVisualMetadata(reportItems(payload, 'failedItems'), [
      actualDir,
      expectedDir,
      ...externalManifestDirs,
    ]),
    newItems: await attachVisualMetadata(reportItems(payload, 'newItems'), [
      actualDir,
      ...externalManifestDirs,
    ]),
    passedItems: await attachVisualMetadata(reportItems(payload, 'passedItems'), [
      actualDir,
      ...externalManifestDirs,
    ]),
  }
}

function escapeJsonScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function generateVisualReviewAppIndex({ context, payload }) {
  const title = `${context.surfaceLabel} Visual Review`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./visual-review-app.css" />
  </head>
  <body>
    <div id="visual-review-root"></div>
    <noscript>This visual review app requires JavaScript. Open reg-viz.html for the static fallback report.</noscript>
    <script id="visual-review-data" type="application/json">${escapeJsonScript({ context, payload })}</script>
    <script src="./visual-review-app.js" type="module"></script>
  </body>
</html>
`
}

function reportItems(payload, key) {
  return Array.isArray(payload[key]) ? payload[key] : []
}

function itemFileName(item) {
  const fileName = item?.encoded || item?.raw
  return typeof fileName === 'string' && fileName.length > 0 ? fileName : null
}

const IMAGE_FILE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif']

function imageFileNameCandidates(fileName) {
  const parsed = path.parse(fileName)
  const extensions = IMAGE_FILE_EXTENSIONS.filter((extension) => extension !== parsed.ext.toLowerCase())
  return extensions.map((extension) => {
    const candidate = `${parsed.name}${extension}`
    return parsed.dir ? `${parsed.dir}/${candidate}` : candidate
  })
}

function hasAssetFile(rootDir, fileName) {
  return existsSync(resolveInside(rootDir, fileName))
}

function resolveExistingAssetFile(sourceDirs, fileName) {
  if (!fileName) return fileName
  for (const sourceDir of sourceDirs) {
    if (existsSync(sourceDir) && hasAssetFile(sourceDir, fileName)) return fileName
  }

  for (const candidate of imageFileNameCandidates(fileName)) {
    for (const sourceDir of sourceDirs) {
      if (existsSync(sourceDir) && hasAssetFile(sourceDir, candidate)) return candidate
    }
  }

  return fileName
}

function itemWithFileName(item, fileName) {
  const current = itemFileName(item)
  if (!fileName || fileName === current) return item
  return {
    ...item,
    raw: fileName,
    encoded: fileName,
  }
}

function resolveReportAssetFileNames(payload, reportDir) {
  const actualDir = path.resolve(reportDir, payload.actualDir)
  const expectedDir = path.resolve(reportDir, payload.expectedDir)

  const resolveItems = (key, sourceDirs) => reportItems(payload, key).map((item) => {
    const fileName = itemFileName(item)
    return itemWithFileName(item, resolveExistingAssetFile(sourceDirs, fileName))
  })

  return {
    ...payload,
    deletedItems: resolveItems('deletedItems', [expectedDir]),
    failedItems: resolveItems('failedItems', [actualDir, expectedDir]),
    newItems: resolveItems('newItems', [actualDir]),
    passedItems: resolveItems('passedItems', [actualDir]),
  }
}

function diffFileName(item, payload) {
  const fileName = itemFileName(item)
  if (!fileName) return null

  const extension = String(payload.diffImageExtention || payload.diffImageExtension || 'webp')
    .replace(/^\./, '')
  const parsed = path.parse(fileName)
  return parsed.dir ? `${parsed.dir}/${parsed.name}.${extension}` : `${parsed.name}.${extension}`
}

function requiredAssetFiles(payload) {
  const newItems = reportItems(payload, 'newItems')
  const passedItems = reportItems(payload, 'passedItems')
  const failedItems = reportItems(payload, 'failedItems')
  const deletedItems = reportItems(payload, 'deletedItems')

  return {
    actual: [...newItems, ...passedItems, ...failedItems].map(itemFileName).filter(Boolean),
    expected: [...deletedItems, ...failedItems].map(itemFileName).filter(Boolean),
    diff: failedItems.map((item) => diffFileName(item, payload)).filter(Boolean),
  }
}

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`visual report asset escapes expected directory: ${relativePath}`)
  }
  return resolved
}

async function copyReportAssetDir({ label, sourceDir, targetDir, requiredFiles }) {
  if (!existsSync(sourceDir)) {
    if (requiredFiles.length > 0) {
      throw new Error(`missing ${label} visual image directory: ${sourceDir}`)
    }
    return
  }

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(path.dirname(targetDir), { recursive: true })
  await cp(sourceDir, targetDir, { recursive: true })

  const missing = requiredFiles.filter((fileName) => !existsSync(resolveInside(targetDir, fileName)))
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).join(', ')
    throw new Error(
      `missing ${missing.length.toString()} ${label} visual image file(s) after copy from ${sourceDir}: ${sample}`
    )
  }
}

async function writeReportBundle({ reportFile, reportHtml, extracted, targetDir, context, manifestDirs }) {
  const reportDir = path.dirname(reportFile)
  const payload = resolveReportAssetFileNames(extracted.payload, reportDir)
  const enrichedPayload = await enrichReportPayload(payload, reportDir, manifestDirs)
  const requiredFiles = requiredAssetFiles(payload)
  const assetRoot = path.join(targetDir, '__reg__')

  await mkdir(targetDir, { recursive: true })
  await copyReportAssetDir({
    label: 'actual',
    sourceDir: path.resolve(reportDir, payload.actualDir),
    targetDir: path.join(assetRoot, '1_actual'),
    requiredFiles: requiredFiles.actual,
  })
  await copyReportAssetDir({
    label: 'expected',
    sourceDir: path.resolve(reportDir, payload.expectedDir),
    targetDir: path.join(assetRoot, '2_expected'),
    requiredFiles: requiredFiles.expected,
  })
  await copyReportAssetDir({
    label: 'diff',
    sourceDir: path.resolve(reportDir, payload.diffDir),
    targetDir: path.join(assetRoot, '0_diff'),
    requiredFiles: requiredFiles.diff,
  })

  const localizedHtml = localizeReportAssetPaths(reportHtml, extracted, enrichedPayload)
  await writeFile(path.join(targetDir, 'reg-viz.html'), localizedHtml)
  await writeFile(
    path.join(targetDir, 'visual-review-app.css'),
    await readFile(scriptAssetUrl('visual-review-app.css'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'visual-review-app.js'),
    await readFile(scriptAssetUrl('visual-review-app.js'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'visual-review-state.mjs'),
    await readFile(scriptAssetUrl('visual-review-state.mjs'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'visual-review-annotations.mjs'),
    await readFile(scriptAssetUrl('visual-review-annotations.mjs'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'visual-review-heatmap.mjs'),
    await readFile(scriptAssetUrl('visual-review-heatmap.mjs'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'visual-annotation-app.js'),
    await readFile(distAssetUrl('visual-annotation-app.js'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'annotate.html'),
    await readFile(rootAssetUrl('annotate.html'), 'utf8')
  )
  await writeFile(
    path.join(targetDir, 'index.html'),
    generateVisualReviewAppIndex({
      context,
      payload: localizedReportPayload(enrichedPayload),
    })
  )
}

async function clonePagesBranch({ repository, token, branch }) {
  const pagesDir = await mkdtemp(path.join(os.tmpdir(), 'visual-review-pages-'))
  const remote = pagesRemoteUrl(repository, token)
  const clone = run('git', ['clone', '--depth', '1', '--branch', branch, remote, pagesDir], {
    allowFailure: true,
    env: pagesGitEnv(),
    quiet: true,
  })

  if (clone.status !== 0) {
    await rm(pagesDir, { recursive: true, force: true })
    throw new Error(`unable to clone ${branch} from ${repository}`)
  }

  return pagesDir
}

async function publishPagesChanges({ addPaths, branch, message, pagesDir, rewrite }) {
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: pagesDir })
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: pagesDir })

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      run('git', ['fetch', 'origin', branch], { cwd: pagesDir, env: pagesGitEnv() })
      run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: pagesDir })
      run('git', ['clean', '-fd'], { cwd: pagesDir })
      await rewrite()
    }

    run('git', ['add', ...addPaths], { cwd: pagesDir })
    const diff = run('git', ['diff', '--cached', '--quiet'], { cwd: pagesDir, allowFailure: true, quiet: true })
    if (diff.status === 0) {
      console.log('[visual-pr-pages] no Pages changes to publish')
      return
    }

    run('git', ['commit', '-m', message], { cwd: pagesDir })
    const push = run('git', ['push', 'origin', `HEAD:${branch}`], {
      cwd: pagesDir,
      allowFailure: true,
      env: pagesGitEnv(),
    })
    if (push.status === 0) return

    console.warn(`[visual-pr-pages] push rejected; refreshing ${branch} and retrying (${attempt}/3)`)
  }

  throw new Error(`unable to publish Pages changes to ${branch} after 3 attempts`)
}

async function readRegistry(registryPath) {
  const fallback = { version: 1, updatedAt: null, prs: [] }
  const registry = await readJsonIfPresent(registryPath, fallback)
  if (!Array.isArray(registry.prs)) registry.prs = []
  if (!registry.version) registry.version = 1
  return registry
}

function reportRow(report, current) {
  const activeClass = current ? ' class="current"' : ''
  const surface = surfaceLabelForReport(report)

  return [
    `<tr${activeClass}>`,
    `<td>${escapeHtml(surface)}</td>`,
    `<td><a href="${escapeHtml(report.reportHref)}">Open report</a></td>`,
    `<td><a href="${escapeHtml(report.runUrl)}">Run ${escapeHtml(report.runId)}</a></td>`,
    `<td><code>${escapeHtml(report.headSha.slice(0, 7))}</code></td>`,
    `<td>${escapeHtml(new Date(report.createdAt).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC</td>`,
    '</tr>',
  ].join('')
}

function indexThemeBootScript() {
  return `<script>
      (() => {
        try {
          const stored = localStorage.getItem('visual-review:theme')
          const theme = stored === 'dark' || stored === 'light'
            ? stored
            : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          document.documentElement.dataset.theme = theme
          document.documentElement.style.colorScheme = theme
        } catch {
          document.documentElement.dataset.theme = 'light'
          document.documentElement.style.colorScheme = 'light'
        }
      })()
    </script>`
}

function indexThemeRuntimeScript() {
  return `<script>
      (() => {
        const button = document.querySelector('[data-theme-toggle]')
        if (!button) return

        const applyTheme = (theme) => {
          document.documentElement.dataset.theme = theme
          document.documentElement.style.colorScheme = theme
          button.textContent = theme === 'dark' ? 'Light' : 'Dark'
          button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false')
          try {
            localStorage.setItem('visual-review:theme', theme)
          } catch {}
        }

        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
        button.addEventListener('click', () => {
          applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
        })
      })()
    </script>`
}

function indexThemeToggle() {
  return '<button class="theme-toggle" type="button" data-theme-toggle aria-pressed="false">Dark</button>'
}

function indexThemeCss() {
  return `
      :root[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0e121b;
        --panel: #151b27;
        --text: #eef4ff;
        --muted: #aab6c8;
        --line: #2a3546;
        --accent: #67d5df;
        --accent-dark: #7ee5ec;
        --warn: #f0bd62;
        --current: #102f36;
        --code-bg: #1b2331;
        --button-text: #071018;
        --control: #111827;
        --control-hover: #1a2433;
        --focus-ring: #4fc4cf;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          color-scheme: dark;
          --bg: #0e121b;
          --panel: #151b27;
          --text: #eef4ff;
          --muted: #aab6c8;
          --line: #2a3546;
          --accent: #67d5df;
          --accent-dark: #7ee5ec;
          --warn: #f0bd62;
          --current: #102f36;
          --code-bg: #1b2331;
          --button-text: #071018;
          --control: #111827;
          --control-hover: #1a2433;
          --focus-ring: #4fc4cf;
        }
      }
      .header-top {
        display: flex;
        gap: 16px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      .theme-toggle {
        flex: 0 0 auto;
        min-height: 38px;
        padding: 8px 14px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--control);
        color: var(--text);
        font: inherit;
        font-size: 14px;
        font-weight: 750;
        cursor: pointer;
      }
      .theme-toggle:hover {
        background: var(--control-hover);
        border-color: var(--accent);
      }
      .theme-toggle:focus-visible {
        outline: 3px solid var(--focus-ring);
        outline-offset: 2px;
      }
      @media (max-width: 720px) {
        .header-top { align-items: stretch; flex-direction: column; }
        .theme-toggle { width: 100%; }
      }`
}

function generatePrIndex({ meta, baseUrl, projectName }) {
  const latestBySurface = new Map()
  for (const report of meta.reports) {
    const current = latestBySurface.get(report.surface)
    if (!current || new Date(report.createdAt) > new Date(current.createdAt)) {
      latestBySurface.set(report.surface, report)
    }
  }

  const cards = Array.from(latestBySurface.values())
    .sort((a, b) => a.surface.localeCompare(b.surface))
    .map((report) => {
      const surface = surfaceLabelForReport(report)
      return `
        <article class="card">
          <p class="eyebrow">${escapeHtml(surface)}</p>
          <h2>Latest visual report</h2>
          <p>Use the review queue, filters, and diff modes to inspect baseline, current, and changed screenshots generated by the PR workflow.</p>
          <a class="button" href="${escapeHtml(report.latestHref)}">Open visual review</a>
          <a class="link" href="${escapeHtml(report.runUrl)}">Workflow run ${escapeHtml(report.runId)}</a>
        </article>
      `
    })
    .join('\n')

  const rows = meta.reports
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((report) => reportRow(report, latestBySurface.get(report.surface)?.runKey === report.runKey))
    .join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR #${escapeHtml(meta.prNumber)} ${escapeHtml(projectName)} Visual Review</title>
    ${indexThemeBootScript()}
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --text: #17202f;
        --muted: #5b6678;
        --line: #d9dee8;
        --accent: #0a7f86;
        --accent-dark: #065c62;
        --warn: #9a5b00;
        --current: #eef8f7;
        --code-bg: #eef1f6;
        --button-text: #ffffff;
        --control: #ffffff;
        --control-hover: #f7f9fc;
        --focus-ring: #8ac8ce;
      }
      ${indexThemeCss()}
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      header {
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }
      .wrap {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }
      .crumbs {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 13px;
      }
      a { color: var(--accent-dark); font-weight: 650; }
      h1 {
        margin: 0;
        font-size: 42px;
        line-height: 1.05;
        letter-spacing: 0;
      }
      .summary {
        max-width: 780px;
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 17px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }
      .card, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 20px;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent-dark);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h2 { margin: 0 0 10px; font-size: 20px; }
      p { margin: 0 0 14px; }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        padding: 8px 12px;
        margin: 4px 8px 4px 0;
        border-radius: 6px;
        background: var(--accent);
        color: var(--button-text);
        text-decoration: none;
      }
      .link {
        display: inline-flex;
        min-height: 38px;
        align-items: center;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      th, td {
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      tr.current td {
        background: var(--current);
      }
      code {
        padding: 2px 5px;
        border-radius: 5px;
        background: var(--code-bg);
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .note {
        border-left: 4px solid var(--warn);
        padding-left: 14px;
        color: var(--muted);
      }
      @media (max-width: 720px) {
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        td { padding: 10px 0; }
        tr { border-bottom: 1px solid var(--line); }
        h1 { font-size: 30px; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="wrap">
        <div class="header-top">
          <nav class="crumbs" aria-label="Breadcrumb">
            <a href="${escapeHtml(baseUrl)}/">${escapeHtml(projectName)} visual reviews</a>
            <span>/</span>
            <a href="${escapeHtml(baseUrl)}/pr/">PR reports</a>
          </nav>
          ${indexThemeToggle()}
        </div>
        <p class="eyebrow">Pull Request #${escapeHtml(meta.prNumber)}</p>
        <h1>${escapeHtml(meta.prTitle || `PR #${meta.prNumber}`)}</h1>
        <p class="summary">Reviewer-facing visual reports for <code>${escapeHtml(meta.headRef)}</code> into <code>${escapeHtml(meta.baseRef)}</code>. Open each latest report and inspect every changed baseline, current, diff, new, and removed image before approving UI changes.</p>
      </div>
    </header>
    <main class="wrap">
      <section class="grid" aria-label="Latest visual reports">
        ${cards || '<article class="card"><h2>No reports yet</h2><p>Visual report publishing has not completed for this PR.</p></article>'}
      </section>
      <section class="panel" style="margin-top: 16px;">
        <h2>Run History</h2>
        <p class="note">Each run hosts a visual review app plus a raw reg-viz fallback report. Images are copied into the report-local <code>__reg__</code> tree so reviewers can inspect baseline, current, and diff assets without downloading workflow artifacts.</p>
        <table>
          <thead>
            <tr>
              <th>Surface</th>
              <th>Report</th>
              <th>Workflow</th>
              <th>Commit</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5">No visual report runs recorded.</td></tr>'}
          </tbody>
        </table>
      </section>
    </main>
    ${indexThemeRuntimeScript()}
  </body>
</html>
`
}

function generateRegistryIndex(registry, baseUrl, projectName) {
  const rows = registry.prs
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((pr) => {
      const surfaces = Object.keys(pr.latest || {})
        .sort()
        .map((surface) => `<a href="${escapeHtml(pr.latest[surface].latestHref)}">${escapeHtml(surface)}</a>`)
        .join(' ')

      return `
        <tr>
          <td><a href="${escapeHtml(pr.indexHref)}">#${escapeHtml(pr.prNumber)}</a></td>
          <td>${escapeHtml(pr.prTitle || `PR #${pr.prNumber}`)}</td>
          <td>${surfaces || 'No reports'}</td>
          <td><code>${escapeHtml(pr.headRef)}</code></td>
          <td>${escapeHtml(new Date(pr.updatedAt).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC</td>
        </tr>
      `
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(projectName)} PR Visual Reports</title>
    ${indexThemeBootScript()}
    <style>
      :root { color-scheme: light; --bg: #f7f8fb; --panel: #fff; --text: #17202f; --muted: #5b6678; --line: #d9dee8; --accent: #0a7f86; --accent-dark: #065c62; --code-bg: #eef1f6; --control: #fff; --control-hover: #f7f9fc; --focus-ring: #8ac8ce; }
      ${indexThemeCss()}
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
      .wrap { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0; }
      header { background: var(--panel); border-bottom: 1px solid var(--line); }
      h1 { margin: 0; font-size: 40px; letter-spacing: 0; line-height: 1.08; }
      p { color: var(--muted); margin: 10px 0 0; max-width: 760px; }
      a { color: var(--accent-dark); font-weight: 650; }
      .panel { margin-top: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
      code { padding: 2px 5px; border-radius: 5px; background: var(--code-bg); font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      .crumbs { font-size: 13px; color: var(--muted); }
      @media (max-width: 720px) { table, thead, tbody, th, td, tr { display: block; } thead { display: none; } td { padding: 10px 0; } tr { border-bottom: 1px solid var(--line); } h1 { font-size: 30px; } }
    </style>
  </head>
  <body>
    <header>
      <div class="wrap">
        <div class="header-top">
          <nav class="crumbs"><a href="${escapeHtml(baseUrl)}/">${escapeHtml(projectName)} visual reviews</a> / PR reports</nav>
          ${indexThemeToggle()}
        </div>
        <h1>Pull Request Visual Reports</h1>
        <p>Latest PR visual comparison reports published from CI. Use these Pages links to review baseline, current, and diff images without downloading Actions artifacts.</p>
      </div>
    </header>
    <main class="wrap">
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>PR</th>
              <th>Title</th>
              <th>Latest Reports</th>
              <th>Head</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5">No PR visual reports have been published yet.</td></tr>'}
          </tbody>
        </table>
      </section>
    </main>
    ${indexThemeRuntimeScript()}
  </body>
</html>
`
}

function generateMainIndex(meta, baseUrl, projectName) {
  const latestBySurface = new Map()
  for (const report of meta.reports) {
    const current = latestBySurface.get(report.surface)
    if (!current || new Date(report.createdAt) > new Date(current.createdAt)) {
      latestBySurface.set(report.surface, report)
    }
  }

  const cards = Array.from(latestBySurface.values())
    .sort((a, b) => a.surface.localeCompare(b.surface))
    .map((report) => {
      const surface = surfaceLabelForReport(report)
      return `
        <article class="card">
          <p class="eyebrow">${escapeHtml(surface)}</p>
          <h2>Latest main report</h2>
          <p>Visual assets generated from the current <code>main</code> branch. Use this as the baseline reference when reviewing future pull requests.</p>
          <a class="button" href="${escapeHtml(report.latestHref)}">Open latest report</a>
          <a class="link" href="${escapeHtml(report.runUrl)}">Workflow run ${escapeHtml(report.runId)}</a>
        </article>
      `
    })
    .join('\n')

  const rows = meta.reports
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((report) => {
      const surface = surfaceLabelForReport(report)
      const current = latestBySurface.get(report.surface)?.reportKey === report.reportKey
      const activeClass = current ? ' class="current"' : ''
      return `
        <tr${activeClass}>
          <td>${escapeHtml(surface)}</td>
          <td><a href="${escapeHtml(report.reportHref)}">Open report</a></td>
          <td><a href="${escapeHtml(report.runUrl)}">Run ${escapeHtml(report.runId)}</a></td>
          <td><code>${escapeHtml(report.headSha.slice(0, 7))}</code></td>
          <td>${escapeHtml(new Date(report.createdAt).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC</td>
        </tr>
      `
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(projectName)} Main Branch Visual Reports</title>
    ${indexThemeBootScript()}
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --text: #17202f;
        --muted: #5b6678;
        --line: #d9dee8;
        --accent: #0a7f86;
        --accent-dark: #065c62;
        --current: #eef8f7;
        --code-bg: #eef1f6;
        --button-text: #ffffff;
        --control: #ffffff;
        --control-hover: #f7f9fc;
        --focus-ring: #8ac8ce;
      }
      ${indexThemeCss()}
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      header { border-bottom: 1px solid var(--line); background: var(--panel); }
      .wrap { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0; }
      .crumbs { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
      a { color: var(--accent-dark); font-weight: 650; }
      h1 { margin: 0; font-size: 40px; line-height: 1.08; letter-spacing: 0; }
      h2 { margin: 0 0 10px; font-size: 20px; }
      p { margin: 0 0 14px; color: var(--muted); }
      .summary { max-width: 780px; margin-top: 14px; font-size: 17px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
      .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
      .eyebrow { margin: 0 0 8px; color: var(--accent-dark); font-size: 12px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
      .button { display: inline-flex; min-height: 38px; align-items: center; justify-content: center; padding: 8px 12px; margin: 4px 8px 4px 0; border-radius: 6px; background: var(--accent); color: var(--button-text); text-decoration: none; }
      .link { display: inline-flex; min-height: 38px; align-items: center; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
      tr.current td { background: var(--current); }
      code { padding: 2px 5px; border-radius: 5px; background: var(--code-bg); font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (max-width: 720px) {
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        td { padding: 10px 0; }
        tr { border-bottom: 1px solid var(--line); }
        h1 { font-size: 30px; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="wrap">
        <div class="header-top">
          <nav class="crumbs" aria-label="Breadcrumb">
            <a href="${escapeHtml(baseUrl)}/">${escapeHtml(projectName)} visual reviews</a>
            <span>/</span>
            <a href="${escapeHtml(baseUrl)}/pr/">PR reports</a>
          </nav>
          ${indexThemeToggle()}
        </div>
        <p class="eyebrow">Main Branch</p>
        <h1>Main Branch Visual Reports</h1>
        <p class="summary">Latest visual reports generated from <code>main</code>. Pull request reports remain available from <a href="${escapeHtml(baseUrl)}/pr/">PR reports</a>.</p>
      </div>
    </header>
    <main class="wrap">
      <section class="grid" aria-label="Latest main visual reports">
        ${cards || '<article class="card"><h2>No main reports yet</h2><p>Main visual report publishing has not completed yet.</p></article>'}
      </section>
      <section class="panel" style="margin-top: 16px;">
        <h2>Run History</h2>
        <table>
          <thead>
            <tr>
              <th>Surface</th>
              <th>Report</th>
              <th>Workflow</th>
              <th>Commit</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5">No main visual reports have been published yet.</td></tr>'}
          </tbody>
        </table>
      </section>
    </main>
    ${indexThemeRuntimeScript()}
  </body>
</html>
`
}

function latestMapForReports(reports, baseUrl, prNumber) {
  const latest = {}
  for (const report of reports) {
    const current = latest[report.surface]
    if (!current || new Date(report.createdAt) > new Date(current.createdAt)) {
      latest[report.surface] = {
        runId: report.runId,
        runUrl: report.runUrl,
        latestHref: `${baseUrl}/pr/${prNumber}/${report.surface}/latest/`,
        reportHref: report.reportHref,
        updatedAt: report.createdAt,
      }
    }
  }
  return latest
}

async function publishReport(options) {
  const surface = options.surface
  if (!surface) {
    throw new Error('--surface is required')
  }

  const reportFile = options['report-file']
  if (!reportFile || !existsSync(reportFile)) {
    throw new Error(`visual report file not found: ${reportFile || '(missing --report-file)'}`)
  }

  const event = await readGitHubEvent()
  const repository = options.repository || process.env.GITHUB_REPOSITORY
  const projectName = projectNameForOptions(options, repository)
  const surfaceInfo = surfaceConfig(surface, options)
  const baseUrl = pageBaseUrl(
    repository,
    options['base-url'] || process.env.VISUAL_REVIEW_PAGES_BASE_URL || process.env.MC_VISUAL_PAGES_BASE_URL
  )
  const mode = options.mode || 'pr'
  if (!['pr', 'main'].includes(mode)) {
    throw new Error('--mode must be pr or main')
  }
  const prPayload = event.pull_request || {}
  const prNumber = String(options['pr-number'] || prPayload.number || '')
  if (mode === 'pr' && !prNumber) throw new Error('--pr-number or pull_request event payload is required')

  const branch = options.branch ||
    process.env.VISUAL_REVIEW_PAGES_BRANCH ||
    process.env.MC_VISUAL_PAGES_BRANCH ||
    'visual-regression-pages'
  const runId = String(options['run-id'] || process.env.GITHUB_RUN_ID || 'local')
  const runAttempt = String(options['run-attempt'] || process.env.GITHUB_RUN_ATTEMPT || '1')
  const runKey = `${runId}-attempt-${runAttempt}`
  const headRef = safeBranchName(options['head-ref'] || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || prPayload.head?.ref)
  const baseRef = safeBranchName(options['base-ref'] || process.env.GITHUB_BASE_REF || (mode === 'main' ? process.env.GITHUB_REF_NAME : prPayload.base?.ref))
  const headSha = String(options.sha || prPayload.head?.sha || process.env.GITHUB_SHA || 'unknown')
  const workflowName = options.workflow || process.env.GITHUB_WORKFLOW || surfaceInfo.label
  const runUrl = options['run-url'] || `${githubServerUrl()}/${repository}/actions/runs/${runId}`
  const prUrl = options['pr-url'] || prPayload.html_url || `${githubServerUrl()}/${repository}/pull/${prNumber}`
  const createdAt = new Date().toISOString()

  let pagesDir = options['pages-dir']
  let shouldCleanup = false
  if (!pagesDir) {
    const token = process.env.GITHUB_TOKEN
    pagesDir = await clonePagesBranch({ repository, token, branch })
    shouldCleanup = true
  }

  if (mode === 'main') {
    const reportHtml = await readFile(reportFile, 'utf8')
    const extractedReport = extractReportPayload(reportHtml)
    const reportDir = path.dirname(reportFile)
    const { sourcePullRequest, initialReviewState } = await resolveInitialReviewStateSource({
      options,
      event,
      repository,
      baseUrl,
      headSha,
      headRef,
      surface,
      payload: extractedReport.payload,
      githubApiUrl: githubApiUrl(),
      githubServerUrl: githubServerUrl(),
      token: process.env.GITHUB_TOKEN,
    })
    const reportKey = safeBranchName(options['report-key'] || headSha || runKey)
    const runReportDir = path.join(pagesDir, surface, reportKey)
    const latestReportDir = path.join(pagesDir, surface, 'latest')
    const reportHref = `${baseUrl}/${surface}/${reportKey}/`
    const latestHref = `${baseUrl}/${surface}/latest/`
    const manifestDirs = manifestDirsForOptions(options)
    const reviewContext = {
      repository,
      baseUrl,
      prNumber: sourcePullRequest?.number || '',
      prTitle: sourcePullRequest?.title || 'Main branch visual report',
      prUrl: sourcePullRequest?.url || '',
      prIndexHref: sourcePullRequest?.indexHref || `${baseUrl}/`,
      initialReviewState: initialReviewState?.state || null,
      initialReviewStateAuthor: initialReviewState?.author || '',
      initialReviewStateCommentId: initialReviewState?.commentId || null,
      reportMode: 'main',
      sourcePullRequest,
      surface,
      surfaceLabel: surfaceInfo.label,
      workflowName,
      workflowFile: surfaceInfo.workflowFile,
      runId,
      runAttempt,
      runKey,
      runUrl,
      headRef,
      baseRef,
      headSha,
      createdAt,
      regVizHref: './reg-viz.html',
    }
    const baselinePath = path.join(pagesDir, 'visual-baseline-state.json')

    const writeMainPages = async () => {
      await writeReportBundle({
        reportFile,
        reportHtml,
        extracted: extractedReport,
        targetDir: runReportDir,
        manifestDirs,
        context: {
          ...reviewContext,
          reportHref,
          reportScope: 'run',
        },
      })
      await writeReportBundle({
        reportFile,
        reportHtml,
        extracted: extractedReport,
        targetDir: latestReportDir,
        manifestDirs,
        context: {
          ...reviewContext,
          reportHref: latestHref,
          reportScope: 'latest',
        },
      })

      const metaPath = path.join(pagesDir, 'visual-main-runs.json')
      const meta = await readJsonIfPresent(metaPath, {
        version: 1,
        reports: [],
      })
      meta.version = 1
      meta.updatedAt = createdAt
      meta.reports = Array.isArray(meta.reports) ? meta.reports : []

      const reportRecord = {
        surface,
        runId,
        runAttempt,
        runKey,
        runUrl,
        reportKey,
        reportHref,
        latestHref,
        headSha,
        headRef,
        baseRef,
        workflowName,
        workflowFile: surfaceInfo.workflowFile,
        surfaceLabel: surfaceInfo.label,
        sourcePullRequest,
        createdAt,
      }

      meta.reports = [
        reportRecord,
        ...meta.reports.filter((report) => !(report.surface === surface && report.reportKey === reportKey)),
      ]

      await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)

      if (initialReviewState?.state) {
        const baselinePayload = await enrichReportPayload(extractedReport.payload, reportDir, manifestDirs)
        const surfaceBaseline = await buildSurfaceBaselineReviewState({
          context: {
            ...reviewContext,
            reportHref: latestHref,
          },
          initialReviewState: initialReviewState.state,
          payload: baselinePayload,
          reportDir,
          surface,
          surfaceLabel: surfaceInfo.label,
          updatedAt: createdAt,
        })
        const existingBaseline = await readJsonIfPresent(baselinePath, {
          repository,
          schema: 'visual-review-pages.visual-baseline-state.v1',
          surfaces: {},
          updatedAt: null,
          version: 1,
        })
        await writeFile(
          baselinePath,
          `${JSON.stringify(mergeSurfaceBaselineReviewState(existingBaseline, surfaceBaseline), null, 2)}\n`
        )
      }

      await writeFile(path.join(pagesDir, 'index.html'), generateMainIndex(meta, baseUrl, projectName))
    }

    await writeMainPages()

    if (!options['pages-dir']) {
      const addPaths = [surface, 'visual-main-runs.json', 'index.html']
      if (initialReviewState?.state) addPaths.push('visual-baseline-state.json')
      await publishPagesChanges({
        addPaths,
        branch,
        message: `docs: publish main ${surface} visual report`,
        pagesDir,
        rewrite: writeMainPages,
      })
    }

    console.log(`[visual-pr-pages] published ${surface} report: ${latestHref}`)

    if (shouldCleanup) {
      await rm(pagesDir, { recursive: true, force: true })
    }
    return
  }

  const prRoot = path.join(pagesDir, 'pr', prNumber)
  const runReportDir = path.join(prRoot, 'runs', runKey, surface)
  const latestReportDir = path.join(prRoot, surface, 'latest')
  const reportHtml = await readFile(reportFile, 'utf8')
  const extractedReport = extractReportPayload(reportHtml)
  const reportDir = path.dirname(reportFile)
  const manifestDirs = manifestDirsForOptions(options)
  const baselineState = await readJsonIfPresent(path.join(pagesDir, 'visual-baseline-state.json'), null)
  const baselineCandidatePayload = await enrichReportPayload(extractedReport.payload, reportDir, manifestDirs)
  const baselineFilteredPayload = await applyBaselineReviewStateToPayload({
    baselineReportDir: path.join(pagesDir, surface, 'latest'),
    baselineState,
    payload: baselineCandidatePayload,
    reportDir,
    surface,
  })
  const reportForPages = {
    ...extractedReport,
    payload: baselineFilteredPayload,
  }
  const baselineApprovedCount = reportItems(baselineFilteredPayload, 'baselineApprovedItems').length
  const reportHref = `${baseUrl}/pr/${prNumber}/runs/${runKey}/${surface}/`
  const latestHref = `${baseUrl}/pr/${prNumber}/${surface}/latest/`
  const reviewContext = {
    repository,
    baseUrl,
    prNumber,
    prTitle: prPayload.title || `PR #${prNumber}`,
    prUrl,
    prIndexHref: `${baseUrl}/pr/${prNumber}/`,
    surface,
    surfaceLabel: surfaceInfo.label,
    workflowName,
    workflowFile: surfaceInfo.workflowFile,
    runId,
    runAttempt,
    runKey,
    runUrl,
    headRef,
    baseRef,
    headSha,
    createdAt,
    baselineApprovedCount,
    regVizHref: './reg-viz.html',
  }

  const writePrPages = async () => {
    await writeReportBundle({
      reportFile,
      reportHtml,
      extracted: reportForPages,
      targetDir: runReportDir,
      manifestDirs,
      context: {
        ...reviewContext,
        reportHref,
        reportScope: 'run',
      },
    })
    await writeReportBundle({
      reportFile,
      reportHtml,
      extracted: reportForPages,
      targetDir: latestReportDir,
      manifestDirs,
      context: {
        ...reviewContext,
        reportHref: latestHref,
        reportScope: 'latest',
      },
    })

    const metaPath = path.join(prRoot, 'visual-runs.json')
    const meta = await readJsonIfPresent(metaPath, {
      version: 1,
      prNumber,
      prTitle: prPayload.title || `PR #${prNumber}`,
      prUrl,
      headRef,
      baseRef,
      reports: [],
    })

    meta.version = 1
    meta.prNumber = prNumber
    meta.prTitle = prPayload.title || meta.prTitle || `PR #${prNumber}`
    meta.prUrl = prUrl
    meta.headRef = headRef
    meta.baseRef = baseRef
    meta.updatedAt = createdAt
    meta.reports = Array.isArray(meta.reports) ? meta.reports : []

    const reportRecord = {
      surface,
      runId,
      runAttempt,
      runKey,
      runUrl,
      reportHref,
      latestHref,
      headSha,
      headRef,
      baseRef,
      workflowName,
      workflowFile: surfaceInfo.workflowFile,
      surfaceLabel: surfaceInfo.label,
      createdAt,
    }

    meta.reports = [
      reportRecord,
      ...meta.reports.filter((report) => !(report.surface === surface && report.runKey === runKey)),
    ]

    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    await writeFile(path.join(prRoot, 'index.html'), generatePrIndex({ meta, baseUrl, projectName }))

    const registryPath = path.join(pagesDir, 'pr', 'visual-reports.json')
    await mkdir(path.dirname(registryPath), { recursive: true })
    const registry = await readRegistry(registryPath)
    const indexHref = `${baseUrl}/pr/${prNumber}/`
    registry.updatedAt = createdAt
    registry.prs = [
      {
        prNumber,
        prTitle: meta.prTitle,
        prUrl,
        indexHref,
        headRef,
        baseRef,
        updatedAt: createdAt,
        latest: latestMapForReports(meta.reports, baseUrl, prNumber),
      },
      ...registry.prs.filter((pr) => String(pr.prNumber) !== prNumber),
    ]

    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
    await writeFile(path.join(pagesDir, 'pr', 'index.html'), generateRegistryIndex(registry, baseUrl, projectName))
  }

  await writePrPages()

  if (!options['pages-dir']) {
    await publishPagesChanges({
      addPaths: ['pr'],
      branch,
      message: `docs: publish PR ${prNumber} ${surface} visual report`,
      pagesDir,
      rewrite: writePrPages,
    })
  }

  console.log(`[visual-pr-pages] published ${surface} report: ${latestHref}`)

  if (shouldCleanup) {
    await rm(pagesDir, { recursive: true, force: true })
  }
}

publishReport(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`[visual-pr-pages] ${error.stack || error.message}`)
  process.exitCode = 1
})
