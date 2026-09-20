import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateDataset, sampleAt, errorMagnitude, summarize, toCsv } from '../src/lib/data.js'

const deg = value => value * Math.PI / 180
const closeTo = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Number.isFinite(actual), `Expected a finite value; received ${actual}`)
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`)
}
const sample = (t, extra = {}) => ({ t, x: 0, y: 0, z: 1, roll: 0, pitch: 0, yaw: 0, tilt: 0, ...extra })
const dataset = (samples = [sample(0), sample(1)], metadata = {}) => ({
  schemaVersion: 1,
  metadata: { title: 'Imported experiment', angleUnit: 'rad', positionUnit: 'm', ...metadata },
  samples,
})

test('import refuses data whose schema or physical units are ambiguous', () => {
  for (const input of [
    null,
    { ...dataset(), schemaVersion: 2 },
    { ...dataset(), metadata: undefined },
    dataset(undefined, { angleUnit: undefined }),
    dataset(undefined, { angleUnit: 'radian' }),
    dataset(undefined, { positionUnit: 'cm' }),
    dataset(undefined, { timeUnit: 'ms' }),
    dataset([]),
    dataset([sample(0)]),
  ]) assert.throws(() => validateDataset(input))
})

test('every required signal must be a finite number at every timestamp', () => {
  for (const field of ['t', 'x', 'y', 'z', 'roll', 'pitch', 'yaw', 'tilt']) {
    for (const invalidValue of [undefined, null, NaN, Infinity, -Infinity, '1']) {
      const input = dataset([sample(0), sample(1, { [field]: invalidValue })])
      assert.throws(() => validateDataset(input), `${field}=${String(invalidValue)} should not be imported`)
    }
  }
  assert.throws(() => validateDataset(dataset([sample(0), null])))
})

test('repeated or reversed timestamps cannot silently corrupt playback', () => {
  for (const times of [[0, 0], [2, 1], [0, 2, 1], [0, 2, 2]]) {
    assert.throws(() => validateDataset(dataset(times.map(t => sample(t)))))
  }
})

test('an experiment can start at a nonzero timestamp without shifting its time base', () => {
  const input = dataset([sample(12.5), sample(13), sample(16.25)])
  const result = validateDataset(input)
  assert.deepEqual(result.samples.map(row => row.t), [12.5, 13, 16.25])
  closeTo(summarize(result.samples).duration, 3.75)
  assert.equal(sampleAt(result.samples, 14).t, 14)
})

test('degree imports normalize all angles and retain position, reference, and actuator units', () => {
  const input = dataset([
    sample(5, { x: 7, roll: 180, pitch: -90, yaw: 270, tilt: 45, refX: 8, refY: 9, refZ: 10, w1: 125 }),
    sample(6, { x: 8, roll: 90, pitch: 0, yaw: 360, tilt: -45, refX: 9, refY: 10, refZ: 11, w1: 150 }),
  ], { angleUnit: 'deg', source: 'User MATLAB export', synthetic: false })
  const original = structuredClone(input)
  const result = validateDataset(input)
  assert.equal(result.metadata.angleUnit, 'rad')
  assert.equal(result.metadata.source, 'User MATLAB export')
  assert.equal(result.metadata.synthetic, false)
  for (const [field, expected] of Object.entries({ roll: Math.PI, pitch: -Math.PI / 2, yaw: Math.PI * 1.5, tilt: Math.PI / 4 })) {
    closeTo(result.samples[0][field], expected)
  }
  assert.equal(result.samples[0].x, 7)
  assert.equal(result.samples[0].refX, 8)
  assert.equal(result.samples[0].w1, 125)
  assert.equal(result.samples[0].t, 5)
  assert.deepEqual(input, original, 'Import must not mutate the original experiment')
  assert.deepEqual(validateDataset(result).samples, result.samples, 'Normalized radian data must not be converted twice')
})

test('reference trajectories are either absent or complete at every sample', () => {
  const references = { refX: 1, refY: 2, refZ: 3 }
  assert.doesNotThrow(() => validateDataset(dataset()))
  assert.doesNotThrow(() => validateDataset(dataset([sample(0, references), sample(1, references)])))
  for (const rows of [
    [sample(0, { refX: 1 }), sample(1, { refX: 2 })],
    [sample(0, references), sample(1)],
    [sample(0), sample(1, references)],
    [sample(0, references), sample(1, { ...references, refZ: NaN })],
  ]) assert.throws(() => validateDataset(dataset(rows)))
})

test('export retains original figure diagnostics promised by the provenance metadata', () => {
  const original = JSON.parse(readFileSync(new URL('../public/data/recorded.json', import.meta.url), 'utf8'))
  const exported = JSON.parse(JSON.stringify(validateDataset(original)))
  assert.equal(exported.metadata.reconstruction, original.metadata.reconstruction)
  assert.equal(exported.samples.length, original.samples.length)
  for (let index = 0; index < original.samples.length; index++) {
    for (const field of ['ex', 'ey', 'ez', 'eRoll', 'ePitch', 'eYaw', 'savedFigureY', 'savedFigureZ']) {
      assert.equal(exported.samples[index][field], original.samples[index][field], `Lost or altered source diagnostic ${field} at row ${index}`)
    }
  }
  assert.notEqual(exported.samples[0].y, exported.samples[0].savedFigureY, 'Reconstructed coordinates must not overwrite the conflicting saved curve')
  const diagnostics = { ex: 1, ey: 2, ez: 3, eRoll: 90, ePitch: -45, eYaw: 180, savedFigureY: 1, savedFigureZ: 0 }
  const converted = validateDataset(dataset([sample(0, diagnostics), sample(1, diagnostics)], { angleUnit: 'deg' })).samples[0]
  closeTo(converted.eRoll, Math.PI / 2)
  closeTo(converted.ePitch, -Math.PI / 4)
  closeTo(converted.eYaw, Math.PI)
  assert.equal(converted.ey, 2)
  assert.equal(converted.savedFigureY, 1)
})

test('an optional actuator channel cannot disappear or become nonnumeric halfway through a recording', () => {
  for (const invalid of [undefined, NaN, '125']) {
    assert.throws(() => validateDataset(dataset([sample(0, { w1: 100 }), sample(1, { w1: invalid })])))
  }
  const result = validateDataset(dataset([sample(0, { u1: 2 }), sample(1, { u1: 4 })]))
  closeTo(sampleAt(result.samples, 0.5).u1, 3)
})

test('playback clamps to available timestamps and returns copies of endpoint samples', () => {
  const rows = [sample(10, { x: 1 }), sample(15, { x: 6 })]
  assert.equal(sampleAt([], 0), null)
  for (const time of [-100, 10]) assert.deepEqual(sampleAt(rows, time), rows[0])
  for (const time of [15, 100]) assert.deepEqual(sampleAt(rows, time), rows[1])
  const first = sampleAt(rows, 0)
  first.x = 99
  assert.equal(rows[0].x, 1)
  assert.deepEqual(sampleAt([sample(4)], 9), sample(4))
})

test('seeking chooses the correct interval in an irregularly sampled recording', () => {
  const rows = [
    sample(10, { x: 0, refX: 1, refY: 0, refZ: 1 }),
    sample(10.2, { x: 2, refX: 3, refY: 0, refZ: 1 }),
    sample(12, { x: 8, refX: 9, refY: 0, refZ: 1 }),
    sample(20, { x: 16, refX: 17, refY: 0, refZ: 1 }),
    sample(21, { x: 10, refX: 11, refY: 0, refZ: 1 }),
  ]
  for (const [time, expectedX] of [[10.1, 1], [10.2, 2], [11.1, 5], [12, 8], [16, 12], [20.5, 13]]) {
    const frame = sampleAt(rows, time)
    assert.equal(frame.t, time)
    closeTo(frame.x, expectedX)
    closeTo(frame.refX, expectedX + 1)
    closeTo(errorMagnitude(frame), 1)
  }
})

test('orientation crosses the ±180° seam by the short rotation in either direction', () => {
  for (const field of ['roll', 'pitch', 'yaw']) {
    for (const direction of [1, -1]) {
      const rows = [sample(0, { [field]: deg(179 * direction) }), sample(2, { [field]: deg(-179 * direction) })]
      const middle = sampleAt(rows, 1)[field]
      closeTo(Math.cos(middle), -1)
      closeTo(Math.sin(middle), 0)
      closeTo(Math.abs(middle - rows[0][field]), deg(1))
    }
  }
})

test('tilt is a physical joint coordinate and interpolates without wrapping', () => {
  const frame = sampleAt([sample(0, { tilt: deg(-120) }), sample(2, { tilt: deg(120) })], 1)
  closeTo(frame.tilt, 0)
})

test('tracking error uses all three spatial axes and never invents absent reference data', () => {
  closeTo(errorMagnitude(sample(0, { x: 2, y: 3, z: 4, refX: 5, refY: 7, refZ: 16 })), 13)
  for (const row of [null, sample(0), sample(0, { refX: 0, refY: 0 }), sample(0, { refX: 0, refY: 0, refZ: NaN })]) {
    assert.equal(errorMagnitude(row), null)
  }
  const stats = summarize([sample(10, { z: 2, tilt: deg(-30) }), sample(14, { z: 5, tilt: deg(20) })])
  assert.equal(stats.rmse, null)
  assert.equal(stats.maxError, null)
  assert.equal(stats.count, 2)
  assert.equal(stats.duration, 4)
  assert.equal(stats.maxAltitude, 5)
  closeTo(stats.maxTilt, 30)
})

test('RMSE weights elapsed time so a dense burst of samples cannot dominate a long flight', () => {
  const withError = (t, error) => sample(t, { x: error, refX: 0, refY: 0, refZ: 1 })
  // The squared-error trapezoid over the first second has area 2 m²s;
  // the next nine seconds have area 36 m²s. Total duration is 10 s.
  const sparse = [withError(10, 0), withError(11, 2), withError(20, 2)]
  const stats = summarize(sparse)
  closeTo(stats.rmse, Math.sqrt(3.8))
  assert.equal(stats.maxError, 2)
  const denser = [sparse[0], sparse[1], withError(12, 2), withError(13, 2), withError(15, 2), sparse[2]]
  closeTo(summarize(denser).rmse, stats.rmse, 1e-12)
  closeTo(summarize([withError(2, 3), withError(2.1, 3), withError(20, 3)]).rmse, 3)
})

test('CSV preserves normalized signal names, numerical values, and available columns', () => {
  const rows = validateDataset(dataset([
    sample(10, { x: -1.25, yaw: 180, w1: 123 }),
    sample(12.5, { x: 2.75, yaw: -90, w1: 456 }),
  ], { angleUnit: 'deg' })).samples
  const csv = toCsv(rows)
  assert.equal(csv.charCodeAt(0), 0xfeff, 'UTF-8 BOM supports spreadsheet imports')
  const lines = csv.slice(1).split('\r\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], 't,x,y,z,roll,pitch,yaw,tilt,w1')
  assert.deepEqual(lines[1].split(',').map(Number), [10, -1.25, 0, 1, 0, 0, Math.PI, 0, 123])
  assert.deepEqual(lines[2].split(',').map(Number), [12.5, 2.75, 0, 1, 0, 0, -Math.PI / 2, 0, 456])
  assert.ok(!csv.includes('refX'), 'Unavailable reference channels must not appear as zero-valued data')
})
