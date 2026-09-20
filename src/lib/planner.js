import { createDroneModel, applyDronePose, sweptAircraftBounds, PASSAGE } from './droneModel.js'

export const DEFAULT_PLAN_PARAMS = Object.freeze({ gapWidth: .24, targetHeight: 2, maxTiltDeg: 65, clearance: .015, speed: .8 })

const LIMITS = {
  gapWidth: [.12, 1.2, '狭缝宽度', 'm'],
  targetHeight: [.3, 5, '目标悬停高度', 'm'],
  maxTiltDeg: [0, 75, '最大倾转角', '°'],
  clearance: [.005, .05, '单侧安全余量', 'm'],
  speed: [.1, 1.5, '最大飞行速度', 'm/s'],
}
const DEG = Math.PI / 180
const DT = .02
const TOLERANCE = 1e-9
const smooth = u => u * u * u * (10 + u * (-15 + 6 * u))
const fixedTime = t => Math.round(t * 1e9) / 1e9

function disposeModel(rig) {
  const geometries = new Set(), materials = new Set()
  rig.drone.traverse(part => {
    if (part.geometry) geometries.add(part.geometry)
    for (const surface of Array.isArray(part.material) ? part.material : [part.material]) {
      if (surface) materials.add(surface)
    }
  })
  geometries.forEach(geometry => geometry.dispose())
  materials.forEach(surface => surface.dispose())
}

/**
 * Geometry and kinematics only: no invented controller, forces, motor speeds,
 * reference tracking errors, or MATLAB results. Dimensions and rotor sweep are
 * obtained from the exact same aircraft model used by the Three.js renderer.
 */
export function planFlight(raw = DEFAULT_PLAN_PARAMS) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '请输入有效的规划参数。' }
  const parameters = { ...DEFAULT_PLAN_PARAMS, ...raw }
  for (const [key, [min, max, label, unit]] of Object.entries(LIMITS)) {
    if (typeof parameters[key] !== 'number' || !Number.isFinite(parameters[key]) || parameters[key] < min || parameters[key] > max) {
      return { ok: false, error: `${label}必须是 ${min}–${max} ${unit} 范围内的数值。`, details: { parameter: key, min, max } }
    }
  }

  let rig
  try {
    rig = createDroneModel()
    // A local envelope depends only on tilt because this planner explicitly
    // aligns the aircraft with the passage (roll = pitch = yaw = 0).
    const envelopes = new Map()
    const envelopeAt = tilt => {
      if (envelopes.has(tilt)) return envelopes.get(tilt)
      applyDronePose(rig, { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, tilt })
      const bounds = sweptAircraftBounds(rig)
      const envelope = { minX: bounds.min.x, maxX: bounds.max.x, minY: bounds.min.y, maxY: bounds.max.y, minZ: bounds.min.z, maxZ: bounds.max.z }
      envelopes.set(tilt, envelope)
      return envelope
    }
    const centeredWidth = envelope => 2 * Math.max(-envelope.minX, envelope.maxX)
    const requiredWidthAt = tilt => centeredWidth(envelopeAt(tilt)) + 2 * parameters.clearance
    const straightWidth = requiredWidthAt(0)
    const candidates = []
    for (let degrees = 0; degrees < parameters.maxTiltDeg; degrees += .25) candidates.push(degrees)
    candidates.push(parameters.maxTiltDeg)
    let selectedAngle = null, minPossibleWidth = Infinity
    for (const degrees of candidates) {
      const width = requiredWidthAt(degrees * DEG)
      minPossibleWidth = Math.min(minPossibleWidth, width)
      if (selectedAngle === null && width <= parameters.gapWidth + TOLERANCE) selectedAngle = degrees
    }
    if (selectedAngle === null) {
      return {
        ok: false,
        error: `当前机体在最大倾转 ${parameters.maxTiltDeg}°、单侧预留 ${(parameters.clearance * 1000).toFixed(0)} mm 时，至少需要 ${(Math.ceil(minPossibleWidth * 1000) / 1000).toFixed(3)} m 狭缝。请增大狭缝宽度、提高允许倾角或降低安全余量。`,
        details: { minPossibleWidth, straightWidth, gapWidth: parameters.gapWidth, maxTiltDeg: parameters.maxTiltDeg },
      }
    }

    const tilt = selectedAngle * DEG
    const passage = { ...PASSAGE, left: 1 - parameters.gapWidth / 2, right: 1 + parameters.gapWidth / 2 }
    const horizontalEnvelope = envelopeAt(0), transitEnvelope = envelopeAt(tilt)
    // Include every intermediate tilt when choosing a safe altitude for folding
    // outside the wall. Dense checks below also verify the interpolated poses.
    let lowestZ = horizontalEnvelope.minZ, highestZ = horizontalEnvelope.maxZ
    for (let degrees = 0; degrees <= selectedAngle; degrees += .1) {
      const envelope = envelopeAt(degrees * DEG)
      lowestZ = Math.min(lowestZ, envelope.minZ)
      highestZ = Math.max(highestZ, envelope.maxZ)
    }
    lowestZ = Math.min(lowestZ, transitEnvelope.minZ)
    highestZ = Math.max(highestZ, transitEnvelope.maxZ)
    // An extra millimetre absorbs tiny differences between tilt-grid samples.
    const lowestTransitHeight = -lowestZ + parameters.clearance + .001
    const highestTransitHeight = passage.height - highestZ - parameters.clearance - .001
    if (lowestTransitHeight > highestTransitHeight) return { ok: false, error: '机体在指定安全余量下无法满足通道高度和地面净距。' }
    const transitHeight = Math.min(highestTransitHeight, Math.max(parameters.targetHeight, lowestTransitHeight))
    const groundHeight = -horizontalEnvelope.minZ + .004
    // The body's origin stays above the ground when its landing skids touch it.
    const landingHeight = -horizontalEnvelope.minZ
    const landingSpeed = Math.min(parameters.speed, .4)
    const startY = passage.startY - 1
    const finishY = passage.endY + 1
    const start = { x: 1, y: startY, z: groundHeight, roll: 0, pitch: 0, yaw: 0, tilt: 0 }
    const segments = []
    let time = 0, previousPose = start
    const addSegment = (name, endPose, minimumDuration = .8, peakSpeed = parameters.speed) => {
      const distance = Math.hypot(endPose.x - previousPose.x, endPose.y - previousPose.y, endPose.z - previousPose.z)
      const degrees = Math.abs(endPose.tilt - previousPose.tilt) / DEG
      // Quintic smoothstep's peak derivative is 1.875, so these are actual
      // peak-rate limits, rather than merely mean speeds.
      const duration = Math.max(minimumDuration, 1.875 * distance / peakSpeed, 1.875 * degrees / 30)
      const nextTime = fixedTime(time + duration + 1e-9)
      segments.push({ name, from: time, to: nextTime, start: previousPose, end: endPose })
      previousPose = endPose
      time = nextTime
    }
    const lifted = { ...start, z: transitHeight }
    const folded = { ...lifted, tilt }
    const exited = { ...folded, y: finishY }
    const recovered = { ...exited, tilt: 0 }
    const hovering = { ...recovered, z: parameters.targetHeight }
    const landed = { ...hovering, z: landingHeight }
    addSegment('垂直起飞', lifted)
    addSegment('通道前倾转', folded)
    addSegment('倾转穿越狭缝', exited)
    addSegment('离开通道后恢复', recovered)
    addSegment('调整悬停高度', hovering)
    addSegment('稳定悬停', hovering, 3)
    addSegment('平稳降落', landed, 1, landingSpeed)
    addSegment('着陆完成', landed, 1.5)
    const duration = time
    const times = new Set([0, duration, ...segments.flatMap(segment => [segment.from, segment.to])])
    for (let tick = 1; tick * DT < duration; tick++) times.add(fixedTime(tick * DT))
    const sampleTimes = [...times].sort((a, b) => a - b)
    let segmentIndex = 0
    const samples = sampleTimes.map(t => {
      while (segmentIndex < segments.length - 1 && t > segments[segmentIndex].to) segmentIndex++
      const segment = segments[segmentIndex]
      if (t === segment.from) return { t, ...segment.start }
      if (t === segment.to) return { t, ...segment.end }
      const fraction = smooth(Math.min(1, Math.max(0, (t - segment.from) / (segment.to - segment.from))))
      const sample = { t }
      for (const key of Object.keys(start)) sample[key] = segment.start[key] + (segment.end[key] - segment.start[key]) * fraction
      return sample
    })

    let actualClearance = Infinity
    const inspectPose = sample => {
      const envelope = envelopeAt(sample.tilt)
      if (sample.z + envelope.minZ < -TOLERANCE) return '规划机体与地面相交。'
      const overlapsPassage = sample.y + envelope.maxY >= passage.startY && sample.y + envelope.minY <= passage.endY
      if (overlapsPassage) {
        const clearance = Math.min(sample.x + envelope.minX - passage.left, passage.right - sample.x - envelope.maxX)
        actualClearance = Math.min(actualClearance, clearance)
        if (clearance < parameters.clearance - TOLERANCE) return '规划轨迹不能保证旋翼与两侧墙壁的安全间隙。'
        if (sample.z + envelope.minZ < parameters.clearance - TOLERANCE || sample.z + envelope.maxZ > passage.height - parameters.clearance + TOLERANCE) return '规划机体超出了通道的有效高度范围。'
      }
      return null
    }
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]
      const error = inspectPose(sample)
      if (error) return { ok: false, error, details: { time: sample.t } }
      if (index > 0) {
        // Playback linearly interpolates the stored poses, so check the same
        // interpolation in addition to every generated sampling instant.
        const a = samples[index - 1]
        const midpoint = Object.fromEntries(Object.keys(sample).map(key => [key, (a[key] + sample[key]) / 2]))
        const midpointError = inspectPose(midpoint)
        if (midpointError) return { ok: false, error: midpointError, details: { time: midpoint.t } }
      }
    }
    const summary = {
      tiltDeg: selectedAngle,
      requiredWidth: requiredWidthAt(tilt),
      envelopeWidth: centeredWidth(transitEnvelope),
      actualClearance,
      transitHeight,
      targetHeight: parameters.targetHeight,
      landingHeight,
      landingSpeed,
      duration,
      minPossibleWidth,
      straightWidth,
    }
    const dataset = {
      schemaVersion: 1,
      metadata: {
        kind: 'synthetic',
        modelType: 'geometry-planner',
        title: `自主规划 · ${(parameters.gapWidth * 100).toFixed(1)} cm 狭缝 / ${parameters.targetHeight.toFixed(2)} m 悬停`,
        description: '根据原尺寸机体与完整旋翼扫掠包络计算安全倾转角，以五次平滑曲线生成起飞、穿越、退出、目标高度悬停与降落路径；悬停 3 秒后在通道出口外平稳着陆。',
        angleUnit: 'rad', positionUnit: 'm', timeUnit: 's',
        planner: { parameters: { ...parameters }, summary: { ...summary } },
        scene: { passage, hoverTarget: { x: hovering.x, y: hovering.y, z: hovering.z } },
        stages: segments.map(({ name, from, to }) => ({ name, from, to })),
        limitations: [
          '这是浏览器内的几何与运动学规划演示，不是 MATLAB/Simulink 闭环动力学仿真或实飞验证。',
          '无人机始终按实际固定尺寸显示，机体偏航角设为 0° 并沿通道对齐；安全检查包含完整旋翼扫掠范围。',
          '最大飞行速度和倾转角速度仅约束规划运动；未计算推力、电机转速、执行器能力、气动干扰或控制跟踪误差。',
          '当前仅支持直线、静态、已知尺寸通道；高目标高度在完全离开通道后达到。',
        ],
      },
      samples,
    }
    return { ok: true, dataset, summary }
  } catch (error) {
    return { ok: false, error: `生成规划时发生错误：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (rig) disposeModel(rig)
  }
}
