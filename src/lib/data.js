export const requiredFields = ['t', 'x', 'y', 'z', 'roll', 'pitch', 'yaw', 'tilt']
const optionalFields = ['refX', 'refY', 'refZ', 'u1', 'u2', 'u3', 'u4', 'w1', 'w2', 'w3', 'w4', 'ex', 'ey', 'ez', 'eRoll', 'ePitch', 'eYaw', 'savedFigureY', 'savedFigureZ']
const angleFields = ['roll', 'pitch', 'yaw', 'tilt', 'eRoll', 'ePitch', 'eYaw']
const referenceFields = ['refX', 'refY', 'refZ']

export function validateDataset(input) {
  if (!input || input.schemaVersion !== 1) throw new Error('数据格式不匹配：schemaVersion 必须为 1。')
  if (!input.metadata || !['rad', 'deg'].includes(input.metadata.angleUnit)) throw new Error('请在 metadata.angleUnit 中明确角度单位 rad 或 deg。')
  if (input.metadata.positionUnit !== 'm') throw new Error('位置单位必须为 m，请先在 MATLAB 中换算为米。')
  if (input.metadata.timeUnit !== undefined && input.metadata.timeUnit !== 's') throw new Error('时间单位必须为 s，请先换算为秒。')
  if (!Array.isArray(input.samples) || input.samples.length < 2) throw new Error('至少需要两个采样点。')
  if (input.samples.length > 100000) throw new Error('单次最多导入 100,000 个采样点，请先降低输出采样率。')
  const hasReferences = referenceFields.some(key => input.samples.some(s => s?.[key] !== undefined))
  const optionalPresent = optionalFields.filter(key => input.samples.some(s => s?.[key] !== undefined))
  const degreeInput = input.metadata.angleUnit === 'deg'
  const samples = input.samples.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 个采样点无效。`)
    const result = {}
    for (const key of [...requiredFields, ...optionalPresent]) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) throw new Error(`第 ${index + 1} 个采样点的 ${key} 必须为有限数值。`)
      result[key] = degreeInput && angleFields.includes(key) ? row[key] * Math.PI / 180 : row[key]
    }
    if (hasReferences && !referenceFields.every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))) throw new Error('参考轨迹必须同时提供完整的 refX、refY、refZ。')
    if (index > 0 && row.t <= input.samples[index - 1].t) throw new Error('时间 t 必须严格递增，不能重复或倒序。')
    return result
  })
  const metadata = { ...input.metadata, title: String(input.metadata.title || '导入的实验记录'), angleUnit: 'rad', positionUnit: 'm', timeUnit: 's' }
  if (metadata.scene !== undefined) {
    const passage = metadata.scene?.passage
    if (!passage || !['left', 'right', 'thickness', 'startY', 'endY', 'height'].every(k => typeof passage[k] === 'number' && Number.isFinite(passage[k]))) throw new Error('场景 passage 必须包含有效的墙体尺寸。')
    if (passage.right - passage.left < .05 || passage.right - passage.left > 10 || passage.thickness <= 0 || passage.thickness > 1 || passage.endY <= passage.startY || passage.endY - passage.startY > 1000 || passage.height <= 0 || passage.height > 1000 || Math.max(Math.abs(passage.left), Math.abs(passage.right), Math.abs(passage.startY), Math.abs(passage.endY)) > 10000) throw new Error('场景墙体尺寸超出显示范围。')
    const hoverTarget = metadata.scene.hoverTarget
    if (hoverTarget !== undefined && (!hoverTarget || !['x', 'y', 'z'].every(k => typeof hoverTarget[k] === 'number' && Number.isFinite(hoverTarget[k]) && Math.abs(hoverTarget[k]) <= 10000))) throw new Error('悬停目标必须包含有效的 x、y、z 坐标。')
  }
  if (metadata.stages !== undefined) {
    if (!Array.isArray(metadata.stages) || metadata.stages.length > 32) throw new Error('任务阶段必须为不超过 32 项的数组。')
    let previousEnd = samples[0].t
    for (const stage of metadata.stages) {
      if (!stage || typeof stage.name !== 'string' || !stage.name.trim() || stage.name.length > 60 || typeof stage.from !== 'number' || typeof stage.to !== 'number' || !Number.isFinite(stage.from) || !Number.isFinite(stage.to) || stage.from < previousEnd - 1e-8 || stage.to < stage.from || stage.to > samples.at(-1).t + 1e-8) throw new Error('任务阶段的名称或时间范围无效。')
      previousEnd = stage.to
    }
  }
  if (degreeInput) metadata.importNote = '导入时已将度统一换算为弧度；页面以度显示姿态。'
  return { schemaVersion: 1, metadata, samples }
}

export function sampleAt(samples, time) {
  if (!samples.length) return null
  if (time <= samples[0].t) return { ...samples[0] }
  if (time >= samples.at(-1).t) return { ...samples.at(-1) }
  let low = 0, high = samples.length - 1
  while (high - low > 1) {
    const mid = (low + high) >>> 1
    if (samples[mid].t <= time) low = mid
    else high = mid
  }
  const a = samples[low], b = samples[high], fraction = (time - a.t) / (b.t - a.t)
  const result = { t: time }
  for (const key of Object.keys(a)) {
    if (key === 't') continue
    let delta = b[key] - a[key]
    if (['roll', 'pitch', 'yaw'].includes(key)) delta = Math.atan2(Math.sin(delta), Math.cos(delta))
    result[key] = a[key] + delta * fraction
  }
  return result
}

export function errorMagnitude(sample) {
  if (!sample || !referenceFields.every(key => Number.isFinite(sample[key]))) return null
  return Math.hypot(sample.refX - sample.x, sample.refY - sample.y, sample.refZ - sample.z)
}

export function summarize(samples) {
  const result = { count: samples.length, duration: samples.at(-1).t - samples[0].t, maxAltitude: -Infinity, maxTilt: 0, rmse: null, maxError: null }
  let errorSquared = 0, timeWeight = 0, previousError = null
  samples.forEach((sample, index) => {
    result.maxAltitude = Math.max(result.maxAltitude, sample.z)
    result.maxTilt = Math.max(result.maxTilt, Math.abs(sample.tilt) * 180 / Math.PI)
    const error = errorMagnitude(sample)
    if (error !== null) {
      result.maxError = Math.max(result.maxError ?? 0, error)
      if (index && previousError !== null) {
        const dt = sample.t - samples[index - 1].t
        errorSquared += (previousError ** 2 + error ** 2) * .5 * dt
        timeWeight += dt
      }
    }
    previousError = error
  })
  if (timeWeight) result.rmse = Math.sqrt(errorSquared / timeWeight)
  return result
}

export function toCsv(samples) {
  const keys = Object.keys(samples[0])
  return '\ufeff' + keys.join(',') + '\r\n' + samples.map(s => keys.map(k => s[k]).join(',')).join('\r\n')
}

export function downloadText(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
