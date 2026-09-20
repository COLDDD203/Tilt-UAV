import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { applyDronePose, createDroneModel, DRONE_DIMENSIONS, PASSAGE, sweptAircraftBounds, wallCenters } from '../src/lib/droneModel.js'
import { sampleAt } from '../src/lib/data.js'

const recording = JSON.parse(readFileSync(new URL('../public/data/recorded.json', import.meta.url), 'utf8'))
const { samples } = recording
const { headingOffsetRad } = recording.metadata.scene
const emptyPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, tilt: 0 }
const overlapsWallsLongitudinally = box => box.max.y >= PASSAGE.startY && box.min.y <= PASSAGE.endY && box.max.z >= 0 && box.min.z <= PASSAGE.height
const clearances = box => ({ left: box.min.x - PASSAGE.left, right: PASSAGE.right - box.max.x })

test('the labelled 0.40 m passage is measured between inner wall faces', () => {
  const [left, right] = wallCenters()
  assert.ok(Math.abs(left + PASSAGE.thickness / 2 - PASSAGE.left) < 1e-12)
  assert.ok(Math.abs(right - PASSAGE.thickness / 2 - PASSAGE.right) < 1e-12)
  assert.ok(Math.abs((right - left - PASSAGE.thickness) - .4) < 1e-12)
})

test('the aircraft uses the source metre dimensions, including the complete rotating blade', () => {
  const rig = createDroneModel()
  assert.equal(DRONE_DIMENSIONS.armHalfX, .079)
  assert.equal(DRONE_DIMENSIONS.armHalfY, .088)
  assert.equal(DRONE_DIMENSIONS.propellerRadius, .065)
  rig.drone.updateMatrixWorld(true)
  for (const mount of rig.rotorMounts) {
    const position = mount.getWorldPosition(new THREE.Vector3())
    assert.equal(Math.abs(position.x), .079)
    assert.equal(Math.abs(position.y), .088)
  }
  for (const rotor of rig.rotorBlades) {
    rotor.traverse(part => {
      if (!part.isMesh) return
      const vertices = part.geometry.getAttribute('position')
      const toRotor = rotor.matrixWorld.clone().invert().multiply(part.matrixWorld)
      for (let i = 0; i < vertices.count; i++) {
        const vertex = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(toRotor)
        assert.ok(Math.hypot(vertex.x, vertex.y) <= .065 + 1e-8, 'Blade corner exceeds the full swept disk')
      }
    })
  }
  assert.deepEqual(rig.drone.scale.toArray(), [1, 1, 1])
})

test('every recorded and interpolated transit frame clears both walls with full rotor sweep', t => {
  const rig = createDroneModel(), box = new THREE.Box3()
  let minimum = Infinity, checked = 0, worstTime = 0
  // Match the actual renderer interpolation, with a dense 2 ms grid over all 40 s.
  for (let tick = 0; tick <= 20000; tick++) {
    const time = tick / 500
    applyDronePose(rig, sampleAt(samples, time), headingOffsetRad)
    sweptAircraftBounds(rig, box)
    if (!overlapsWallsLongitudinally(box)) continue
    checked++
    const sides = clearances(box)
    const clearance = Math.min(sides.left, sides.right)
    if (clearance < minimum) { minimum = clearance; worstTime = time }
    assert.ok(clearance > .025, `Insufficient clearance at ${time}s: ${JSON.stringify(sides)}`)
    assert.deepEqual(rig.drone.scale.toArray(), [1, 1, 1], 'No runtime shrinking allowed')
  }
  assert.ok(checked > 3000, 'The check must cover entry, transit, and exit')
  t.diagnostic(`${checked} overlapping frames; minimum geometric clearance ${(minimum * 1000).toFixed(2)} mm at ${worstTime}s`)
})

test('the screenshot pose at 18.79s clears the walls even as the propellers rotate', () => {
  const rig = createDroneModel(), envelope = new THREE.Box3(), actual = new THREE.Box3()
  applyDronePose(rig, sampleAt(samples, 18.79), headingOffsetRad)
  sweptAircraftBounds(rig, envelope)
  assert.ok(envelope.min.x > .825 && envelope.max.x < 1.175)
  for (let phase = 0; phase < 72; phase++) {
    rig.rotorBlades.forEach((rotor, i) => { rotor.rotation.z = phase * Math.PI / 36 * (i % 2 ? 1 : -1) })
    rig.drone.updateMatrixWorld(true)
    // Precise vertex bounds independently inspect the actual rendered geometry.
    actual.setFromObject(rig.drone, true)
    assert.ok(actual.min.x >= envelope.min.x - 1e-8)
    assert.ok(actual.max.x <= envelope.max.x + 1e-8)
  }
})

test('oversized geometry is detected instead of silently moving the walls or the trajectory', () => {
  const rig = createDroneModel()
  rig.drone.scale.setScalar(3)
  const sample = sampleAt(samples, 18.79), original = { ...sample }
  applyDronePose(rig, sample, headingOffsetRad)
  const box = sweptAircraftBounds(rig)
  assert.ok(box.min.x < PASSAGE.left && box.max.x > PASSAGE.right)
  assert.deepEqual(sample, original)
  applyDronePose(rig, emptyPose)
  assert.deepEqual(rig.drone.scale.toArray(), [3, 3, 3])
})
