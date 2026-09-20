import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDataset } from '../src/lib/data.js'

const sample = t => ({ t, x: 1, y: 0, z: 2, roll: 0, pitch: 0, yaw: 0, tilt: 0 })
const passage = () => ({ left: 0.8, right: 1.2, thickness: 0.02, startY: 2, endY: 6, height: 4 })
const scene = () => ({ passage: passage(), hoverTarget: { x: 1, y: 8, z: 3 } })
const stages = () => [
  { name: '起飞', from: 10, to: 15 },
  { name: '倾转穿越', from: 15, to: 30 },
  { name: '目标悬停', from: 30, to: 40 },
]
const dataset = (metadata = {}, samples = [sample(10), sample(40)]) => ({
  schemaVersion: 1,
  metadata: { title: '参数化任务', angleUnit: 'rad', positionUnit: 'm', ...metadata },
  samples,
})

test('JSON reimport retains custom walls, hover target, and timed mission stages', () => {
  const input = dataset({ scene: scene(), stages: stages(), source: 'Browser geometric planner' })
  const original = structuredClone(input)
  const exported = JSON.parse(JSON.stringify(validateDataset(input)))
  const reimported = validateDataset(exported)
  assert.deepEqual(reimported.metadata.scene, original.metadata.scene)
  assert.deepEqual(reimported.metadata.stages, original.metadata.stages)
  assert.equal(reimported.metadata.source, original.metadata.source)
  assert.deepEqual(reimported.samples, original.samples)
  assert.deepEqual(input, original, 'Import must not modify the source scene or timeline')
})

test('older recordings need no scene or stages, and a wall scene needs no hover target', () => {
  const legacy = validateDataset(dataset())
  assert.equal(legacy.metadata.scene, undefined)
  assert.equal(legacy.metadata.stages, undefined)
  const wallsOnly = { passage: passage() }
  assert.deepEqual(validateDataset(dataset({ scene: wallsOnly })).metadata.scene, wallsOnly)
  assert.doesNotThrow(() => validateDataset(dataset({ stages: stages() })))
})

test('explicit display heading calibration survives export without changing source angles', () => {
  const customScene = { ...scene(), headingOffsetRad: -Math.PI / 3 }
  const input = dataset({ angleUnit: 'deg', scene: customScene }, [
    { ...sample(10), yaw: 60, tilt: 30 }, { ...sample(40), yaw: 62, tilt: 45 },
  ])
  const original = structuredClone(input)
  const normalized = validateDataset(input)
  const roundtrip = validateDataset(JSON.parse(JSON.stringify(normalized)))
  assert.deepEqual(input, original)
  assert.deepEqual(roundtrip, normalized)
  assert.equal(roundtrip.metadata.scene.headingOffsetRad, -Math.PI / 3, 'Scene offset is always radians, independent of sample units')
  assert.ok(Math.abs(roundtrip.samples[0].yaw - Math.PI / 3) < 1e-12)
  assert.equal(validateDataset(dataset()).metadata.scene, undefined, 'Ordinary imports must not acquire display calibration')
})

test('malformed heading calibration is rejected before reaching the renderer', () => {
  for (const headingOffsetRad of [null, false, '', '-1', NaN, Infinity, -Infinity, Math.PI + .01, -Math.PI - .01]) {
    assert.throws(() => validateDataset(dataset({ scene: { ...scene(), headingOffsetRad } })))
  }
  for (const headingOffsetRad of [-Math.PI, 0, Math.PI]) {
    assert.doesNotThrow(() => validateDataset(dataset({ scene: { ...scene(), headingOffsetRad } })))
  }
})

test('incomplete scenes and nonfinite or nonnumeric wall dimensions are refused', () => {
  for (const invalidScene of [null, false, 'walls', [], {}, { passage: null }, { passage: {} }]) {
    assert.throws(() => validateDataset(dataset({ scene: invalidScene })), `Invalid scene ${JSON.stringify(invalidScene)}`)
  }
  for (const field of Object.keys(passage())) {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '2']) {
      const customScene = { passage: { ...passage(), [field]: value } }
      assert.throws(() => validateDataset(dataset({ scene: customScene })), `Invalid passage ${field}=${String(value)}`)
    }
  }
})

test('reversed, degenerate, and excessively large walls cannot enter the renderer', () => {
  const invalidPassages = [
    { left: 2, right: 1 },
    { left: 1, right: 1 },
    { left: 0, right: 0.01 },
    { left: 0, right: 11 },
    { thickness: 0 },
    { thickness: -0.02 },
    { thickness: 2 },
    { startY: 6, endY: 2 },
    { startY: 2, endY: 2 },
    { startY: 0, endY: 1001 },
    { height: 0 },
    { height: -2 },
    { height: 1001 },
    { left: 10001, right: 10002 },
    { left: -10002, right: -10001 },
    { startY: 10001, endY: 10002 },
    { startY: -10002, endY: -10001 },
  ]
  for (const changes of invalidPassages) {
    assert.throws(
      () => validateDataset(dataset({ scene: { passage: { ...passage(), ...changes } } })),
      `Unsafe wall geometry ${JSON.stringify(changes)}`,
    )
  }
})

test('hover targets need three finite coordinates inside the supported display range', () => {
  for (const invalid of [null, false, 'target', [], {}, { x: 1, y: 8 }]) {
    assert.throws(() => validateDataset(dataset({ scene: { ...scene(), hoverTarget: invalid } })))
  }
  for (const field of ['x', 'y', 'z']) {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '3', 10001, -10001]) {
      const customScene = scene()
      customScene.hoverTarget[field] = value
      assert.throws(() => validateDataset(dataset({ scene: customScene })), `Invalid hover ${field}=${String(value)}`)
    }
  }
})

test('mission stages require usable names and finite numeric timestamps', () => {
  for (const invalidStages of [null, false, 'mission', {}, [null]]) {
    assert.throws(() => validateDataset(dataset({ stages: invalidStages })))
  }
  for (const name of [undefined, null, 1, '', '   ', 'a'.repeat(61)]) {
    assert.throws(() => validateDataset(dataset({ stages: [{ name, from: 10, to: 15 }] })))
  }
  for (const field of ['from', 'to']) {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '15']) {
      assert.throws(
        () => validateDataset(dataset({ stages: [{ name: '起飞', from: 10, to: 15, [field]: value }] })),
        `Invalid stage ${field}=${String(value)}`,
      )
    }
  }
})

test('stage times cannot overlap, run backward, or exceed the recording time base', () => {
  for (const invalidStages of [
    [{ name: '早于首帧', from: 0, to: 12 }],
    [{ name: '晚于尾帧', from: 35, to: 41 }],
    [{ name: '全程越界', from: 41, to: 42 }],
    [{ name: '逆序区间', from: 20, to: 15 }],
    [{ name: '阶段一', from: 10, to: 20 }, { name: '重叠', from: 19, to: 30 }],
    [{ name: '阶段二', from: 20, to: 30 }, { name: '倒序', from: 10, to: 15 }],
  ]) {
    assert.throws(() => validateDataset(dataset({ stages: invalidStages })), JSON.stringify(invalidStages))
  }
  // Exact shared boundaries and gaps are both valid, without requiring t=0.
  assert.doesNotThrow(() => validateDataset(dataset({ stages: stages() })))
  assert.doesNotThrow(() => validateDataset(dataset({ stages: [
    { name: '起飞', from: 10, to: 15 },
    { name: '后续悬停', from: 30, to: 40 },
  ] })))
})

test('the mission timeline accepts 32 stages and rejects an oversized stage list', () => {
  const mission = Array.from({ length: 32 }, (_, i) => ({ name: `阶段 ${i + 1}`, from: i, to: i + 1 }))
  const samples = [sample(0), sample(33)]
  assert.equal(validateDataset(dataset({ stages: mission }, samples)).metadata.stages.length, 32)
  assert.throws(() => validateDataset(dataset({ stages: [...mission, { name: '阶段 33', from: 32, to: 33 }] }, samples)))
})
