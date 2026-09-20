import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createDroneModel } from '../src/lib/droneModel.js'
import { createInspectionModel } from '../src/lib/inspectionModel.js'
import { applyInspectionPose, DEFAULT_INSPECTION, inspectionDimensions, validateInspection } from '../src/lib/inspection.js'
import { INSPECTION_CLEARANCE } from '../src/lib/inspectionClearance.js'

const EPS = 1e-8
const neutral = { ...DEFAULT_INSPECTION, beta: 0, roll: 0, pitch: 0, yaw: 0 }
const cases = [
  neutral,
  { ...neutral, spanX: 120, spanY: 140, rotorDiameter: 40 },
  { ...neutral, spanX: 120, spanY: 159, rotorDiameter: 119 },
  { ...neutral, spanX: 158, spanY: 197, rotorDiameter: 157 },
  { ...neutral, spanX: 800, spanY: 140, rotorDiameter: 100 },
  { ...neutral, spanX: 120, spanY: 1000, rotorDiameter: 119 },
  { ...neutral, spanX: 800, spanY: 1000, rotorDiameter: 40 },
  { ...neutral, spanX: 501, spanY: 540, rotorDiameter: 500 },
  { ...neutral, spanX: 800, spanY: 1000, rotorDiameter: 500 },
]

function dispose(rig) {
  const geometries = new Set(), materials = new Set()
  rig.drone.traverse(part => {
    if (part.geometry) geometries.add(part.geometry)
    if (part.material) materials.add(part.material)
  })
  geometries.forEach(item => item.dispose())
  materials.forEach(item => item.dispose())
}

function isDescendant(part, ancestor) {
  for (let current = part; current; current = current.parent) if (current === ancestor) return true
  return false
}

function verticesIn(part, target) {
  const transform = new THREE.Matrix4().copy(target.matrixWorld).invert().multiply(part.matrixWorld)
  const positions = part.geometry.attributes.position
  return Array.from({ length: positions.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(transform))
}

// Independent exact clipping of each rendered triangle to the complete rotor's
// finite-height slab. A clipped convex polygon hits the disk iff its XY distance
// from the axis is at most the radius. This tests actual mesh vertices rather
// than repeating the model's clearance formula or relying on screenshots/AABBs.
function clipZ(polygon, boundary, keepAbove) {
  const result = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const insideA = keepAbove ? a.z >= boundary : a.z <= boundary
    const insideB = keepAbove ? b.z >= boundary : b.z <= boundary
    if (insideA) result.push(a)
    if (insideA !== insideB) result.push(a.clone().lerp(b, (boundary - a.z) / (b.z - a.z)))
  }
  return result
}

function polygonDistanceSquared(polygon) {
  let distance = Infinity, positive = false, negative = false
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const denominator = dx * dx + dy * dy
    const t = denominator ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / denominator)) : 0
    distance = Math.min(distance, (a.x + t * dx) ** 2 + (a.y + t * dy) ** 2)
    const cross = a.x * b.y - a.y * b.x
    if (cross > 1e-14) positive = true
    if (cross < -1e-14) negative = true
  }
  if (polygon.length >= 3 && positive !== negative) return 0
  return distance
}

function meshHitsDisc(part, rotor, radius, halfThickness) {
  if (!part.geometry.boundingBox) part.geometry.computeBoundingBox()
  const transform = new THREE.Matrix4().copy(rotor.matrixWorld).invert().multiply(part.matrixWorld)
  const broad = part.geometry.boundingBox.clone().applyMatrix4(transform)
  if (broad.min.z > halfThickness || broad.max.z < -halfThickness) return false
  const nearX = Math.max(broad.min.x, Math.min(0, broad.max.x))
  const nearY = Math.max(broad.min.y, Math.min(0, broad.max.y))
  if (nearX * nearX + nearY * nearY > radius * radius) return false
  const positions = part.geometry.attributes.position, index = part.geometry.index
  const count = index?.count ?? positions.count
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(i + offset) : i + offset).applyMatrix4(transform))
    const polygon = clipZ(clipZ(triangle, -halfThickness, true), halfThickness, false)
    if (polygon.length && polygonDistanceSquared(polygon) <= radius * radius) return true
  }
  return false
}

function assertNoRotorCollision(rig, label) {
  rig.drone.updateMatrixWorld(true)
  const radius = rig.dimensions.propellerRadius, thickness = INSPECTION_CLEARANCE.rotorHalfThickness
  for (let i = 0; i < rig.rotorBlades.length; i++) {
    const rotor = rig.rotorBlades[i]
    for (const part of rig.bodyMeshes) {
      // The thin central spindle intentionally joins its own hub. Every other
      // solid, including the rest of that motor and all foreign pods, is tested.
      if (part.name === 'propeller-spindle' && isDescendant(part, rig.rotorMounts[i])) continue
      assert.equal(meshHitsDisc(part, rotor, radius, thickness), false, `${label}: ${rotor.name} intersects ${part.name}`)
    }
    for (let j = i + 1; j < rig.rotorBlades.length; j++) {
      const separation = rig.rotorBlades[j].getWorldPosition(new THREE.Vector3())
      rotor.worldToLocal(separation)
      assert.ok(Math.hypot(separation.x, separation.y) >= 2 * radius - EPS || Math.abs(separation.z) >= 2 * thickness - EPS,
        `${label}: swept disks ${i}/${j} intersect`)
    }
  }
}

test('the reported beta 30 arm collision is reproduced in the former model and absent from the inspector', () => {
  const previous = createDroneModel(), current = createInspectionModel()
  try {
    applyInspectionPose(previous, DEFAULT_INSPECTION)
    previous.drone.updateMatrixWorld(true)
    assert.ok(previous.rotorBlades.some(rotor => previous.bodyMeshes.some(part =>
      part.parent === previous.airframe && meshHitsDisc(part, rotor, .065, .004))), 'The regression must reproduce the actual old arm/disk intersection')
    applyInspectionPose(current, DEFAULT_INSPECTION)
    assertNoRotorCollision(current, 'default beta 30')
  } finally { dispose(previous); dispose(current) }
})

test('every rendered solid and the complete propeller fit their declared inspection envelopes', () => {
  for (const value of cases) {
    const rig = createInspectionModel(inspectionDimensions(value))
    try {
      applyInspectionPose(rig, value)
      rig.drone.updateMatrixWorld(true)
      const classified = new Set([...rig.centralMeshes, ...rig.sideArmMeshes])
      assert.equal(classified.size, rig.bodyMeshes.length)
      assert.ok(rig.bodyMeshes.every(part => classified.has(part)), 'Every nonrotor solid has a clearance classification')
      rig.drone.traverse(part => {
        if (!part.isMesh) return
        assert.ok(classified.has(part) || rig.rotorBlades.some(rotor => isDescendant(part, rotor)), `Unaccounted mesh: ${part.name}`)
      })
      for (const part of rig.centralMeshes) for (const vertex of verticesIn(part, rig.airframe)) {
        assert.ok(Math.abs(vertex.y) <= INSPECTION_CLEARANCE.centralHalfDepth + EPS, `${part.name} exceeds the central frame's longitudinal band`)
      }
      assert.equal(rig.pylonMeshes.length, 0, 'The compact model contains no raised motor pylons')
      assert.equal(rig.sideArmGroups.length, 2)
      for (const side of rig.sideArmGroups) assert.equal(side.position.z, 0, 'The arm pivots sit directly on the central frame')
      for (const rotor of rig.rotorBlades) rotor.traverse(part => {
        if (!part.isMesh) return
        for (const vertex of verticesIn(part, rotor)) {
          assert.ok(Math.hypot(vertex.x, vertex.y) <= rig.dimensions.propellerRadius + EPS, `${part.name} exceeds swept radius`)
          assert.ok(Math.abs(vertex.z) <= INSPECTION_CLEARANCE.rotorHalfThickness + EPS, `${part.name} exceeds swept thickness`)
        }
      })
    } finally { dispose(rig) }
  }
})

test('actual central frame and whole side-arm groups certify the continuous beta interval through 90 degrees', () => {
  for (const value of cases) {
    const rig = createInspectionModel(inspectionDimensions(value))
    try {
      applyInspectionPose(rig, value)
      rig.drone.updateMatrixWorld(true)
      const { rotorPlaneOffset: h, rotorHalfThickness: delta } = rig.clearance
      const radius = rig.dimensions.propellerRadius
      // Ry(beta), its compensation and rotor spin never alter the central band
      // in Y. This proves clearance for the full interval, including ±90 degrees.
      for (const part of rig.centralMeshes) for (const vertex of verticesIn(part, rig.airframe)) {
        const distanceToNearestDisc = value.spanY / 2000 - radius - Math.abs(vertex.y)
        assert.ok(distanceToNearestDisc >= INSPECTION_CLEARANCE.minBodyClearance - EPS, `${part.name} leaves the protected central band`)
      }
      for (const side of rig.sideArmGroups) {
        const parts = rig.sideArmMeshes.filter(part => isDescendant(part, side))
        let radialXZ = 0
        for (const part of parts) for (const vertex of verticesIn(part, side)) {
          radialXZ = Math.max(radialXZ, Math.hypot(vertex.x, vertex.z))
          if (part.name !== 'propeller-spindle') assert.ok(vertex.z < h - delta - EPS, `${part.name} can reach its own group's rotor plane`)
        }
        // The entire compensated side group has a fixed XZ cross-section,
        // independent of its Y length. Other-side pivot separation is S; its
        // distance from this rotor centre is >= S-h by the triangle inequality.
        assert.ok(value.spanX / 1000 - h > radialXZ + Math.hypot(radius, delta), 'An opposite side arm can reach a rotor at some beta')
      }
      // The finite-height disks first overlap in XY only after their vertical
      // separation already exceeds the full blade/hub envelope.
      const span = value.spanX / 1000
      assert.ok(Math.sqrt(span * span - (2 * radius) ** 2) > 2 * delta)
      assert.ok(value.spanY / 1000 - 2 * radius >= .040 - EPS)
    } finally { dispose(rig) }
  }
})

test('dense actual-mesh checks clear every rotor at default and extreme accepted dimensions', () => {
  let poses = 0
  for (let index = 0; index < cases.length; index++) {
    const value = cases[index]
    assert.equal(validateInspection(value).ok, true)
    const rig = createInspectionModel(inspectionDimensions(value))
    const fixed = []
    rig.drone.traverse(part => fixed.push({ part, position: part.position.toArray(), scale: part.scale.toArray(), geometry: part.geometry, visible: part.visible }))
    try {
      const step = index === 0 ? .5 : 2.5
      for (let beta = -90; beta <= 90; beta += step) {
        applyInspectionPose(rig, { ...value, beta })
        assertNoRotorCollision(rig, `size case ${index}, beta ${beta}`)
        poses++
      }
      for (const before of fixed) {
        assert.deepEqual(before.part.position.toArray(), before.position)
        assert.deepEqual(before.part.scale.toArray(), before.scale)
        assert.equal(before.part.geometry, before.geometry)
        assert.equal(before.part.visible, before.visible)
      }
    } finally { dispose(rig) }
  }
  assert.equal(poses, 945)
})

test('full rigid-body roll, pitch and yaw preserve the certified internal clearances', () => {
  for (const value of [cases[0], cases[2], cases[7]]) {
    const rig = createInspectionModel(inspectionDimensions(value))
    try {
      for (const pose of [
        { beta: -90, roll: -180, pitch: -90, yaw: -180 },
        { beta: 90, roll: 180, pitch: 90, yaw: 180 },
        { beta: 30, roll: 39, pitch: -27, yaw: 113 },
        { beta: -52.6, roll: -142.3, pitch: 64.7, yaw: -87.1 },
      ]) {
        applyInspectionPose(rig, { ...value, ...pose })
        assertNoRotorCollision(rig, `rigid body ${JSON.stringify(pose)}`)
      }
    } finally { dispose(rig) }
  }
})

test('both complete side arms and the IMU compensate beta once while whole-body attitude stays independent', () => {
  const rig = createInspectionModel()
  try {
    assert.equal(rig.tiltGroups.length, 3, 'Two complete side arms plus the central IMU share the belt compensation')
    for (const attitude of [{ roll: 0, pitch: 0, yaw: 0 }, { roll: 21, pitch: 17, yaw: -39 }]) {
      const roll = attitude.roll * Math.PI / 180, pitch = attitude.pitch * Math.PI / 180, yaw = attitude.yaw * Math.PI / 180
      const expected = new THREE.Vector3(
        Math.cos(yaw) * Math.sin(roll) + Math.sin(yaw) * Math.sin(pitch) * Math.cos(roll),
        Math.sin(yaw) * Math.sin(roll) - Math.cos(yaw) * Math.sin(pitch) * Math.cos(roll),
        Math.cos(pitch) * Math.cos(roll),
      )
      for (const beta of [-90, 0, 30, 60, 90]) {
        applyInspectionPose(rig, { ...neutral, ...attitude, beta })
        rig.drone.updateMatrixWorld(true)
        for (const group of [...rig.tiltGroups, ...rig.rotorBlades]) {
          const up = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld)
          assert.ok(up.distanceTo(expected) < EPS, `${group.name} applies beta incorrectly at ${beta} degrees`)
        }
        for (const mount of rig.rotorMounts) assert.equal(mount.rotation.y, 0, 'Motor mounts must not apply beta a second time')
      }
    }
  } finally { dispose(rig) }
})

test('accepted dimensions reserve real space for the compact frame and beta includes both 90-degree endpoints', () => {
  assert.equal(validateInspection({ ...neutral, spanX: 120, spanY: 159, rotorDiameter: 119 }).ok, true)
  for (const diameter of [119.001, 119.999999, 120]) assert.equal(validateInspection({ ...neutral, spanX: 120, rotorDiameter: diameter }).ok, false)
  assert.equal(validateInspection({ ...neutral, spanY: 170 }).ok, true)
  assert.equal(validateInspection({ ...neutral, spanY: 169.999 }).ok, false)
  for (const beta of [-90, 90]) assert.equal(validateInspection({ ...neutral, beta }).ok, true)
  for (const beta of [-90.001, 90.001]) assert.equal(validateInspection({ ...neutral, beta }).ok, false)
  assert.equal(INSPECTION_CLEARANCE.rotorPlaneOffset, .028, 'The motor seat remains a short fixed bracket')
})
