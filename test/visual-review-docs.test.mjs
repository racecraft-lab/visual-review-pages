import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function read(relativePath) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('README documents the reusable workflow and CLI contract for future repos', () => {
  const readme = read('README.md')

  assert.match(readme, /Reusable GitHub Workflows/)
  assert.match(readme, /visual-review-report\.yml/)
  assert.match(readme, /visual-review-approval\.yml/)
  assert.match(readme, /publish-visual-review-pages/)
  assert.match(readme, /check-visual-review-approval/)
  assert.match(readme, /contents: write/)
  assert.match(readme, /statuses: write/)
  assert.match(readme, /required_surfaces/)
  assert.match(readme, /visual_review_paths/)
  assert.match(readme, /pages_branch/)
  assert.match(readme, /GitHub Pages/)
  assert.match(readme, /access_level: organization/)
})
