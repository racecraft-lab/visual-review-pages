import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const reportPath = 'pr/28/playwright/latest'
const baselinePath = 'playwright/latest'
const fixtureHeight = 90
const fixtureWidth = 160
const screenshotFile = 'heatmap-ready.png'

test('draws a heat map from a production baseline URL served by local Playwright', async ({ page }, testInfo) => {
  const fixture = await createHeatMapFixture()

  try {
    await page.goto(`${fixture.url}/${reportPath}/`)
    const heatMapToggle = page.getByRole('button', { exact: true, name: 'Heat map' })
    await expect(heatMapToggle).toBeEnabled()
    await heatMapToggle.click()
    await expect(page.locator('[data-heat-map-frame]')).toHaveAttribute('data-heat-map-state', 'ready')

    const canvasSummary = await page.locator('[data-heat-map-canvas]').evaluate((canvas) => {
      const context = canvas.getContext('2d')
      const changed = context.getImageData(72, 44, 1, 1).data
      const tiny = context.getImageData(12, 12, 1, 1).data
      const unchanged = context.getImageData(0, 0, 1, 1).data
      return {
        baselineSrc: canvas.dataset.baselineSrc,
        changed: Array.from(changed),
        height: canvas.height,
        state: canvas.closest('[data-heat-map-frame]')?.dataset.heatMapState,
        tiny: Array.from(tiny),
        unchanged: Array.from(unchanged),
        width: canvas.width,
      }
    })

    expect(canvasSummary.state).toBe('ready')
    expect(canvasSummary.width).toBe(fixtureWidth)
    expect(canvasSummary.height).toBe(fixtureHeight)
    expect(canvasSummary.baselineSrc).toBe(`${fixture.url}/${baselinePath}/__reg__/1_actual/heatmap/changed.png`)
    expect(canvasSummary.changed[0]).toBe(255)
    expect(canvasSummary.changed[3]).toBeGreaterThan(0)
    expect(canvasSummary.tiny[3]).toBe(0)
    expect(canvasSummary.unchanged[3]).toBe(0)

    await page.locator('[data-heat-map-frame]').screenshot({ path: testInfo.outputPath(screenshotFile) })
  } finally {
    await fixture.close()
  }
})

test('keeps the heat map toggle scoped to the active image', async ({ page }) => {
  const fixture = await createHeatMapFixture()

  try {
    await page.goto(`${fixture.url}/${reportPath}/`)
    await page.getByRole('button', { exact: true, name: 'Heat map' }).click()
    await expect(page.locator('[data-heat-map-frame]')).toHaveAttribute('data-heat-map-state', 'ready')

    await page.getByRole('button', { name: /^All / }).click()
    await page.getByRole('button', { name: /Unchanged passed screen/ }).click()
    await expect(page.getByRole('button', { exact: true, name: 'Heat map' })).toBeDisabled()
    await expect(page.locator('[data-heat-map-canvas]')).toHaveCount(0)

    await page.getByRole('button', { name: /Heat map changed screen/ }).click()
    await expect(page.getByRole('button', { exact: true, name: 'Heat map' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-heat-map-frame]')).toHaveAttribute('data-heat-map-state', 'ready')
  } finally {
    await fixture.close()
  }
})

test('keeps scroll and zoom stable while toggling heat map controls', async ({ page }) => {
  const fixture = await createHeatMapFixture()

  try {
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto(`${fixture.url}/${reportPath}/`)
    await page.addStyleTag({
      content: `
        .stage {
          width: 360px;
          height: 180px;
          min-height: 0;
        }
        .stage-inner {
          place-items: start;
        }
      `,
    })

    const zoom = page.locator('[data-action="zoom"]')
    await zoom.evaluate((input) => {
      input.value = '200'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(page.locator('[data-zoom-value]')).toHaveText('200%')
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.stage img'))
      .every((image) => image.complete && image.naturalWidth > 0))

    const stage = page.locator('.stage')
    const before = await stage.evaluate((element) => {
      element.scrollLeft = 220
      element.scrollTop = 90
      return {
        left: element.scrollLeft,
        maxLeft: element.scrollWidth - element.clientWidth,
        maxTop: element.scrollHeight - element.clientHeight,
        top: element.scrollTop,
      }
    })
    expect(before.maxLeft).toBeGreaterThan(0)
    expect(before.maxTop).toBeGreaterThan(0)
    expect(before.left).toBeGreaterThan(0)
    expect(before.top).toBeGreaterThan(0)

    const heatMapToggle = page.getByRole('button', { exact: true, name: 'Heat map' })
    await heatMapToggle.click()
    await expect(page.locator('[data-heat-map-frame]')).toHaveAttribute('data-heat-map-state', 'ready')
    await expect(page.locator('[data-zoom-value]')).toHaveText('200%')

    const afterToggle = await stage.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }))
    expect(afterToggle).toEqual({ left: before.left, top: before.top })
    await expect(page.locator('[data-heat-map-status]')).toHaveText('On')

    const intensity = page.locator('[data-action="heat-map-intensity"]')
    await expect(intensity).toBeEnabled()
    await intensity.evaluate((input) => {
      input.value = '50'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(page.locator('[data-heat-map-intensity-value]')).toHaveText('50%')
    await expect(page.locator('[data-heat-map-canvas]')).toHaveCSS('opacity', '0.5')

    const afterIntensity = await stage.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }))
    expect(afterIntensity).toEqual({ left: before.left, top: before.top })
  } finally {
    await fixture.close()
  }
})

test('uses floating stage controls and fits initial zoom to the image view', async ({ page }) => {
  const fixture = await createHeatMapFixture({
    changedTitle: 'Product Line / Visual States: Header Desktop Facility',
  })

  try {
    await page.setViewportSize({ width: 1512, height: 900 })
    await page.addInitScript(() => {
      localStorage.setItem('visual-review:28:playwright:latest:abc1234:zoom', '177')
    })
    await page.goto(`${fixture.url}/${reportPath}/`)
    await expect(page.getByRole('button', { exact: true, name: 'Heat map' })).toBeVisible()
    await expect(page.locator('[data-zoom-value]')).toHaveText('100%')
    await expect(page.locator('.viewer-toolbar .toolbar-controls')).toHaveCount(0)
    await expect(page.locator('[data-stage-controls] .toolbar-controls')).toBeVisible()
    await page.getByRole('button', { exact: true, name: 'Heat map' }).click()
    await page.addStyleTag({
      content: `
        .stage {
          width: 120px;
          height: 180px;
          min-height: 0;
        }
        .stage-shell {
          width: 120px;
        }
        .stage-inner {
          place-items: start;
        }
      `,
    })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-zoom-value]')?.textContent || '100', 10) < 100)

    const metrics = await page.locator('.viewer-card').evaluate((viewer) => {
      const toolbar = viewer.querySelector('.viewer-toolbar')
      const stage = viewer.querySelector('.stage')
      const heading = toolbar.querySelector('.snapshot-heading')
      const title = toolbar.querySelector('.snapshot-heading h2')
      const controls = viewer.querySelector('[data-stage-controls] .toolbar-controls')
      const controlChildren = Array.from(controls.children)
      const headingRect = heading.getBoundingClientRect()
      const titleRect = title.getBoundingClientRect()
      const controlsRect = controls.getBoundingClientRect()
      const stageRect = stage.getBoundingClientRect()
      const childrenRect = controlChildren.reduce((bounds, child) => {
        const rect = child.getBoundingClientRect()
        return {
          bottom: Math.max(bounds.bottom, rect.bottom),
          left: Math.min(bounds.left, rect.left),
          right: Math.max(bounds.right, rect.right),
          top: Math.min(bounds.top, rect.top),
        }
      }, { bottom: -Infinity, left: Infinity, right: -Infinity, top: Infinity })
      const controlsCenter = controlsRect.left + controlsRect.width / 2
      const childrenCenter = childrenRect.left + (childrenRect.right - childrenRect.left) / 2
      const stageCenter = stageRect.left + stageRect.width / 2
      return {
        centerOffset: Math.round(Math.abs(controlsCenter - childrenCenter)),
        controlsOutsideScroll: !stage.contains(controls),
        controlsStageOffset: Math.round(Math.abs(stageCenter - controlsCenter)),
        controlsTop: Math.round(controlsRect.top),
        stageTop: Math.round(stageRect.top),
        headingTop: Math.round(headingRect.top),
        headingWidth: Math.round(headingRect.width),
        titleHeight: Math.round(titleRect.height),
        titleText: title.textContent,
        zoomText: viewer.querySelector('[data-zoom-value]').textContent,
        toolbarWidth: Math.round(toolbar.getBoundingClientRect().width),
      }
    })

    expect(metrics.titleText).toBe('Product Line / Visual States: Header Desktop Facility')
    expect(metrics.toolbarWidth).toBeGreaterThanOrEqual(560)
    expect(metrics.headingWidth).toBeGreaterThan(280)
    expect(metrics.titleHeight).toBeLessThan(70)
    expect(Number.parseInt(metrics.zoomText, 10)).toBeLessThan(100)
    expect(metrics.controlsOutsideScroll).toBe(true)
    expect(metrics.centerOffset).toBeLessThanOrEqual(2)
    expect(metrics.controlsStageOffset).toBeLessThanOrEqual(2)
    expect(metrics.controlsTop).toBeGreaterThanOrEqual(metrics.stageTop)
    expect(metrics.controlsTop).toBeGreaterThan(metrics.headingTop)
  } finally {
    await fixture.close()
  }
})

async function createHeatMapFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'visual-review-heatmap-'))
  const reportRoot = path.join(root, reportPath)
  const baselineRoot = path.join(root, baselinePath)
  await mkdir(reportRoot, { recursive: true })
  await mkdir(baselineRoot, { recursive: true })
  await Promise.all([
    copyAppAsset('visual-review-app.js', reportRoot),
    copyAppAsset('visual-review-app.css', reportRoot),
    copyAppAsset('visual-review-annotations.mjs', reportRoot),
    copyAppAsset('visual-review-heatmap.mjs', reportRoot),
    copyAppAsset('visual-review-state.mjs', reportRoot),
  ])

  await writeFixtureImages({ baselineRoot, reportRoot })
  await writeFile(path.join(reportRoot, 'index.html'), renderReportHtml(options), 'utf8')
  const server = await serveStatic(root)
  return {
    url: server.url,
    close: async () => {
      await server.close()
      await rm(root, { force: true, recursive: true })
    },
  }
}

async function copyAppAsset(fileName, reportRoot) {
  await cp(path.join(repoRoot, 'src', fileName), path.join(reportRoot, fileName))
}

async function writeFixtureImages({ baselineRoot, reportRoot }) {
  const baselineImage = pngBuffer(fixtureWidth, fixtureHeight, () => [48, 48, 48, 255])
  const changedImage = pngBuffer(fixtureWidth, fixtureHeight, (x, y) => {
    if (x >= 48 && x <= 104 && y >= 28 && y <= 62) return [255, 20, 20, 255]
    if (x === 12 && y === 12) return [55, 55, 55, 255]
    return [48, 48, 48, 255]
  })
  const passedImage = pngBuffer(fixtureWidth, fixtureHeight, () => [80, 100, 140, 255])
  await Promise.all([
    writeImage(path.join(baselineRoot, '__reg__/1_actual/heatmap/changed.png'), baselineImage),
    writeImage(path.join(reportRoot, '__reg__/1_actual/heatmap/changed.png'), changedImage),
    writeImage(path.join(reportRoot, '__reg__/1_actual/heatmap/passed.png'), passedImage),
  ])
}

async function writeImage(filePath, buffer) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, buffer)
}

function renderReportHtml(options = {}) {
  const changedTitle = options.changedTitle || 'Heat map changed screen'
  const data = {
    context: {
      baseRef: 'main',
      baseUrl: 'https://example.invalid/mission-control',
      headRef: 'feature/heatmap',
      headSha: 'abc1234',
      prIndexHref: '#',
      prNumber: 28,
      prTitle: 'Heat map Playwright QA',
      repository: 'racecraft-lab/mission-control',
      runId: 'latest',
      runKey: 'latest',
      surface: 'playwright',
      surfaceLabel: 'Playwright',
    },
    payload: {
      actualDir: './__reg__/1_actual',
      diffDir: './__reg__/0_diff',
      expectedDir: './__reg__/2_expected',
      newItems: [
        {
          raw: 'heatmap/changed.png',
          encoded: 'heatmap/changed.png',
          baselineReference: {
            baselineReportHref: 'https://example.invalid/mission-control/playwright/latest/',
            imageHref: 'https://example.invalid/mission-control/playwright/latest/__reg__/1_actual/heatmap/changed.png',
          },
          review: {
            domain: 'heatmap',
            sourceFile: 'tests/heatmap.spec.ts:10',
            title: changedTitle,
          },
        },
      ],
      passedItems: [
        {
          raw: 'heatmap/passed.png',
          encoded: 'heatmap/passed.png',
          review: {
            domain: 'heatmap',
            sourceFile: 'tests/heatmap.spec.ts:30',
            title: 'Unchanged passed screen',
          },
        },
      ],
    },
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Visual Review Heat Map Fixture</title>
    <link rel="stylesheet" href="./visual-review-app.css" />
  </head>
  <body>
    <div id="visual-review-root"></div>
    <script id="visual-review-data" type="application/json">${escapeJsonForScript(data)}</script>
    <script type="module" src="./visual-review-app.js"></script>
  </body>
</html>
`
}

function escapeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function pngBuffer(width, height, colorForPixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = colorForPixel(x, y)
      const offset = row + 1 + x * 4
      raw[offset] = pixel[0]
      raw[offset + 1] = pixel[1]
      raw[offset + 2] = pixel[2]
      raw[offset + 3] = pixel[3]
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const crcInput = Buffer.concat([typeBuffer, data])
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(crcInput)),
  ])
}

function uint32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0)
  return buffer
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function serveStatic(root) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const pathName = decodeURIComponent(url.pathname)
      const requested = pathName.endsWith('/') ? `${pathName}index.html` : pathName
      const filePath = path.join(root, requested)
      const relative = path.relative(root, filePath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      const body = await readFile(filePath)
      response.writeHead(200, { 'content-type': contentType(filePath) })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('Not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}
