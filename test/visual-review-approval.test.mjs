import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import test from 'node:test'

import {
  buildSurfaceReviewState,
  mergeSurfaceReviewState,
  renderReviewComment,
} from '../src/visual-review-state.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((error) => error ? reject(error) : resolve())
  })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`command timed out: ${command} ${args.join(' ')}`))
    }, options.timeout || 5000)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ signal, status, stderr, stdout })
    })
  })
}

async function withMockGitHub(handler, callback) {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    await handler(request, response, body)
  })
  const address = await listen(server)
  try {
    return await callback(`http://${address.address}:${address.port}`)
  } finally {
    await close(server)
  }
}

function approvedReviewComment({ headSha }) {
  const surface = buildSurfaceReviewState({
    context: {
      headSha,
      prNumber: '42',
      prTitle: 'Visual review smoke',
      prUrl: 'https://github.com/example/product/pull/42',
      repository: 'example/product',
      surface: 'playwright',
      surfaceLabel: 'Playwright UI E2E',
    },
    items: [
      { id: 'button', raw: 'button.png', variant: 'changed', group: 'components' },
    ],
    reviews: {
      button: 'approved',
    },
    reviewer: 'reviewer',
    updatedAt: '2026-05-20T14:40:00.000Z',
  })

  return renderReviewComment(mergeSurfaceReviewState(null, surface))
}

test('approval CLI reuses stale approval when only nonvisual files changed since approval', async () => {
  const statusWrites = []

  await withMockGitHub((request, response, body) => {
    if (request.method === 'GET' && request.url === '/repos/example/product/pulls/42/files?per_page=100&page=1') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([
        { filename: 'src/components/button.tsx' },
        { filename: 'docs/uat.md' },
      ]))
      return
    }

    if (request.method === 'GET' && request.url === '/repos/example/product/issues/42/comments?per_page=100&sort=updated&direction=desc') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([
        {
          body: approvedReviewComment({ headSha: 'oldapprovedsha' }),
          updated_at: '2026-05-20T14:41:00.000Z',
        },
      ]))
      return
    }

    if (request.method === 'GET' && request.url === '/repos/example/product/compare/oldapprovedsha...newheadsha') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        files: [
          { filename: 'docs/uat.md' },
        ],
      }))
      return
    }

    if (request.method === 'POST' && request.url === '/repos/example/product/statuses/newheadsha') {
      statusWrites.push(JSON.parse(body))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({}))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ message: `unexpected ${request.method} ${request.url}` }))
  }, async (apiUrl) => {
    const result = await runCommand(process.execPath, [
      'bin/check-visual-review-approval.mjs',
      '--repository',
      'example/product',
      '--pr-number',
      '42',
      '--head-sha',
      'newheadsha',
      '--required-surfaces',
      'playwright',
      '--visual-review-paths',
      'src/**',
      '--skip-if-no-visual-changes',
      '--set-status',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: 'test-token',
      },
      timeout: 5000,
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Visual review unchanged since last approval/)
    assert.equal(statusWrites.length, 1)
    assert.equal(statusWrites[0].state, 'success')
  })
})
