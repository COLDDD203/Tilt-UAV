import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createDroneModel, DRONE_DIMENSIONS, sweptAircraftBounds } from '../src/lib/droneModel.js'
import { applyInspectionPose, DEFAULT_INSPECTION, inspectionDimensions, INSPECTION_LIMITS, validateInspection } from '../src/lib/inspection.js'

const closeTo = (actual, expected, tolerance = 1e-8) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected}`,
)
const radians = degrees => degrees * Math.PI / 180
const direction = (object, axis) => new THREE.Vector3(...axis).transformDirection(object.matrixWorld)
const neutral = { ...DEFAULT_INSPECTION, beta: 0 }

function dispose(rig) {
  const geometry = new Set(), materials = new Set()
  rig.drone.traverse(part => {
    if (part.geometry) geometry.add(part.geometry)
    if (part.material) (Array.isArray(part.material) ? part.material : [part.material]).forEach(item => materials.add(item))
  })
  geometry.forEach(item => item.dispose())
  materials.forEach(item => item.dispose())
}

function withModel(value, callback) {
  const rig = createDroneModel(inspectionDimensions(value))
  try { callback(rig) } finally { dispose(rig) }
}

test('default inspector dimensions retain the flight model geometry exactly', () => {
  assert.deepEqual(inspectionDimensions(DEFAULT_INSPECTION), DRONE_DIMENSIONS)
  const original = createDroneModel(), explicit = createDroneModel(inspectionDimensions(DEFAULT_INSPECTION))
  const shape = rig => {
    const objects = []
    rig.drone.traverse(part => objects.push({
      type: part.type,
      geometry: part.geometry?.parameters,
      position: part.position.toArray(),
      quaternion: part.quaternion.toArray(),
      scale: part.scale.toArray(),
    }))
    return objects
  }
  try {
    assert.deepEqual(shape(explicit), shape(original))
    const size = sweptAircraftBounds(explicit).getSize(new THREE.Vector3())
    closeTo(size.x, .288)
    closeTo(size.y, .306)
    assert.deepEqual(explicit.drone.scale.toArray(), [1, 1, 1])
  } finally { dispose(original); dispose(explicit) }
})

test('motor spans and disc diameter change real geometry in metres', () => {
  const value = { ...neutral, spanX: 400, spanY: 600, rotorDiameter: 250 }
  withModel(value, rig => {
    applyInspectionPose(rig, value)
    assert.deepEqual(rig.rotorMounts.map(mount => mount.position.toArray()), [
      [-.2, .3, .003], [.2, .3, .003], [.2, -.3, .003], [-.2, -.3, .003],
    ])
    const size = sweptAircraftBounds(rig).getSize(new THREE.Vector3())
    closeTo(size.x, .65)
    closeTo(size.y, .85)
    closeTo(rig.airframe.children[1].scale.y, .072 * (.3 / .088))
    assert.deepEqual(rig.drone.scale.toArray(), [1, 1, 1], 'Geometry is not a display-scale trick')
    for (const rotor of rig.rotorBlades) {
      const blade = rotor.children.find(part => part.geometry?.type === 'BoxGeometry')
      const { width, height } = blade.geometry.parameters
      assert.ok(Math.hypot(width / 2, height / 2) <= .125, 'The whole blade fits inside its swept disc')
    }
  })
})

test('custom swept bounds enclose all blade vertices through every rotor phase', () => {
  for (const dimensions of [{ spanX: 120, spanY: 140, rotorDiameter: 40 }, { spanX: 800, spanY: 1000, rotorDiameter: 500 }]) {
    const value = { ...neutral, ...dimensions, beta: 63, roll: -24, pitch: 17, yaw: 119 }
    withModel(value, rig => {
      applyInspectionPose(rig, value)
      const initial = sweptAircraftBounds(rig).clone()
      for (let step = 0; step < 24; step++) {
        rig.rotorBlades.forEach((rotor, index) => { rotor.rotation.z = (index % 2 ? -1 : 1) * step * Math.PI / 12 })
        const current = sweptAircraftBounds(rig)
        current.min.toArray().forEach((n, index) => closeTo(n, initial.min.toArray()[index]))
        current.max.toArray().forEach((n, index) => closeTo(n, initial.max.toArray()[index]))
        const tolerant = current.clone().expandByScalar(1e-8)
        for (const rotor of rig.rotorBlades) {
          rotor.traverse(part => {
            const positions = part.geometry?.attributes.position
            if (!positions) return
            const point = new THREE.Vector3()
            for (let vertex = 0; vertex < positions.count; vertex++) {
              point.fromBufferAttribute(positions, vertex).applyMatrix4(part.matrixWorld)
              assert.ok(tolerant.containsPoint(point), `Rotating blade escapes bounds at phase ${step}`)
            }
          })
        }
      }
    })
  }
})

test('positive manual roll lowers the right side without pitching the nose', () => {
  withModel(neutral, rig => {
    applyInspectionPose(rig, { ...neutral, roll: 30 })
    rig.drone.updateMatrixWorld(true)
    const nose = direction(rig.airframe, [0, 1, 0]), right = direction(rig.airframe, [1, 0, 0])
    closeTo(nose.x, 0); closeTo(nose.y, 1); closeTo(nose.z, 0)
    closeTo(right.x, Math.sqrt(3) / 2); closeTo(right.z, -.5)
    const [leftFront, rightFront] = rig.rotorMounts.map(mount => mount.getWorldPosition(new THREE.Vector3()))
    assert.ok(rightFront.z < leftFront.z)
  })
})

test('positive manual pitch raises the nose and positive yaw turns nose left', () => {
  withModel(neutral, rig => {
    applyInspectionPose(rig, { ...neutral, pitch: 30 })
    rig.drone.updateMatrixWorld(true)
    const noseUp = direction(rig.airframe, [0, 1, 0])
    closeTo(noseUp.x, 0); closeTo(noseUp.y, Math.sqrt(3) / 2); closeTo(noseUp.z, .5)
    const motors = rig.rotorMounts.map(mount => mount.getWorldPosition(new THREE.Vector3()))
    assert.ok(motors[0].z > motors[3].z, 'Front motor rises above rear motor')
    applyInspectionPose(rig, { ...neutral, yaw: 90 })
    rig.drone.updateMatrixWorld(true)
    const noseLeft = direction(rig.airframe, [0, 1, 0])
    closeTo(noseLeft.x, -1); closeTo(noseLeft.y, 0); closeTo(noseLeft.z, 0)
  })
})

test('beta banks the airframe independently of whole-aircraft attitude', () => {
  withModel(neutral, rig => {
    for (const beta of [-75, 0, 30, 75]) {
      applyInspectionPose(rig, { ...neutral, beta, roll: 21, pitch: 17, yaw: -39 })
      rig.drone.updateMatrixWorld(true)
      const roll = radians(21), pitch = radians(17), yaw = radians(-39), bank = radians(21 + beta)
      const expectedRotorUp = [
        Math.cos(yaw) * Math.sin(roll) + Math.sin(yaw) * Math.sin(pitch) * Math.cos(roll),
        Math.sin(yaw) * Math.sin(roll) - Math.cos(yaw) * Math.sin(pitch) * Math.cos(roll),
        Math.cos(pitch) * Math.cos(roll),
      ]
      for (const rotor of rig.rotorBlades) {
        direction(rotor, [0, 0, 1]).toArray().forEach((n, index) => closeTo(n, expectedRotorUp[index]))
      }
      const expectedRight = [
        Math.cos(yaw) * Math.cos(bank) - Math.sin(yaw) * Math.sin(pitch) * Math.sin(bank),
        Math.sin(yaw) * Math.cos(bank) + Math.cos(yaw) * Math.sin(pitch) * Math.sin(bank),
        -Math.cos(pitch) * Math.sin(bank),
      ]
      direction(rig.airframe, [1, 0, 0]).toArray().forEach((n, index) => closeTo(n, expectedRight[index]))
      assert.deepEqual(rig.drone.position.toArray(), [0, 0, 0])
    }
  })
})

test('numeric form values normalize without modifying the submitted input', () => {
  const input = Object.fromEntries(Object.entries(DEFAULT_INSPECTION).map(([key, value]) => [key, ` ${value} `]))
  const original = { ...input }
  assert.deepEqual(validateInspection(input), { ok: true, value: { ...DEFAULT_INSPECTION } })
  assert.deepEqual(input, original)
  const boundary = { ...neutral, spanX: 800, spanY: 1000, rotorDiameter: 500 }
  for (const [key, bounds] of Object.entries(INSPECTION_LIMITS)) {
    if (['spanX', 'spanY'].includes(key)) continue
    for (const value of bounds) assert.equal(validateInspection({ ...boundary, [key]: value }).ok, true)
  }
})

test('invalid, missing and out-of-range values cannot become an applied pose', () => {
  for (const key of Object.keys(DEFAULT_INSPECTION)) {
    for (const value of [undefined, null, '', ' ', true, false, NaN, Infinity, -Infinity, 'not-a-number', [], {}]) {
      assert.equal(validateInspection({ ...DEFAULT_INSPECTION, [key]: value }).ok, false, `${key} accepted ${String(value)}`)
    }
    const [min, max] = INSPECTION_LIMITS[key]
    for (const value of [min - .1, max + .1]) assert.equal(validateInspection({ ...DEFAULT_INSPECTION, [key]: value }).ok, false)
  }
  assert.equal(validateInspection(undefined).ok, false)
})

test('rotors cannot touch or overlap their neighbours in a neutral frame', () => {
  for (const value of [
    { ...neutral, rotorDiameter: 158 },
    { ...neutral, spanX: 200, spanY: 176, rotorDiameter: 176 },
    { ...neutral, rotorDiameter: 180 },
  ]) {
    const result = validateInspection(value)
    assert.equal(result.ok, false)
    assert.match(result.error, /旋翼直径/)
  }
  assert.equal(validateInspection({ ...neutral, rotorDiameter: 157.9 }).ok, true)
})
