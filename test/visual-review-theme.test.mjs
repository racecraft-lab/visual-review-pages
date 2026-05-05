import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function read(relativePath) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('review queue and annotation pages share a persistent light/dark theme control', () => {
  const css = read('src/visual-review-app.css')
  const queueApp = read('src/visual-review-app.js')
  const annotationApp = read('src/visual-annotation-app.jsx')

  assert.match(css, /:root\[data-theme="dark"\]/)
  assert.match(css, /color-scheme: dark/)
  assert.match(css, /--stage-check-a:/)
  assert.match(css, /\.theme-toggle/)
  assert.match(css, /@media \(prefers-color-scheme: dark\)/)

  assert.match(queueApp, /visual-review:theme/)
  assert.match(queueApp, /data-action="toggle-theme"/)
  assert.match(queueApp, /document\.documentElement\.dataset\.theme/)

  assert.match(annotationApp, /visual-review:theme/)
  assert.match(annotationApp, /toggleVisualReviewTheme/)
  assert.match(annotationApp, /document\.documentElement\.dataset\.theme/)
})
