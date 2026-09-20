import * as THREE from 'three'
import { DRONE_DIMENSIONS } from './droneDimensions.js'
import { createInspectionModel } from './inspectionModel.js'

// Keep the established flight/planner API while sharing one aircraft geometry.
export { DRONE_DIMENSIONS } from './droneDimensions.js'

// These are the INNER wall faces; thickness extends outside the clear passage.
export const PASSAGE = Object.freeze({ left: .8, right: 1.2, thickness: .018, startY: 1, endY: 8, height: 2.5 })
export const wallCenters = () => [PASSAGE.left - PASSAGE.thickness / 2, PASSAGE.right + PASSAGE.thickness / 2]

export function createDroneModel(dimensions = DRONE_DIMENSIONS) {
  return createInspectionModel(dimensions)
}

const orientation = new THREE.Euler(0, 0, 0, 'ZYX')
export function applyDronePose(rig, sample, headingOffsetRad = 0) {
  rig.drone.position.set(sample.x, sample.y, sample.z)
  // An explicit scene calibration may align a recorded heading with the passage.
  // It changes only the display reference; measured angles remain untouched.
  orientation.set(sample.roll, sample.pitch, sample.yaw + headingOffsetRad, 'ZYX')
  rig.drone.quaternion.setFromEuler(orientation)
  // Nose is local +Y, right is +X: positive beta banks RIGHT, never nose-down.
  rig.airframe.rotation.set(0, sample.tilt, 0)
  const compensatedGroups = rig.tiltGroups ?? rig.rotorMounts
  compensatedGroups.forEach(group => { group.rotation.set(0, -sample.tilt, 0) })
}

// A conservative whole-aircraft bound including every propeller's FULL swept disk,
// independent of its animation phase. Used by geometry regression checks.
const vertex = new THREE.Vector3(), center = new THREE.Vector3(), radiusX = new THREE.Vector3(), radiusY = new THREE.Vector3(), radiusZ = new THREE.Vector3()
const meshBounds = new THREE.Box3()
export function sweptAircraftBounds(rig, target = new THREE.Box3()) {
  const propellerRadius = (rig.dimensions ?? DRONE_DIMENSIONS).propellerRadius
  rig.drone.updateMatrixWorld(true)
  target.makeEmpty()
  for (const part of rig.bodyMeshes) {
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox()
    meshBounds.copy(part.geometry.boundingBox).applyMatrix4(part.matrixWorld)
    target.union(meshBounds)
  }
  for (const rotor of rig.rotorBlades) {
    const elements = rotor.matrixWorld.elements
    center.setFromMatrixPosition(rotor.matrixWorld)
    radiusX.set(elements[0], elements[1], elements[2]).multiplyScalar(propellerRadius)
    radiusY.set(elements[4], elements[5], elements[6]).multiplyScalar(propellerRadius)
    radiusZ.set(elements[8], elements[9], elements[10]).multiplyScalar(.004)
    for (const sign of [-1, 1]) {
      vertex.set(
        center.x + sign * (Math.hypot(radiusX.x, radiusY.x) + Math.abs(radiusZ.x)),
        center.y + sign * (Math.hypot(radiusX.y, radiusY.y) + Math.abs(radiusZ.y)),
        center.z + sign * (Math.hypot(radiusX.z, radiusY.z) + Math.abs(radiusZ.z)),
      )
      target.expandByPoint(vertex)
    }
  }
  return target
}
