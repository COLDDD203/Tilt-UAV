import * as THREE from 'three'
import { DRONE_DIMENSIONS } from './droneModel.js'

// Angles are degrees. Span X/Y are opposing motor-centre distances in mm,
// not the full swept width/length; rotorDiameter is the full disc diameter.
export const DEFAULT_INSPECTION = Object.freeze({
  beta: 30,
  roll: 0,
  pitch: 0,
  yaw: 0,
  spanX: 158,
  spanY: 176,
  rotorDiameter: 130,
})

export const INSPECTION_LIMITS = Object.freeze({
  beta: Object.freeze([-75, 75]),
  roll: Object.freeze([-180, 180]),
  pitch: Object.freeze([-90, 90]),
  yaw: Object.freeze([-180, 180]),
  spanX: Object.freeze([120, 800]),
  spanY: Object.freeze([140, 1000]),
  rotorDiameter: Object.freeze([40, 500]),
})

const labels = { beta: '倾角 β', roll: '滚转角', pitch: '俯仰角', yaw: '偏航角', spanX: '左右电机间距', spanY: '前后电机间距', rotorDiameter: '旋翼直径' }

export function validateInspection(input) {
  const value = {}
  for (const [key, [min, max]] of Object.entries(INSPECTION_LIMITS)) {
    const raw = input?.[key]
    const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
    const number = numeric ? Number(raw) : NaN
    if (!Number.isFinite(number)) return { ok: false, error: `请输入有效的${labels[key]}` }
    if (number < min || number > max) {
      const unit = ['spanX', 'spanY', 'rotorDiameter'].includes(key) ? ' mm' : '°'
      return { ok: false, error: `${labels[key]}范围为 ${min}–${max}${unit}` }
    }
    value[key] = number
  }
  if (value.rotorDiameter >= Math.min(value.spanX, value.spanY)) {
    return { ok: false, error: '旋翼直径需小于左右和前后电机间距，避免旋翼相交' }
  }
  return { ok: true, value }
}

export function inspectionDimensions(value) {
  return {
    ...DRONE_DIMENSIONS,
    armHalfX: value.spanX / 2000,
    armHalfY: value.spanY / 2000,
    propellerRadius: value.rotorDiameter / 2000,
  }
}

const orientation = new THREE.Euler(0, 0, 0, 'ZXY')
const radians = degrees => degrees * Math.PI / 180

// Manual controls use the physical aircraft frame: nose +Y, right +X, up +Z.
// Positive roll lowers the right side (Ry), positive pitch raises the nose (Rx),
// and positive yaw turns the nose left around world +Z. Composition is Rz Rx Ry.
// This intentionally differs from recorded MATLAB Euler field names; the
// existing applyDronePose and experiment samples retain their original mapping.
// Beta tilts the frame while each motor compensates by -beta. Whole-aircraft
// roll/pitch still affect the rotors, so beta and attitude remain independent.
export function applyInspectionPose(rig, value) {
  rig.drone.position.set(0, 0, 0)
  orientation.set(radians(value.pitch), radians(value.roll), radians(value.yaw), 'ZXY')
  rig.drone.quaternion.setFromEuler(orientation)
  rig.airframe.rotation.set(0, radians(value.beta), 0)
  rig.rotorMounts.forEach(mount => { mount.rotation.set(0, -radians(value.beta), 0) })
}
