import assert from 'node:assert/strict'
import test from 'node:test'

import {
  heatMapColorForDelta,
  writeHeatMapPixels,
} from '../src/visual-review-heatmap.mjs'

test('heat map ignores tiny pixel differences below the threshold', () => {
  const color = heatMapColorForDelta(8, { threshold: 12 })

  assert.equal(color, null)
})

test('heat map colors scale from yellow to red as differences grow', () => {
  const low = heatMapColorForDelta(24, { threshold: 12 })
  const high = heatMapColorForDelta(240, { threshold: 12 })

  assert.deepEqual(low.slice(0, 3), [255, 223, 0])
  assert.equal(low[3] > 0, true)
  assert.deepEqual(high.slice(0, 3), [255, 34, 0])
  assert.equal(high[3] > low[3], true)
})

test('heat map writes transparent pixels for unchanged areas and colored pixels for changed areas', () => {
  const baseline = new Uint8ClampedArray([
    10, 10, 10, 255,
    20, 20, 20, 255,
  ])
  const current = new Uint8ClampedArray([
    12, 12, 12, 255,
    220, 30, 20, 255,
  ])
  const output = new Uint8ClampedArray(8)

  const summary = writeHeatMapPixels({
    baseline,
    current,
    output,
    threshold: 12,
  })

  assert.deepEqual(Array.from(output.slice(0, 4)), [0, 0, 0, 0])
  assert.equal(output[4], 255)
  assert.equal(output[7] > 0, true)
  assert.deepEqual(summary, {
    changedPixels: 1,
    maxDelta: 200,
    totalPixels: 2,
  })
})
