import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function read(relativePath) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('report workflow is reusable and publishes through the packaged CLI', () => {
  const workflow = read('.github/workflows/visual-review-report.yml')

  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /surface:/)
  assert.match(workflow, /visual_test_command:/)
  assert.match(workflow, /image_directory_path:/)
  assert.match(workflow, /artifact_paths:/)
  assert.match(workflow, /actions\/checkout@v6/)
  assert.match(workflow, /repository: racecraft-lab\/visual-review-pages/)
  assert.match(workflow, /bin\/publish-visual-review-pages\.mjs/)
  assert.match(workflow, /reg-viz\/reg-actions@v3/)
  assert.match(workflow, /Expose caller git metadata to workspace root/)
  assert.match(workflow, /ln -s repo\/\.git \.git/)
  assert.match(workflow, /Resolve GitHub Pages base URL/)
  assert.match(workflow, /GITHUB_REPOSITORY_OWNER/)
  assert.match(workflow, /format\('\{0\}-evidence', inputs\.artifact_name\)/)
  assert.match(workflow, /contents: write/)
  assert.match(workflow, /pull-requests: write/)
})

test('report workflow uploads caller-owned canonical review artifacts', () => {
  const workflow = read('.github/workflows/visual-review-report.yml')

  assert.match(workflow, /review_artifact_name:/)
  assert.match(workflow, /review_artifact_retention_days:/)
  assert.match(workflow, /repo\/\.visual-review-pages\/\$\{\{ inputs\.surface \}\}/)
  assert.match(workflow, /--artifact-dir/)
  assert.match(workflow, /Upload canonical visual review artifact/)
  assert.match(workflow, /id: upload-review-artifact/)
  assert.match(workflow, /uses: actions\/upload-artifact@v7/)
  assert.match(workflow, /name: \$\{\{ steps\.review-artifact-name\.outputs\.name \}\}/)
  assert.match(workflow, /retention-days: \$\{\{ inputs\.review_artifact_retention_days \}\}/)
  assert.match(workflow, /steps\.upload-review-artifact\.outputs\.artifact-url/)
  assert.match(workflow, /steps\.upload-review-artifact\.outputs\.artifact-digest/)
})

test('report workflow limits GitHub cache usage to package dependencies', () => {
  const workflow = read('.github/workflows/visual-review-report.yml')

  assert.match(workflow, /enable_dependency_cache:/)
  assert.match(workflow, /Setup Node with pnpm cache/)
  assert.match(workflow, /cache: pnpm/)
  assert.match(workflow, /cache-dependency-path: repo\/pnpm-lock\.yaml/)
  assert.match(workflow, /Setup Node with npm cache/)
  assert.match(workflow, /cache: npm/)
  assert.match(workflow, /cache-dependency-path: repo\/package-lock\.json/)
  assert.doesNotMatch(workflow, /actions\/cache/)
})

test('approval workflow is reusable and delegates to the packaged approval CLI', () => {
  const workflow = read('.github/workflows/visual-review-approval.yml')

  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /pr_number:/)
  assert.match(workflow, /required_surfaces:/)
  assert.match(workflow, /visual_review_paths:/)
  assert.match(workflow, /repository: racecraft-lab\/visual-review-pages/)
  assert.match(workflow, /bin\/check-visual-review-approval\.mjs/)
  assert.match(workflow, /statuses: write/)
  assert.match(workflow, /issues: read/)
})
