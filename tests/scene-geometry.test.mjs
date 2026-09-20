import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { applyDronePose, createDroneModel, sweptAircraftBounds } from '../src/lib/droneModel.js'
import { sampleAt } from '../src/lib/data.js'
import { planFlight } from '../src/lib/planner.js'
import { applyGroundContact } from '../src/lib/sceneGeometry.js'

const recording = JSON.parse(readFileSync(new URL('../public/data/recorded.json', import.meta.url), 'utf8'))
const closeTo = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`)
function withModel(callback) {
  const rig = createDroneModel()
  try { callback(rig) } finally {
    const geometries = new Set(), surfaces = new Set()
    rig.drone.traverse(part => { if (part.geometry) geometries.add(part.geometry); if (part.material) surfaces.add(part.material) })
    geometries.forEach(item => item.dispose())
    surfaces.forEach(item => item.dispose())
  }
}

test('display ground contact places the original zero-centre endpoints on their feet without changing source poses', () => {
  withModel(rig => {
    for (const sample of [recording.samples[0], recording.samples.at(-1)]) {
      const original = structuredClone(sample)
      applyDronePose(rig, sample, recording.metadata.scene.headingOffsetRad)
      assert.equal(rig.drone.position.z, sample.z, 'Raw pose mapping must remain exact before display correction')
      assert.ok(sweptAircraftBounds(rig).min.z < -.02, 'The original centre-height endpoint reproduces floor penetration')
      const lift = applyGroundContact(rig)
      assert.ok(lift > .02 && lift < .021)
      rig.drone.updateMatrixWorld(true)
      closeTo(new THREE.Box3().setFromObject(rig.drone, true).min.z, 0)
      const feet = rig.bodyMeshes.filter(part => part.name === 'motor-cradle-base')
      assert.equal(feet.length, 4)
      assert.ok(feet.every(foot => new THREE.Box3().setFromObject(foot, true).min.z >= -1e-8))
      closeTo(Math.min(...feet.map(foot => new THREE.Box3().setFromObject(foot, true).min.z)), 0)
      assert.ok(new THREE.Box3().setFromObject(rig.imuMount, true).min.z > .001)
      assert.deepEqual(sample, original)
    }
  })
})

test('seeking between ground and airborne frames never accumulates or retains a display lift', () => {
  withModel(rig => {
    for (const time of [0, 0, 13.33, 40, 20, 0, 18.79]) {
      const sample = sampleAt(recording.samples, time), original = { ...sample }
      applyDronePose(rig, sample, recording.metadata.scene.headingOffsetRad)
      const lift = applyGroundContact(rig)
      assert.ok(sweptAircraftBounds(rig).min.z >= -1e-8)
      closeTo(rig.drone.position.z, sample.z + lift)
      if (sample.z > 1) { assert.equal(lift, 0); assert.equal(rig.drone.position.z, sample.z) }
      const currentPosition = rig.drone.position.toArray()
      assert.equal(applyGroundContact(rig), 0, 'Applying contact twice to the same displayed pose must not move it twice')
      assert.deepEqual(rig.drone.position.toArray(), currentPosition)
      assert.deepEqual(sample, original)
    }
  })
})

test('complete geometry-planned flights need no display-ground correction, including exact touchdown', () => {
  withModel(rig => {
    for (const parameters of [{}, { gapWidth: .4, targetHeight: .3 }, { gapWidth: .21, maxTiltDeg: 75, targetHeight: 5 }]) {
      const result = planFlight(parameters)
      assert.equal(result.ok, true, result.error)
      for (const sample of result.dataset.samples) {
        applyDronePose(rig, sample)
        assert.equal(applyGroundContact(rig), 0, `A generated pose at ${sample.t}s unexpectedly needs ground correction`)
        assert.equal(rig.drone.position.z, sample.z)
      }
    }
  })
})
