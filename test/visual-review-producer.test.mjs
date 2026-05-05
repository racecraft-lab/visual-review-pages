import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveInitialReviewStateSource,
  reviewStateCoversReport,
} from '../src/visual-review-producer.mjs'

const repository = 'racecraft-lab/mission-control'
const baseUrl = 'https://racecraft-lab.github.io/mission-control'
const surface = 'storybook'
const snapshot = 'governance-main--default.png'
const currentSha = '2d65a057e44bc2fbecfd2ee127eb900717dd2a38'
const directMainSha = '57d4fe157d4fe157d4fe157d4fe157d4fe157'
const mergedSha = 'bd9a693937f9572fd8532484c084646e4fe8ff73'
const prHeadSha = '645f75c230577f97f35ea5629abef97ea37ab7f9'

function reportPayload(fileName = snapshot) {
  return {
    deletedItems: [],
    failedItems: [],
    newItems: [{ raw: fileName, encoded: fileName }],
    passedItems: [],
  }
}

function reviewState(fileName = snapshot) {
  return {
    prNumber: '26',
    prTitle: 'SPEC-008 governance',
    prUrl: 'https://github.com/racecraft-lab/mission-control/pull/26',
    repository,
    schema: 'mission-control.visual-review-state.v1',
    surfaces: {
      storybook: {
        baseRef: 'main',
        decisions: {
          [`new-${fileName}`]: {
            decision: 'approved',
            group: 'spec-008',
            snapshot: fileName,
            updatedAt: '2026-05-04T20:00:00.000Z',
            variant: 'new',
          },
        },
        headRef: '008-resource-governance',
        headSha: prHeadSha,
        prNumber: '26',
        prTitle: 'SPEC-008 governance',
        prUrl: 'https://github.com/racecraft-lab/mission-control/pull/26',
        reportHref: `${baseUrl}/pr/26/storybook/latest/`,
        repository,
        runAttempt: '1',
        runId: '123',
        runKey: '123-attempt-1',
        runUrl: 'https://github.com/racecraft-lab/mission-control/actions/runs/123',
        summary: {
          approved: 1,
          open: 0,
          rejected: 0,
          reviewable: 1,
          reviewed: 1,
          status: 'approved',
        },
        surface,
        surfaceLabel: 'Storybook Components',
        updatedAt: '2026-05-04T20:00:00.000Z',
      },
    },
    updatedAt: '2026-05-04T20:00:00.000Z',
    version: 1,
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })
}

test('main reports inherit covered visual review state from the last merged PR in commit history', async () => {
  const approvedState = reviewState()
  const fetch = async (url) => {
    const value = String(url)
    if (value.includes('/repos/racecraft-lab/mission-control/commits?')) {
      return jsonResponse([
        { sha: currentSha },
        { sha: directMainSha },
        { sha: mergedSha },
      ])
    }
    if (value.includes(`/commits/${currentSha}/pulls`)) return jsonResponse([])
    if (value.includes(`/commits/${directMainSha}/pulls`)) return jsonResponse([])
    if (value.includes(`/commits/${mergedSha}/pulls`)) {
      return jsonResponse([{
        head: { sha: prHeadSha },
        html_url: 'https://github.com/racecraft-lab/mission-control/pull/26',
        merge_commit_sha: mergedSha,
        merged_at: '2026-05-04T23:42:05Z',
        number: 26,
        title: 'SPEC-008 governance',
      }])
    }
    if (value.includes('/issues/26/comments')) {
      return jsonResponse([{
        body: `<!-- mission-control-visual-review-state:v1\n${JSON.stringify(approvedState, null, 2)}\n-->`,
        id: 2600,
        updated_at: '2026-05-04T20:00:00Z',
        user: { login: 'fgabelmannjr' },
      }])
    }
    return jsonResponse({ message: 'not found' }, 404)
  }

  const result = await resolveInitialReviewStateSource({
    baseUrl,
    fetch,
    headRef: 'main',
    headSha: currentSha,
    payload: reportPayload(),
    repository,
    surface,
    token: 'ghs_test',
  })

  assert.equal(result.sourcePullRequest.number, '26')
  assert.equal(result.sourcePullRequest.mergeCommitSha, mergedSha)
  assert.equal(result.initialReviewState.author, 'fgabelmannjr')
  assert.equal(result.initialReviewState.commentId, 2600)
  assert.deepEqual(result.initialReviewState.state, approvedState)
})

test('main report state inheritance requires every current reviewable item to be dispositioned', () => {
  assert.equal(
    reviewStateCoversReport({
      payload: reportPayload('different-image.png'),
      state: reviewState(),
      surface,
    }),
    false
  )
})
