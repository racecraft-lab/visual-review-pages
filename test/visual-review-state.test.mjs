import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_VISUAL_REVIEW_PATHS,
  VISUAL_REVIEW_COMMENT_MARKER,
  parseReviewCommentBody,
  renderReviewComment,
  visualReviewRequiredForFiles,
} from '../src/visual-review-state.mjs'

const reviewState = {
  prNumber: '42',
  prTitle: 'Reusable visual review',
  prUrl: 'https://github.com/example-org/example-product/pull/42',
  repository: 'example-org/example-product',
  schema: 'visual-review-pages.visual-review-state.v1',
  surfaces: {
    audit: {
      decisions: {},
      headSha: 'abcdef1234567890',
      prNumber: '42',
      repository: 'example-org/example-product',
      summary: {
        approved: 1,
        open: 0,
        rejected: 0,
        reviewable: 1,
        reviewed: 1,
        status: 'approved',
      },
      surface: 'audit',
      surfaceLabel: 'Audit Screens',
    },
  },
  updatedAt: '2026-05-05T00:00:00.000Z',
  version: 1,
}

test('managed PR comments use a generic marker and copy while still reading legacy Mission Control comments', () => {
  assert.equal(VISUAL_REVIEW_COMMENT_MARKER, 'visual-review-pages-state:v1')

  const body = renderReviewComment(reviewState)
  assert.match(body, /<!-- visual-review-pages-state:v1/)
  assert.doesNotMatch(body, /Mission Control visual review app/)
  assert.equal(parseReviewCommentBody(body).repository, 'example-org/example-product')

  const legacyBody = `<!-- mission-control-visual-review-state:v1\n${JSON.stringify(reviewState)}\n-->`
  assert.equal(parseReviewCommentBody(legacyBody).repository, 'example-org/example-product')
})

test('default visual-review path filters are reusable and callers can override them', () => {
  assert.equal(DEFAULT_VISUAL_REVIEW_PATHS.some((pattern) => pattern.includes('mission-control')), false)
  assert.equal(DEFAULT_VISUAL_REVIEW_PATHS.some((pattern) => pattern.includes('scripts/publish-visual-pr-pages.mjs')), false)
  assert.equal(visualReviewRequiredForFiles(['docs/readme.md']), false)
  assert.equal(visualReviewRequiredForFiles(['src/components/button.tsx']), true)
  assert.equal(visualReviewRequiredForFiles(['packages/mobile/screen.tsx'], ['packages/mobile/**']), true)
})
