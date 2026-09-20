// Shared compact-aircraft mechanical clearances, in metres. The flight replay
// and the independent body inspector use the same geometry and support sizes.
export const INSPECTION_CLEARANCE = Object.freeze({
  maxBetaDeg: 90,
  rotorPlaneOffset: .028,
  rotorHalfThickness: .004,
  minBodyClearance: .004,
  minRotorEdgeGap: .001,
  centralHalfDepth: .016,
  minLongitudinalGap: .040,
})

// A finite rotor has thickness as well as diameter. Along the transverse span S,
// disk separation is (S cos(beta), S sin(beta)). With S >= 120 mm, a 1 mm edge
// gap gives >=15.46 mm vertical separation when XY projections first overlap,
// exceeding the two 4 mm half-thicknesses. The longitudinal gap remains invariant
// under all beta rotations; 40 mm leaves a 4 mm clearance on either side of the
// actual 32 mm central frame. The two longitudinal arms counter-rotate as complete
// groups, so their own motor/arm clearances remain constant without tall pylons.
export function validateInspectionRotorSpacing(value) {
  const { spanX, spanY, rotorDiameter } = value
  if (![spanX, spanY, rotorDiameter].every(Number.isFinite)) return '请输入有效的旋翼尺寸和中心距'
  const requiredGap = INSPECTION_CLEARANCE.minRotorEdgeGap * 1000
  if (spanX - rotorDiameter < requiredGap - 1e-9) {
    return '旋翼直径需比左右中心距至少小 1 mm，避免倾转时旋翼相交'
  }
  if (spanY - rotorDiameter < INSPECTION_CLEARANCE.minLongitudinalGap * 1000 - 1e-9) {
    return '前后中心距需比旋翼直径至少大 40 mm，为中央机架留出空间'
  }
  return null
}
