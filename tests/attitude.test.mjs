import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { applyDronePose, createDroneModel, sweptAircraftBounds } from '../src/lib/droneModel.js'
import { sampleAt, validateDataset } from '../src/lib/data.js'

const recording = JSON.parse(readFileSync(new URL('../public/data/recorded.json', import.meta.url), 'utf8'))
const radians = degrees => degrees * Math.PI / 180
const closeTo = (actual, expected, tolerance = 1e-10) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected}`,
)
const neutralPose = { x: 1, y: 4, z: 2, roll: 0, pitch: 0, yaw: 0, tilt: 0 }
const direction = (object, axis) => new THREE.Vector3(...axis).transformDirection(object.matrixWorld)

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

test('recording explicitly exports its display heading calibration while preserving source yaw', () => {
  closeTo(recording.metadata.scene.headingOffsetRad, -Math.PI / 3)
  const exported = JSON.parse(JSON.stringify(validateDataset(recording)))
  closeTo(exported.metadata.scene.headingOffsetRad, -Math.PI / 3)
  assert.deepEqual(exported.samples, recording.samples, 'Display alignment must not alter the saved experiment')
  closeTo(sampleAt(exported.samples, 13.33).yaw, Math.PI / 3, 1e-6)
})

test('positive tilt lowers the right side across the passage without pitching the nose down', () => {
  withModel(rig => {
    for (const degrees of [0, 30, 45, 62, -30]) {
      const tilt = radians(degrees)
      applyDronePose(rig, { ...neutralPose, tilt })
      rig.drone.updateMatrixWorld(true)
      const forward = direction(rig.airframe, [0, 1, 0])
      const right = direction(rig.airframe, [1, 0, 0])
      const up = direction(rig.airframe, [0, 0, 1])
      closeTo(forward.x, 0)
      closeTo(forward.y, 1)
      closeTo(forward.z, 0)
      closeTo(right.x, Math.cos(tilt))
      closeTo(right.z, -Math.sin(tilt))
      closeTo(up.x, Math.sin(tilt))
      closeTo(up.y, 0)
      // Inspect actual front/rear motor positions as well as orientation axes.
      const motors = rig.rotorMounts.map(mount => mount.getWorldPosition(new THREE.Vector3()))
      closeTo(motors[0].z, motors[3].z)
      closeTo(motors[1].z, motors[2].z)
      closeTo(motors[0].z - motors[1].z, 2 * .079 * Math.sin(tilt))
    }
  })
})

test('the reported 13.33s pose and transit bank across the corridor instead of along it', () => {
  withModel(rig => {
    for (const time of [13.33, 18.79, 25]) {
      const sample = sampleAt(recording.samples, time), original = { ...sample }
      applyDronePose(rig, sample, recording.metadata.scene.headingOffsetRad)
      const bounds = sweptAircraftBounds(rig)
      const forward = direction(rig.airframe, [0, 1, 0])
      const up = direction(rig.airframe, [0, 0, 1])
      assert.ok(forward.y > .999, `Nose is not aligned with the passage at ${time}s`)
      assert.ok(Math.abs(forward.z) < .002, `Unexpected visible forward pitch at ${time}s`)
      assert.ok(up.x > .49, `The intended right bank is missing at ${time}s`)
      assert.ok(Math.abs(up.y) < .002, `Tilt leaks into the forward direction at ${time}s`)
      assert.ok(bounds.max.x - bounds.min.x < .27, `Bank does not reduce transverse width at ${time}s`)
      assert.ok(bounds.min.x > .86 && bounds.max.x < 1.14, `Rotors lose passage clearance at ${time}s`)
      assert.deepEqual(sample, original, 'Applying a display pose must not rewrite source data')
      assert.deepEqual(rig.drone.position.toArray(), [sample.x, sample.y, sample.z])
      assert.deepEqual(rig.drone.scale.toArray(), [1, 1, 1])
    }
  })
})

test('uncalibrated imports retain arbitrary yaw and reset a previous recording calibration', () => {
  withModel(rig => {
    const sample = { ...neutralPose, yaw: .7, tilt: radians(30) }
    applyDronePose(rig, sample, -Math.PI / 3)
    applyDronePose(rig, sample)
    rig.drone.updateMatrixWorld(true)
    const forward = direction(rig.airframe, [0, 1, 0])
    closeTo(forward.x, -Math.sin(sample.yaw))
    closeTo(forward.y, Math.cos(sample.yaw))
    closeTo(forward.z, 0)
  })
})

test('rotor compensation cancels frame bank while retaining source roll and pitch', () => {
  withModel(rig => {
    const sample = { ...neutralPose, roll: radians(2), pitch: radians(-3), yaw: radians(80) }
    const offset = -Math.PI / 3, yaw = sample.yaw + offset
    const { roll, pitch } = sample
    // Independently compute Rz(yaw) Ry(pitch) Rx(roll) applied to the up axis.
    const expected = [
      Math.cos(yaw) * Math.sin(pitch) * Math.cos(roll) + Math.sin(yaw) * Math.sin(roll),
      Math.sin(yaw) * Math.sin(pitch) * Math.cos(roll) - Math.cos(yaw) * Math.sin(roll),
      Math.cos(pitch) * Math.cos(roll),
    ]
    for (const tilt of [0, radians(30), radians(62)]) {
      applyDronePose(rig, { ...sample, tilt }, offset)
      rig.drone.updateMatrixWorld(true)
      for (const rotor of rig.rotorBlades) {
        direction(rotor, [0, 0, 1]).toArray().forEach((value, index) => closeTo(value, expected[index]))
      }
    }
  })
})
