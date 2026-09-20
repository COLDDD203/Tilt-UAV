import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { planFlight, DEFAULT_PLAN_PARAMS } from '../src/lib/planner.js'
import { createDroneModel, applyDronePose, sweptAircraftBounds } from '../src/lib/droneModel.js'
import { validateDataset, sampleAt, errorMagnitude, summarize } from '../src/lib/data.js'

const closeTo = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`)
function mustPlan(parameters) {
  const result = planFlight(parameters)
  assert.equal(result.ok, true, result.error)
  return result
}
function withModel(callback) {
  const rig = createDroneModel()
  try { callback(rig) } finally {
    const geometry = new Set(), surfaces = new Set()
    rig.drone.traverse(part => {
      if (part.geometry) geometry.add(part.geometry)
      if (part.material) (Array.isArray(part.material) ? part.material : [part.material]).forEach(item => surfaces.add(item))
    })
    geometry.forEach(item => item.dispose())
    surfaces.forEach(item => item.dispose())
  }
}

test('a narrow passage selects the smallest permitted tilt while a wide passage stays level', () => {
  const narrow = mustPlan(DEFAULT_PLAN_PARAMS), wide = mustPlan({ gapWidth: .4 })
  assert.ok(narrow.summary.tiltDeg > 45 && narrow.summary.tiltDeg <= DEFAULT_PLAN_PARAMS.maxTiltDeg)
  assert.equal(wide.summary.tiltDeg, 0)
  assert.ok(narrow.summary.requiredWidth <= DEFAULT_PLAN_PARAMS.gapWidth)
  assert.ok(narrow.summary.actualClearance >= DEFAULT_PLAN_PARAMS.clearance)
  withModel(rig => {
    const pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, tilt: (narrow.summary.tiltDeg - .25) * Math.PI / 180 }
    applyDronePose(rig, pose)
    const bounds = sweptAircraftBounds(rig)
    const earlierWidth = 2 * Math.max(-bounds.min.x, bounds.max.x) + 2 * DEFAULT_PLAN_PARAMS.clearance
    assert.ok(earlierWidth > DEFAULT_PLAN_PARAMS.gapWidth, 'Previous quarter-degree candidate must not fit')
    pose.tilt = narrow.summary.tiltDeg * Math.PI / 180
    applyDronePose(rig, pose)
    const selectedBounds = sweptAircraftBounds(rig)
    closeTo(narrow.summary.envelopeWidth, 2 * Math.max(-selectedBounds.min.x, selectedBounds.max.x))
  })
})

test('impossible widths and insufficient tilt are refused without emitting a trajectory', () => {
  for (const parameters of [
    { gapWidth: .14 },
    { gapWidth: .14, maxTiltDeg: 75, clearance: .005 },
    { gapWidth: .24, maxTiltDeg: 45 },
    { gapWidth: .28, maxTiltDeg: 0 },
  ]) {
    const result = planFlight(parameters)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('狭缝'))
    assert.ok(result.details.minPossibleWidth > parameters.gapWidth)
    assert.equal(result.dataset, undefined)
  }
  assert.equal(mustPlan({ gapWidth: .4, maxTiltDeg: 0 }).summary.tiltDeg, 0)
  const extreme = mustPlan({ gapWidth: .21, maxTiltDeg: 75, clearance: .015 })
  assert.ok(extreme.summary.tiltDeg > 70 && extreme.summary.tiltDeg <= 75)
})

test('all inputs have explicit finite physical limits and malformed values fail cleanly', () => {
  for (const input of [null, false, [], 1, 'hello']) assert.equal(planFlight(input).ok, false)
  const limits = { gapWidth: [.12, 1.2], targetHeight: [.3, 5], maxTiltDeg: [0, 75], clearance: [.005, .05], speed: [.1, 1.5] }
  for (const [field, [min, max]] of Object.entries(limits)) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, '1', min - .001, max + .001]) {
      const result = planFlight({ [field]: value })
      assert.equal(result.ok, false, `${field}=${String(value)} should fail`)
      assert.equal(result.details.parameter, field)
      assert.equal(result.dataset, undefined)
    }
  }
})

test('every dense playback pose clears the real wall, floor and full rotating rotor geometry', t => {
  const cases = [DEFAULT_PLAN_PARAMS, { gapWidth: .21, maxTiltDeg: 75, targetHeight: 5 }, { gapWidth: .35, targetHeight: .3, speed: 1.5 }]
  let inspected = 0
  withModel(rig => {
    const bound = new THREE.Box3(), actual = new THREE.Box3()
    for (const parameters of cases) {
      const { dataset, summary } = mustPlan(parameters)
      const passage = dataset.metadata.scene.passage
      const clearance = dataset.metadata.planner.parameters.clearance
      let minimum = Infinity, transitSamples = 0
      for (let tick = 0; tick <= Math.ceil(summary.duration * 100); tick++) {
        const pose = sampleAt(dataset.samples, Math.min(tick / 100, summary.duration))
        applyDronePose(rig, pose)
        sweptAircraftBounds(rig, bound)
        assert.ok(bound.min.z >= 0, `Ground intersection at ${pose.t}`)
        assert.deepEqual(rig.drone.scale.toArray(), [1, 1, 1], 'Aircraft must never shrink to fit')
        assert.deepEqual(rig.airframe.scale.toArray(), [1, 1, 1])
        if (bound.max.y >= passage.startY && bound.min.y <= passage.endY) {
          const sideClearance = Math.min(bound.min.x - passage.left, passage.right - bound.max.x)
          minimum = Math.min(minimum, sideClearance)
          assert.ok(sideClearance >= clearance - 1e-9, `Wall intersection at ${pose.t}`)
          assert.ok(bound.min.z >= clearance && bound.max.z <= passage.height - clearance)
          transitSamples++
        }
        inspected++
      }
      assert.ok(transitSamples > 400)
      closeTo(minimum, summary.actualClearance)
      const transit = dataset.metadata.stages[2]
      applyDronePose(rig, sampleAt(dataset.samples, (transit.from + transit.to) / 2))
      sweptAircraftBounds(rig, bound)
      // Independent precise vertex calculation samples every rotating blade phase.
      for (let phase = 0; phase < 72; phase++) {
        rig.rotorBlades.forEach((rotor, index) => { rotor.rotation.z = phase * Math.PI / 36 * (index % 2 ? 1 : -1) })
        rig.drone.updateMatrixWorld(true)
        actual.setFromObject(rig.drone, true)
        assert.ok(actual.min.x >= bound.min.x - 1e-8 && actual.max.x <= bound.max.x + 1e-8)
        assert.ok(actual.min.x - passage.left >= clearance - 1e-8)
        assert.ok(passage.right - actual.max.x >= clearance - 1e-8)
      }
    }
  })
  t.diagnostic(`${inspected} dense poses checked with the renderer's unscaled model`)
})

test('final height is exact, stays fixed for three seconds, and high targets are reached after the corridor', () => {
  for (const targetHeight of [.3, 1.7, 5]) {
    const { dataset, summary } = mustPlan({ targetHeight })
    const last = dataset.samples.at(-1)
    assert.equal(last.z, targetHeight)
    assert.equal(last.tilt, 0)
    assert.equal(last.y, 9)
    assert.equal(summary.targetHeight, targetHeight)
    const hover = dataset.metadata.stages.at(-1)
    assert.ok(hover.to - hover.from >= 3)
    for (const sample of dataset.samples.filter(row => row.t >= hover.from)) {
      assert.equal(sample.z, targetHeight)
      assert.equal(sample.y, 9)
      assert.equal(sample.tilt, 0)
    }
    if (targetHeight === 5) {
      assert.ok(summary.transitHeight < 2.5)
      assert.ok(dataset.samples.filter(row => row.y >= 1 && row.y <= 8).every(row => row.z < 2.5))
      assert.ok(dataset.samples.filter(row => row.z >= 2.5).every(row => row.y === 9))
    }
  }
})

test('peak translation speed and tilt rate satisfy the configured limits including phase boundaries', () => {
  for (const parameters of [{ speed: .1 }, { speed: 1.5, targetHeight: 5, maxTiltDeg: 75, gapWidth: .21 }]) {
    const { dataset } = mustPlan(parameters)
    let maxSpeed = 0, maxTiltRate = 0
    dataset.samples.slice(1).forEach((sample, index) => {
      const before = dataset.samples[index], dt = sample.t - before.t
      assert.ok(dt > 0 && dt <= .020000001)
      const speed = Math.hypot(sample.x - before.x, sample.y - before.y, sample.z - before.z) / dt
      const tiltRate = Math.abs(sample.tilt - before.tilt) / dt * 180 / Math.PI
      maxSpeed = Math.max(maxSpeed, speed)
      maxTiltRate = Math.max(maxTiltRate, tiltRate)
      assert.ok(speed <= parameters.speed + 1e-7)
      assert.ok(tiltRate <= 30 + 1e-7)
    })
    assert.ok(maxSpeed > parameters.speed * .99)
    assert.ok(maxTiltRate > 29.9)
    for (const stage of dataset.metadata.stages) {
      assert.ok(dataset.samples.some(sample => sample.t === stage.from))
      assert.ok(dataset.samples.some(sample => sample.t === stage.to))
    }
  }
})

test('folding and unfolding occur completely outside the wall, never partway through it', () => {
  const { dataset } = mustPlan()
  const passage = dataset.metadata.scene.passage
  withModel(rig => {
    for (let index = 1; index < dataset.samples.length; index++) {
      const pose = dataset.samples[index]
      if (Math.abs(pose.tilt - dataset.samples[index - 1].tilt) <= 1e-12) continue
      applyDronePose(rig, pose)
      const box = sweptAircraftBounds(rig)
      assert.ok(box.max.y < passage.startY || box.min.y > passage.endY)
    }
  })
})

test('parameter changes alter the actual trajectory, preserve the input, and export sufficient scene metadata', () => {
  const input = { ...DEFAULT_PLAN_PARAMS }
  const original = structuredClone(input)
  const first = mustPlan(input), second = mustPlan({ gapWidth: .4, targetHeight: 3, speed: .5 })
  assert.deepEqual(input, original)
  assert.notEqual(first.summary.tiltDeg, second.summary.tiltDeg)
  assert.notEqual(first.summary.duration, second.summary.duration)
  assert.notEqual(first.dataset.samples.at(-1).z, second.dataset.samples.at(-1).z)
  const imported = validateDataset(JSON.parse(JSON.stringify(first.dataset)))
  assert.deepEqual(imported.metadata.scene, first.dataset.metadata.scene)
  assert.deepEqual(imported.metadata.stages, first.dataset.metadata.stages)
  assert.deepEqual(imported.metadata.planner, first.dataset.metadata.planner)
  assert.deepEqual(imported.samples, first.dataset.samples)
  closeTo(imported.metadata.scene.passage.right - imported.metadata.scene.passage.left, input.gapWidth)
  assert.equal(imported.metadata.modelType, 'geometry-planner')
  assert.equal(imported.metadata.kind, 'synthetic')
})

test('planned kinematics never impersonate measured reference tracking or actuator outputs', () => {
  const { dataset } = mustPlan()
  for (const sample of dataset.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ['t', 'x', 'y', 'z', 'roll', 'pitch', 'yaw', 'tilt'].sort())
    assert.equal(errorMagnitude(sample), null)
    assert.equal(sample.yaw, 0)
    assert.equal(sample.roll, 0)
    assert.equal(sample.pitch, 0)
  }
  assert.equal(summarize(dataset.samples).rmse, null)
  assert.ok(dataset.metadata.limitations.some(text => text.includes('不是 MATLAB/Simulink')))
})
