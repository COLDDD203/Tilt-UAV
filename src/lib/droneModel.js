import * as THREE from 'three'

// Metres, using UAVvideo.m's unscaled geometry (VISUAL_SCALE is display-only).
// Never resize the aircraft while it enters the passage.
export const DRONE_DIMENSIONS = Object.freeze({
  armHalfX: .079,
  armHalfY: .088,
  propellerRadius: .065,
  motorRadius: .009,
  motorHeight: .018,
  bodyHeight: .022,
})

// These are the INNER wall faces; thickness extends outside the clear passage.
export const PASSAGE = Object.freeze({ left: .8, right: 1.2, thickness: .018, startY: 1, endY: 8, height: 2.5 })
export const wallCenters = () => [PASSAGE.left - PASSAGE.thickness / 2, PASSAGE.right + PASSAGE.thickness / 2]

function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .66, metalness: .18, ...extra })
}
function mesh(geometry, surface, parent, position = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, surface)
  object.position.set(...position)
  object.castShadow = object.receiveShadow = true
  parent.add(object)
  return object
}
function cylinder(radius, height, surface, parent, position = [0, 0, 0]) {
  const object = mesh(new THREE.CylinderGeometry(radius, radius, height, 24), surface, parent, position)
  object.rotation.x = Math.PI / 2
  return object
}
function beam(a, b, radius, surface, parent) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b)
  const direction = end.clone().sub(start)
  const object = mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 12), surface, parent)
  object.position.copy(start).add(end).multiplyScalar(.5)
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return object
}

export function createDroneModel() {
  const drone = new THREE.Group(), airframe = new THREE.Group()
  drone.name = 'aircraft-metres'
  airframe.name = 'tilting-frame'
  drone.add(airframe)
  const rotorMounts = [], rotorBlades = []
  const carbon = material(0x344b58), carbonLight = material(0x587080)
  const body = material(0xf8fafb, { roughness: .32, metalness: .32 })
  const teal = material(0x0fa99a)
  const colors = [0x13ab9d, 0xf1ad5d, 0xf1ad5d, 0x13ab9d]
  const { armHalfX: x, armHalfY: y, propellerRadius, motorRadius, motorHeight, bodyHeight } = DRONE_DIMENSIONS

  // Central longitudinal frame and two transverse arms follow the MATLAB H frame.
  mesh(new THREE.BoxGeometry(.024, 2 * y + .020, bodyHeight), carbon, airframe)
  const shell = mesh(new THREE.SphereGeometry(1, 28, 18), body, airframe, [0, 0, .011])
  shell.scale.set(.022, .072, .017)
  mesh(new THREE.BoxGeometry(.008, .070, .002), teal, airframe, [0, 0, .028])
  for (const armY of [-y, y]) {
    mesh(new THREE.BoxGeometry(2 * x + .020, .012, .008), carbonLight, airframe, [0, armY, 0])
  }
  const heading = mesh(new THREE.ConeGeometry(.010, .025, 3), teal, airframe, [0, .077, .014])
  heading.rotation.y = Math.PI / 2
  const gimbal = mesh(new THREE.SphereGeometry(.010, 16, 12), carbon, airframe, [0, .042, -.017])
  cylinder(.004, .007, material(0x86cdd2, { metalness: .8, roughness: .12 }), gimbal, [0, 0, -.006])

  const corners = [[-x, y], [x, y], [x, -y], [-x, -y]]
  corners.forEach(([cx, cy], index) => {
    const mount = new THREE.Group()
    mount.name = `rotor-mount-${index + 1}`
    mount.position.set(cx, cy, .003)
    airframe.add(mount)
    rotorMounts.push(mount)
    cylinder(motorRadius, motorHeight, carbon, mount)
    cylinder(motorRadius, .005, material(colors[index]), mount, [0, 0, .009])
    const rotor = new THREE.Group()
    rotor.name = `propeller-${index + 1}`
    rotor.position.z = .015
    mount.add(rotor)
    rotorBlades.push(rotor)
    const blade = mesh(new THREE.BoxGeometry(.128, .010, .002), material(colors[index], { transparent: true, opacity: .82 }), rotor)
    blade.rotation.z = index % 2 ? .6 : -.6
    const disc = mesh(new THREE.CircleGeometry(propellerRadius, 64), new THREE.MeshBasicMaterial({
      color: colors[index], transparent: true, opacity: .12, side: THREE.DoubleSide, depthWrite: false,
    }), rotor, [0, 0, .001])
    disc.castShadow = false
    cylinder(.005, .004, body, rotor, [0, 0, .002])
  })
  for (const legX of [-.020, .020]) {
    beam([legX, .035, -.006], [legX, .040, -.035], .0025, carbon, airframe)
    beam([legX, -.035, -.006], [legX, -.040, -.035], .0025, carbon, airframe)
    beam([legX, -.053, -.035], [legX, .053, -.035], .0025, carbon, airframe)
  }
  drone.traverse(object => object.layers.enable(1))
  const bodyMeshes = []
  drone.traverse(object => {
    if (!object.isMesh) return
    for (let ancestor = object.parent; ancestor; ancestor = ancestor.parent) {
      if (rotorBlades.includes(ancestor)) return
    }
    bodyMeshes.push(object)
  })
  return { drone, airframe, rotorMounts, rotorBlades, bodyMeshes }
}

const orientation = new THREE.Euler(0, 0, 0, 'ZYX')
export function applyDronePose(rig, sample) {
  rig.drone.position.set(sample.x, sample.y, sample.z)
  orientation.set(sample.roll, sample.pitch, sample.yaw, 'ZYX')
  rig.drone.quaternion.setFromEuler(orientation)
  rig.airframe.rotation.y = sample.tilt
  rig.rotorMounts.forEach(mount => { mount.rotation.y = -sample.tilt })
}

// A conservative whole-aircraft bound including every propeller's FULL swept disk,
// independent of its animation phase. Used by geometry regression checks.
const vertex = new THREE.Vector3(), center = new THREE.Vector3(), radiusX = new THREE.Vector3(), radiusY = new THREE.Vector3(), radiusZ = new THREE.Vector3()
const meshBounds = new THREE.Box3()
export function sweptAircraftBounds(rig, target = new THREE.Box3()) {
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
    radiusX.set(elements[0], elements[1], elements[2]).multiplyScalar(DRONE_DIMENSIONS.propellerRadius)
    radiusY.set(elements[4], elements[5], elements[6]).multiplyScalar(DRONE_DIMENSIONS.propellerRadius)
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
