import * as THREE from 'three'
import { DRONE_DIMENSIONS } from './droneModel.js'
import { INSPECTION_CLEARANCE } from './inspectionClearance.js'

// An inspection-only mechanical model. The MATLAB replay uses droneModel.js.
// Every structural dimension is fixed when the model is built; changing beta
// only rotates the frame and the counter-rotating motor joints.
function surface(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .56, metalness: .28, ...extra })
}

function mesh(geometry, material, parent, position = [0, 0, 0], name = '') {
  const part = new THREE.Mesh(geometry, material)
  part.position.set(...position)
  part.name = name
  parent.add(part)
  return part
}

function cylinder(radius, height, material, parent, position, axis = 'z', name = '') {
  const part = mesh(new THREE.CylinderGeometry(radius, radius, height, 32), material, parent, position, name)
  if (axis === 'z') part.rotation.x = Math.PI / 2
  if (axis === 'x') part.rotation.z = Math.PI / 2
  return part
}

function beam(a, b, radius, material, parent, name = '') {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b)
  const direction = end.clone().sub(start)
  const part = mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 16), material, parent, [0, 0, 0], name)
  part.position.copy(start).add(end).multiplyScalar(.5)
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return part
}

function screw(parent, x, y, z, metal, dark, radius = .0017) {
  const head = cylinder(radius, .0011, metal, parent, [x, y, z], 'z', 'fastener')
  const slot = mesh(new THREE.BoxGeometry(radius * 1.2, radius * .25, .00014), dark, parent, [x, y, z + .0006], 'fastener-slot')
  slot.rotation.z = Math.PI / 4
  return head
}

function bladeGeometry(radius) {
  // A swept, tapered two-blade propeller, rather than a rectangular bar.
  // All profile points lie strictly within the full swept radius.
  const shape = new THREE.Shape()
  shape.moveTo(radius * .065, -radius * .026)
  shape.bezierCurveTo(radius * .24, -radius * .071, radius * .69, -radius * .083, radius * .975, -radius * .027)
  shape.quadraticCurveTo(radius * .993, 0, radius * .966, radius * .027)
  shape.bezierCurveTo(radius * .73, radius * .044, radius * .36, radius * .107, radius * .072, radius * .038)
  shape.closePath()
  const thickness = Math.min(.0018, radius * .025)
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 16, steps: 1 })
  geometry.translate(0, 0, -thickness / 2)
  return geometry
}

function bladeTipGeometry(radius, height) {
  const shape = new THREE.Shape()
  shape.moveTo(radius * .81, -radius * .055)
  shape.quadraticCurveTo(radius * .92, -radius * .044, radius * .975, -radius * .027)
  shape.quadraticCurveTo(radius * .993, 0, radius * .966, radius * .027)
  shape.lineTo(radius * .81, radius * .039)
  shape.closePath()
  const geometry = new THREE.ShapeGeometry(shape, 12)
  geometry.translate(0, 0, height)
  return geometry
}

function timingBelt(parent, left, right, y, radius, material) {
  const shape = new THREE.Shape()
  shape.moveTo(left, radius)
  shape.lineTo(right, radius)
  shape.absarc(right, 0, radius, Math.PI / 2, -Math.PI / 2, true)
  shape.lineTo(left, -radius)
  shape.absarc(left, 0, radius, -Math.PI / 2, Math.PI / 2, true)
  const inner = radius - .0012
  const hole = new THREE.Path()
  hole.moveTo(left, inner)
  hole.absarc(left, 0, inner, Math.PI / 2, Math.PI * 1.5, false)
  hole.lineTo(right, -inner)
  hole.absarc(right, 0, inner, -Math.PI / 2, Math.PI / 2, false)
  hole.lineTo(left, inner)
  shape.holes.push(hole)
  const belt = mesh(new THREE.ExtrudeGeometry(shape, { depth: .002, bevelEnabled: false, curveSegments: 20 }), material, parent, [0, y + .001, 0], 'synchronous-belt')
  belt.rotation.x = Math.PI / 2
  return belt
}

export function createInspectionModel(dimensions = DRONE_DIMENSIONS) {
  const modelDimensions = Object.freeze({ ...DRONE_DIMENSIONS, ...dimensions })
  for (const [key, value] of Object.entries(modelDimensions)) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid inspection dimension: ${key}`)
  }
  const { armHalfX: x, armHalfY: y, propellerRadius: radius } = modelDimensions
  const { rotorPlaneOffset: h, rotorHalfThickness } = INSPECTION_CLEARANCE
  const drone = new THREE.Group(), airframe = new THREE.Group()
  drone.name = 'inspection-aircraft-metres'
  airframe.name = 'tilting-frame'
  drone.add(airframe)
  const carbon = surface(0x2b393c, { roughness: .65, metalness: .20 })
  const carbonLight = surface(0x435456, { roughness: .53, metalness: .32 })
  const rubber = surface(0x2b302e, { roughness: .86, metalness: .05 })
  const aluminium = surface(0xa6b4ac, { roughness: .34, metalness: .7 })
  const teal = surface(0x418d7c, { roughness: .41, metalness: .30 })
  const paleTeal = surface(0x9cc9b1, { roughness: .43, metalness: .2 })
  const purple = surface(0x837491, { roughness: .45, metalness: .29 })
  const ochre = surface(0xc8a15b, { roughness: .43, metalness: .28 })
  const board = surface(0x3b6661, { roughness: .65, metalness: .13 })
  const black = surface(0x212a2b, { roughness: .6, metalness: .24 })
  const centralFrame = new THREE.Group()
  centralFrame.name = 'central-twin-beam-frame'
  airframe.add(centralFrame)
  const jointMeshes = []

  // The paired crossbeams and synchronous belts occupy the clear strip between
  // the FRONT and REAR propeller disks. Their Y extent is at most 16 mm.
  // Beta does not change Y, so the whole frame stays outside those disks even
  // at the maximum bank angle; no tall rotor pylons are required.
  for (const beamY of [-.0125, .0125]) {
    cylinder(.0028, 2 * x, teal, centralFrame, [0, beamY, 0], 'x', 'central-crossbeam')
    for (const side of [-1, 1]) cylinder(.0032, .008, aluminium, centralFrame, [side * (x - .006), beamY, 0], 'x', 'crossbeam-collar')
  }
  for (const side of [-1, 1]) {
    const bearing = new THREE.Group()
    bearing.name = `side-arm-bearing-${side}`
    bearing.position.set(side * x, 0, 0)
    centralFrame.add(bearing)
    for (const bearingY of [-.011, .011]) {
      cylinder(.0073, .005, carbonLight, bearing, [0, bearingY, 0], 'y', 'arm-bearing-housing')
      cylinder(.0057, .0014, aluminium, bearing, [0, bearingY + Math.sign(bearingY) * .0032, 0], 'y', 'bearing-end-ring')
    }
    bearing.traverse(part => { if (part.isMesh) jointMeshes.push(part) })
  }
  mesh(new THREE.BoxGeometry(.022, .015, .016), carbon, centralFrame, [0, 0, .009], 'tilt-servo-case')
  mesh(new THREE.BoxGeometry(.017, .0155, .003), purple, centralFrame, [0, 0, .018], 'servo-top-cover')
  for (const side of [-1, 1]) {
    const beltY = side * .005
    const endX = side * (x - .001)
    cylinder(.006, .0028, purple, centralFrame, [0, beltY, 0], 'y', 'servo-drive-pulley')
    cylinder(.006, .0028, purple, centralFrame, [endX, beltY, 0], 'y', 'side-arm-pulley')
    timingBelt(centralFrame, Math.min(0, endX), Math.max(0, endX), beltY, .0068, rubber)
  }
  for (const sx of [-.0075, .0075]) screw(centralFrame, sx, 0, .0201, aluminium, carbon, .0012)

  // A small, exposed IMU carrier compensates beta with the two side arms.
  // It remains inside the same clear Y strip and avoids a bulky outer fairing.
  const imuMount = new THREE.Group()
  imuMount.name = 'compensated-imu-carrier'
  airframe.add(imuMount)
  for (const bearingY of [-.0125, .0125]) {
    cylinder(.0037, .003, aluminium, centralFrame, [0, bearingY, 0], 'y', 'imu-pivot-bearing')
  }
  cylinder(.0023, .029, carbonLight, imuMount, [0, 0, 0], 'y', 'imu-pivot-shaft')
  for (const carrierY of [-.0085, .0085]) {
    beam([-.018, carrierY, -.002], [.018, carrierY, -.002], .0013, aluminium, imuMount, 'imu-suspension-crossbar')
    beam([-.018, carrierY, -.015], [.018, carrierY, -.015], .0013, aluminium, imuMount, 'imu-carrier-rail')
    for (const side of [-1, 1]) beam([side * .018, carrierY, -.015], [side * .018, carrierY, -.002], .0012, carbonLight, imuMount, 'imu-carrier-tab')
  }
  mesh(new THREE.BoxGeometry(.026, .013, .002), board, imuMount, [0, 0, -.016], 'imu-circuit-board')
  mesh(new THREE.BoxGeometry(.008, .006, .0028), black, imuMount, [0, 0, -.0138], 'imu-chip')
  for (const side of [-1, 1]) {
    mesh(new THREE.BoxGeometry(.003, .004, .0018), aluminium, imuMount, [side * .009, 0, -.0141], 'imu-connector')
    screw(imuMount, side * .0105, .004, -.0144, ochre, carbon, .00085)
  }
  // This arrow is on the level IMU carrier and always identifies physical +Y.
  const nose = mesh(new THREE.ConeGeometry(.0032, .009, 3), paleTeal, imuMount, [0, .010, -.015], 'nose-marker')
  nose.rotation.y = Math.PI / 2

  const centralMeshes = []
  centralFrame.traverse(part => { if (part.isMesh) centralMeshes.push(part) })
  imuMount.traverse(part => { if (part.isMesh) centralMeshes.push(part) })
  const sideArmGroups = [], sideArmMeshes = [], motorMeshes = [], rotorMounts = [], rotorBlades = []
  let index = 0
  for (const side of [-1, 1]) {
    const arm = new THREE.Group()
    arm.name = side < 0 ? 'left-compensated-arm' : 'right-compensated-arm'
    arm.position.set(side * x, 0, 0)
    airframe.add(arm)
    sideArmGroups.push(arm)
    cylinder(.0035, 2 * y + .009, carbonLight, arm, [0, 0, 0], 'y', 'longitudinal-side-arm')
    cylinder(.0046, .027, purple, arm, [0, 0, 0], 'y', 'central-arm-journal')
    beam([0, -y, -.004], [0, y, -.004], .0007, rubber, arm, 'side-arm-cable')
    for (const front of [1, -1]) {
      const rotorIndex = index++
      const accent = front > 0 ? teal : purple
      const mount = new THREE.Group()
      mount.name = `rotor-mount-${rotorIndex + 1}`
      mount.position.set(0, front * y, 0)
      arm.add(mount)
      rotorMounts.push(mount)
      // Short motor cradle, directly attached to the longitudinal arm. Its
      // compact U profile follows the reference mechanism, with no long posts.
      const motor = new THREE.Group()
      motor.name = `motor-housing-${rotorIndex + 1}`
      mount.add(motor)
      for (const cradleX of [-.0066, .0066]) {
        mesh(new THREE.BoxGeometry(.0024, .009, .022), accent, motor, [cradleX, 0, -.004], 'motor-cradle-cheek')
      }
      mesh(new THREE.BoxGeometry(.0156, .009, .0025), accent, motor, [0, 0, -.015], 'motor-cradle-base')
      cylinder(.005, .010, aluminium, motor, [0, 0, 0], 'y', 'motor-arm-collar')
      cylinder(.0075, .007, aluminium, motor, [0, 0, .005], 'z', 'motor-base')
      cylinder(.0092, .012, carbon, motor, [0, 0, h - .014], 'z', 'motor-can')
      cylinder(.0095, .0015, aluminium, motor, [0, 0, h - .020], 'z', 'motor-lower-ring')
      cylinder(.0095, .0016, aluminium, motor, [0, 0, h - .007], 'z', 'motor-upper-ring')
      cylinder(.0078, .0016, accent, motor, [0, 0, h - .0056], 'z', 'motor-color-band')
      for (let fin = 0; fin < 10; fin++) {
        const theta = fin * Math.PI / 5
        const rib = mesh(new THREE.BoxGeometry(.00065, .001, .007), carbonLight, motor, [.009 * Math.cos(theta), .009 * Math.sin(theta), h - .014], 'motor-cooling-fin')
        rib.rotation.z = theta
      }
      cylinder(.0022, .005, aluminium, motor, [0, 0, h - .0032], 'z', 'propeller-spindle')
      motor.traverse(part => { if (part.isMesh) motorMeshes.push(part) })
      const rotor = new THREE.Group()
      rotor.name = `propeller-${rotorIndex + 1}`
      rotor.position.z = h
      rotor.rotation.z = (rotorIndex % 2 ? Math.PI / 2 : 0) + .25
      mount.add(rotor)
      rotorBlades.push(rotor)
      const blades = bladeGeometry(radius)
      const tips = bladeTipGeometry(radius, Math.min(.0018, radius * .025) / 2 + .00005)
      for (const rotation of [0, Math.PI]) {
        mesh(blades, carbonLight, rotor, [0, 0, 0], 'tapered-propeller-blade').rotation.z = rotation
        mesh(tips, front > 0 ? teal : purple, rotor, [0, 0, 0], 'propeller-tip-mark').rotation.z = rotation
      }
      const hubRadius = Math.min(.005, radius * .24)
      cylinder(hubRadius, .003, carbon, rotor, [0, 0, 0], 'z', 'propeller-hub')
      cylinder(hubRadius * .53, .0025, aluminium, rotor, [0, 0, .002], 'z', 'propeller-retainer')
      mesh(new THREE.CircleGeometry(radius, 96), new THREE.MeshBasicMaterial({
        color: front > 0 ? 0x69a992 : 0x9c8aad,
        transparent: true, opacity: .05, side: THREE.DoubleSide, depthWrite: false,
      }), rotor, [0, 0, 0], 'full-rotor-swept-disc')
    }
  }
  const bodyMeshes = []
  drone.traverse(part => {
    if (!part.isMesh) return
    for (let ancestor = part.parent; ancestor; ancestor = ancestor.parent) {
      if (rotorBlades.includes(ancestor)) return
    }
    bodyMeshes.push(part)
    for (let ancestor = part.parent; ancestor; ancestor = ancestor.parent) {
      if (sideArmGroups.includes(ancestor)) { sideArmMeshes.push(part); break }
    }
  })
  return {
    drone, airframe, rotorMounts, rotorBlades, bodyMeshes, centralMeshes,
    frameMeshes: centralMeshes, pylonMeshes: [], jointMeshes, motorMeshes,
    sideArmGroups, sideArmMeshes, imuMount, tiltGroups: [...sideArmGroups, imuMount],
    dimensions: modelDimensions,
    clearance: Object.freeze({ ...INSPECTION_CLEARANCE, rotorPlaneOffset: h, rotorHalfThickness, architecture: 'paired-side-arms' }),
  }
}
