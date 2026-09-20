<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createDroneModel, applyDronePose, PASSAGE } from '../lib/droneModel.js'
import { applyGroundContact } from '../lib/sceneGeometry.js'

const props = defineProps({
  sample: { type: Object, default: null },
  samples: { type: Array, default: () => [] },
  showTrail: { type: Boolean, default: true },
  showReference: { type: Boolean, default: true },
  showWalls: { type: Boolean, default: true },
  cameraMode: { type: String, default: 'perspective' },
  playing: { type: Boolean, default: false },
  landed: { type: Boolean, default: false },
  fitKey: { type: Number, default: 0 },
  passage: { type: Object, default: () => ({ ...PASSAGE }) },
  hoverTarget: { type: Object, default: null },
  headingOffsetRad: { type: Number, default: 0 },
})
const emit = defineEmits(['ready'])
const host = ref(null)
const detailHost = ref(null)
const failure = ref('')
const isReady = ref(false)
const hasSamples = computed(() => props.samples.length > 0)
const passage = computed(() => ({ ...PASSAGE, ...props.passage }))
const positionText = computed(() => ['x', 'y', 'z'].map(axis => {
  const value = Number(props.sample?.[axis])
  return Number.isFinite(value) ? value.toFixed(2) : '—'
}))
const tiltText = computed(() => Number.isFinite(Number(props.sample?.tilt))
  ? `${(Number(props.sample.tilt) * 180 / Math.PI).toFixed(1)}°` : '—')

let renderer, scene, camera, detailCamera, controls, resizeObserver, animationId
let rig, drone, shadow, walls, hoverMarker, pathGroup, referenceLine, elapsedLine
let floor, grid, bounds = new THREE.Box3(), trailTimes = []
let lastFrame = 0, contextLost = false
let viewportWidth = 1, viewportHeight = 1, detailRect = null
let rotorBlades = []
const worldZ = new THREE.Vector3(0, 0, 1)
// Follow the calibrated heading from behind, with world-up fixed: banking is
// unambiguously left/right even when the main camera is orbited independently.
const detailOffset = new THREE.Vector3(0, -.60, .22)
const detailHeading = new THREE.Quaternion()
const rotatedDetailOffset = new THREE.Vector3()
const detailBackground = new THREE.Color(0xfaf9f4)
const palette = { sage: 0x758765, ink: 0x30312c, grid: 0xdeded2, orange: 0xc59f39 }

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .66, metalness: .18, ...extra })
}

function addMesh(geometry, surface, parent, position = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, surface)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function label(text, color = '#73766a', scale = .35) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 96
  const context = canvas.getContext('2d')
  context.font = '600 38px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = color
  context.fillText(text, 128, 48)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  sprite.scale.set(scale * 2.667, scale, 1)
  return sprite
}

function createDrone() {
  rig = createDroneModel()
  drone = rig.drone
  rotorBlades = rig.rotorBlades
  scene.add(drone)

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(48,49,44,0.24)')
  gradient.addColorStop(1, 'rgba(48,49,44,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  shadow = new THREE.Mesh(new THREE.PlaneGeometry(.45, .45), new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false,
  }))
  shadow.position.z = .0008
  scene.add(shadow)
}

function createEnvironment() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa9ab99, 2.3))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(3, -4, 10)
  scene.add(light)
  const fill = new THREE.DirectionalLight(0xf0ebd8, 1.1)
  fill.position.set(-4, 8, 6)
  scene.add(fill)
  scene.traverse(object => { if (object.isLight) object.layers.enable(1) })

  floor = addMesh(new THREE.PlaneGeometry(80, 80), material(0xf1f0e9, { metalness: 0 }), scene, [0, 0, -.0005])
  floor.castShadow = false
  grid = new THREE.GridHelper(40, 80, 0xd4d5c8, palette.grid)
  grid.rotation.x = Math.PI / 2
  grid.material.transparent = true
  grid.material.opacity = .78
  scene.add(grid)

  const axes = new THREE.Group()
  const start = new THREE.Vector3(-.6, -.6, .03)
  const axisEntries = [
    ['X', new THREE.Vector3(1, 0, 0), 0xdf7c74, '#ba655e'],
    ['Y', new THREE.Vector3(0, 1, 0), 0x56a398, '#478b80'],
    ['Z', worldZ, 0x769abc, '#6386a6'],
  ]
  axisEntries.forEach(([name, direction, color, css]) => {
    axes.add(new THREE.ArrowHelper(direction, start, .68, color, .10, .06))
    const sprite = label(name, css, .20)
    sprite.position.copy(start).addScaledVector(direction, .86)
    axes.add(sprite)
  })
  scene.add(axes)

  rebuildWalls()
  rebuildHoverTarget()
}

function rebuildWalls() {
  if (!scene) return
  disposeObject(walls)
  const { left, right, thickness, startY, endY, height } = passage.value
  walls = new THREE.Group()
  walls.name = 'parameterized-passage'
  for (const x of [left - thickness / 2, right + thickness / 2]) {
    const shape = new THREE.BoxGeometry(thickness, endY - startY, height)
    const wall = addMesh(shape, material(0xbec5b1, { transparent: true, opacity: .13, depthWrite: false, side: THREE.DoubleSide }), walls, [x, (startY + endY) / 2, height / 2])
    wall.castShadow = false
    wall.receiveShadow = false
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shape), new THREE.LineBasicMaterial({ color: 0x909984, transparent: true, opacity: .35 }))
    wall.add(edges)
    const top = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, startY, height), new THREE.Vector3(x, endY, height),
    ]), new THREE.LineBasicMaterial({ color: 0x87917b, transparent: true, opacity: .56 }))
    walls.add(top)
  }
  const gap = label(`${(right - left).toFixed(2)} m`, '#626f55', .22)
  gap.position.set((left + right) / 2, startY - .34, height + .06)
  walls.add(gap)
  walls.visible = props.showWalls
  scene.add(walls)
}

function rebuildHoverTarget() {
  if (!scene) return
  disposeObject(hoverMarker)
  hoverMarker = null
  const target = props.hoverTarget
  if (!target || ![target.x, target.y, target.z].every(value => typeof value === 'number' && Number.isFinite(value))) return
  hoverMarker = new THREE.Group()
  hoverMarker.name = 'hover-target'
  // These cues stay on the environment layer, outside the aircraft detail camera.
  const surface = new THREE.MeshBasicMaterial({
    color: palette.sage, transparent: true, opacity: .48,
    side: THREE.DoubleSide, depthWrite: false,
  })
  const ring = new THREE.Mesh(new THREE.RingGeometry(.18, .20, 64), surface)
  ring.position.set(target.x, target.y, target.z)
  hoverMarker.add(ring)
  const groundRing = new THREE.Mesh(new THREE.RingGeometry(.18, .20, 64), surface.clone())
  groundRing.material.opacity = .20
  groundRing.position.set(target.x, target.y, .025)
  hoverMarker.add(groundRing)
  const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(target.x, target.y, .03),
    new THREE.Vector3(target.x, target.y, target.z),
  ]), new THREE.LineDashedMaterial({
    color: palette.sage, dashSize: .08, gapSize: .08, transparent: true, opacity: .34, depthWrite: false,
  }))
  guide.computeLineDistances()
  hoverMarker.add(guide)
  const heightLabel = label(`悬停 ${target.z.toFixed(2)} m`, '#637b50', .20)
  heightLabel.position.set(target.x, target.y, target.z + .30)
  hoverMarker.add(heightLabel)
  scene.add(hoverMarker)
}

function disposeObject(object) {
  if (!object) return
  const geometries = new Set(), materials = new Set(), textures = new Set()
  object.traverse(item => {
    if (item.geometry) geometries.add(item.geometry)
    const surfaces = Array.isArray(item.material) ? item.material : [item.material]
    surfaces.filter(Boolean).forEach(surface => {
      materials.add(surface)
      Object.values(surface).forEach(value => { if (value?.isTexture) textures.add(value) })
    })
  })
  geometries.forEach(value => value.dispose())
  textures.forEach(value => value.dispose())
  materials.forEach(value => value.dispose())
  object.removeFromParent()
}

function referencePoint(sample) {
  const x = sample.refX ?? sample.reference?.x ?? sample.xRef ?? sample.xr
  const y = sample.refY ?? sample.reference?.y ?? sample.yRef ?? sample.yr
  const z = sample.refZ ?? sample.reference?.z ?? sample.zRef ?? sample.zr
  return [x, y, z].every(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    ? new THREE.Vector3(Number(x), Number(y), Number(z)) : null
}

function rebuildPaths() {
  if (!scene) return
  disposeObject(pathGroup)
  disposeObject(referenceLine)
  pathGroup = new THREE.Group()
  pathGroup.visible = props.showTrail
  scene.add(pathGroup)
  const points = [], referencePoints = []
  trailTimes = []
  bounds.makeEmpty()
  const step = Math.max(1, Math.ceil(props.samples.length / 7000))
  props.samples.forEach((sample, index) => {
    if (index % step !== 0 && index !== props.samples.length - 1) return
    if (![sample.x, sample.y, sample.z].every(value => Number.isFinite(Number(value)))) return
    const point = new THREE.Vector3(Number(sample.x), Number(sample.y), Number(sample.z))
    points.push(point)
    trailTimes.push(finite(sample.t))
    bounds.expandByPoint(point)
    const reference = referencePoint(sample)
    if (reference) { referencePoints.push(reference); bounds.expandByPoint(reference) }
  })
  if (points.length > 1) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const full = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xa5b496, transparent: true, opacity: .3 }))
    pathGroup.add(full)
    elapsedLine = new THREE.Line(geometry.clone(), new THREE.LineBasicMaterial({ color: palette.sage, transparent: true, opacity: .95 }))
    pathGroup.add(elapsedLine)
    const startDot = addMesh(new THREE.SphereGeometry(.045, 16, 12), material(palette.sage), pathGroup)
    startDot.position.copy(points[0])
  } else elapsedLine = null
  if (referencePoints.length > 1) {
    referenceLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(referencePoints), new THREE.LineDashedMaterial({
      color: 0x9b91ae, dashSize: .12, gapSize: .095, transparent: true, opacity: .62,
    }))
    referenceLine.computeLineDistances()
    referenceLine.visible = props.showReference
    scene.add(referenceLine)
  } else referenceLine = null
  updateSample()
  fitCamera()
}

function updateSample() {
  if (!drone) return
  const sample = props.sample
  drone.visible = Boolean(sample)
  shadow.visible = Boolean(sample)
  if (!sample) return
  applyDronePose(rig, {
    x: finite(sample.x), y: finite(sample.y), z: finite(sample.z),
    roll: finite(sample.roll), pitch: finite(sample.pitch), yaw: finite(sample.yaw), tilt: finite(sample.tilt),
  }, props.headingOffsetRad)
  applyGroundContact(rig)
  shadow.position.x = drone.position.x
  shadow.position.y = drone.position.y
  shadow.material.opacity = Math.max(.15, .75 - Math.max(0, drone.position.z) * .1)
  shadow.scale.setScalar(1 + Math.max(0, drone.position.z) * .12)
  if (elapsedLine) {
    let low = 0, high = trailTimes.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (trailTimes[mid] <= finite(sample.t)) low = mid + 1
      else high = mid
    }
    elapsedLine.geometry.setDrawRange(0, low)
  }
}

function fitCamera() {
  if (!camera || !controls || !host.value) return
  const viewBounds = bounds.clone()
  if (props.showWalls) {
    const { left, right, thickness, startY, endY, height } = passage.value
    viewBounds.expandByPoint(new THREE.Vector3(left - thickness, startY - .34, 0))
    viewBounds.expandByPoint(new THREE.Vector3(right + thickness, endY, height + .17))
  }
  if (hoverMarker) viewBounds.expandByObject(hoverMarker)
  if (viewBounds.isEmpty()) viewBounds.set(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(3, 8, 3))
  viewBounds.expandByScalar(.42)
  const center = viewBounds.getCenter(new THREE.Vector3())
  const verticalFov = THREE.MathUtils.degToRad(camera.fov)
  const direction = props.cameraMode === 'top'
    ? new THREE.Vector3(0, -.001, 1)
    : props.cameraMode === 'rear'
      ? new THREE.Vector3(0, -1, .10)
    : props.cameraMode === 'side'
      ? new THREE.Vector3(1, -.06, .05)
      : new THREE.Vector3(1.15, -1.5, 1.12)
  direction.normalize()
  const right = new THREE.Vector3().crossVectors(worldZ, direction).normalize()
  const up = new THREE.Vector3().crossVectors(direction, right).normalize()
  const tanY = Math.tan(verticalFov / 2), tanX = tanY * camera.aspect
  // Fit the projected box corners instead of its enclosing sphere: tighter framing,
  // while preserving every trajectory extremity plus space for the complete aircraft.
  let distance = 3
  for (const x of [viewBounds.min.x, viewBounds.max.x]) {
    for (const y of [viewBounds.min.y, viewBounds.max.y]) {
      for (const z of [viewBounds.min.z, viewBounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(center)
        const depth = corner.dot(direction)
        distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanX, depth + Math.abs(corner.dot(up)) / tanY)
      }
    }
  }
  distance *= 1.08
  camera.up.set(0, 0, 1)
  camera.position.copy(center).addScaledVector(direction, distance)
  camera.near = Math.max(.01, distance / 1000)
  camera.far = Math.max(150, distance * 15)
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.minDistance = .8
  controls.maxDistance = Math.max(50, distance * 3)
  controls.update()
  grid.position.set(center.x, center.y, 0)
  floor.position.set(center.x, center.y, -.0005)
}

function resize() {
  if (!host.value || !renderer || !camera) return
  const width = host.value.clientWidth, height = host.value.clientHeight
  if (!width || !height) return
  viewportWidth = width
  viewportHeight = height
  renderer.setSize(width, height, false)
  const aspectChanged = Math.abs(camera.aspect - width / height) > .01
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  if (aspectChanged && grid && floor) fitCamera()
  if (detailHost.value && detailCamera) {
    const outer = host.value.getBoundingClientRect()
    const inner = detailHost.value.getBoundingClientRect()
    detailRect = inner.width && inner.height ? {
      x: inner.left - outer.left,
      y: height - (inner.bottom - outer.top),
      width: inner.width,
      height: inner.height,
    } : null
    if (detailRect) {
      detailCamera.aspect = detailRect.width / detailRect.height
      detailCamera.updateProjectionMatrix()
    }
  }
}

function animate(now) {
  animationId = requestAnimationFrame(animate)
  if (contextLost) return
  const dt = Math.min((now - lastFrame) / 1000 || 0, .1)
  lastFrame = now
  if (props.playing && !props.landed) rotorBlades.forEach((rotor, i) => { rotor.rotation.z += dt * 34 * (i % 2 ? 1 : -1) })
  controls.update()
  renderer.setViewport(0, 0, viewportWidth, viewportHeight)
  renderer.setScissorTest(false)
  renderer.render(scene, camera)
  if (detailRect && props.sample && !failure.value) {
    const { x, y, width, height } = detailRect
    detailHeading.setFromAxisAngle(worldZ, finite(props.sample.yaw) + props.headingOffsetRad)
    rotatedDetailOffset.copy(detailOffset).applyQuaternion(detailHeading)
    detailCamera.position.copy(drone.position).add(rotatedDetailOffset)
    detailCamera.lookAt(drone.position)
    const originalBackground = scene.background
    scene.background = detailBackground
    renderer.setScissor(x, y, width, height)
    renderer.setViewport(x, y, width, height)
    renderer.setScissorTest(true)
    renderer.render(scene, detailCamera)
    scene.background = originalBackground
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, viewportWidth, viewportHeight)
  }
}

function onContextLost(event) {
  event.preventDefault()
  contextLost = true
  failure.value = '三维显示已暂停，请刷新页面恢复。'
}

function onContextRestored() {
  contextLost = false
  failure.value = ''
}

watch(() => props.sample, updateSample)
watch(() => props.headingOffsetRad, updateSample)
watch(() => props.samples, rebuildPaths)
watch(() => props.showTrail, value => { if (pathGroup) pathGroup.visible = value })
watch(() => props.showReference, value => { if (referenceLine) referenceLine.visible = value })
watch(() => props.showWalls, value => { if (walls) walls.visible = value; fitCamera() })
watch(() => props.passage, () => { rebuildWalls(); fitCamera() }, { deep: true })
watch(() => props.hoverTarget, () => { rebuildHoverTarget(); fitCamera() }, { deep: true })
watch(() => props.cameraMode, fitCamera)
watch(() => props.fitKey, fitCamera)

onMounted(() => {
  try {
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf1f0e9)
    scene.fog = new THREE.Fog(0xf1f0e9, 30, 85)
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'default' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.25
    renderer.domElement.setAttribute('aria-label', '可倾转四旋翼三维飞行回放，拖动可旋转视角，滚轮可缩放')
    renderer.domElement.setAttribute('role', 'img')
    host.value.appendChild(renderer.domElement)
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
    camera = new THREE.PerspectiveCamera(38, 1, .01, 200)
    camera.up.set(0, 0, 1)
    detailCamera = new THREE.PerspectiveCamera(42, 1, .01, 8)
    detailCamera.up.set(0, 0, 1)
    detailCamera.layers.set(1)
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = .075
    controls.screenSpacePanning = true
    controls.maxPolarAngle = Math.PI * .495
    createEnvironment()
    createDrone()
    resize()
    rebuildPaths()
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host.value)
    resizeObserver.observe(detailHost.value)
    animationId = requestAnimationFrame(animate)
    isReady.value = true
    emit('ready')
  } catch (error) {
    console.warn('Unable to initialize 3D viewport:', error)
    failure.value = '当前浏览器无法启用三维显示，请使用支持 WebGL 的新版浏览器。曲线与数据仍可使用。'
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  resizeObserver?.disconnect()
  controls?.dispose()
  disposeObject(scene)
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    renderer.dispose()
    renderer.domElement.remove()
  }
})
</script>

<template>
  <div class="drone-viewport">
    <div ref="host" class="drone-canvas" />
    <div class="viewport-heading" aria-hidden="true">
      <span class="live-dot" :class="{ playing }" />
      <span>{{ playing ? '飞行回放中' : '三维飞行视图' }}</span>
      <span class="viewport-unit">WORLD / m</span>
    </div>
    <div v-if="!failure" class="viewport-hint">拖动旋转 <span>·</span> 滚轮缩放</div>
    <div v-show="sample && !failure" class="drone-detail" aria-label="无人机倾转姿态近景">
      <div class="drone-detail-heading"><span>侧倾 · 后视</span><span class="drone-detail-angle">β <b>{{ tiltText }}</b></span></div>
      <div ref="detailHost" class="drone-detail-canvas" />
    </div>
    <div v-if="failure" class="viewport-message" role="status">
      <span class="viewport-message-icon">◇</span>
      <strong>三维显示暂不可用</strong>
      <p>{{ failure }}</p>
    </div>
    <div v-else-if="isReady && !hasSamples" class="viewport-message" role="status">
      <span class="viewport-message-icon">◇</span>
      <strong>等待飞行数据</strong>
      <p>导入仿真结果后，即可回放飞行轨迹。</p>
    </div>
    <div class="viewport-bottom">
      <div class="viewport-coordinates">
        <span v-for="(axis, index) in ['X', 'Y', 'Z']" :key="axis"><i>{{ axis }}</i>{{ positionText[index] }}</span>
      </div>
      <span class="viewport-model-note">{{ headingOffsetRad ? '穿缝示意 · 航向已对齐通道' : '机体与旋翼为示意模型' }}</span>
    </div>
  </div>
</template>

<style scoped>
.drone-viewport { position: relative; width: 100%; height: 100%; min-height: 360px; overflow: hidden; background: #f1f0e9; isolation: isolate; }
.drone-canvas { position: absolute; inset: 0; }
.drone-canvas :deep(canvas) { display: block; width: 100%; height: 100%; outline: none; touch-action: none; }
.viewport-heading { position: absolute; top: 21px; left: 23px; display: flex; align-items: center; gap: 8px; color: #5c6154; font: 500 11px/1.4 inherit; pointer-events: none; font-size: 11px; }
.viewport-unit { margin-left: 6px; padding-left: 12px; border-left: 1px solid #d3d5c9; font-family: 'JetBrains Mono', 'Consolas', monospace; font-size: 10px; letter-spacing: .8px; color: #858879; }
.live-dot { height: 6px; width: 6px; border-radius: 50%; background: #999e8b; }
.live-dot.playing { background: #758765; box-shadow: 0 0 0 4px #75876512; }
.viewport-hint { position: absolute; top: 22px; right: 23px; color: #7f8376; font-size: 10px; pointer-events: none; }
.viewport-hint span { margin: 0 6px; }
.drone-detail { position: absolute; top: 52px; right: 20px; width: 190px; height: 140px; border: 1px solid #dadbd0; border-radius: 16px; box-shadow: 0 3px 13px #34372a08; pointer-events: none; overflow: hidden; }
.drone-detail-heading { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 11px; background: #faf9f4f2; color: #74796b; font-size: 10px; border-bottom: 1px solid #e7e7dc; }
.drone-detail-angle { font-family: 'Consolas', monospace; color: #818674; }
.drone-detail-angle b { margin-left: 3px; font-weight: 500; color: #637b50; font-variant-numeric: tabular-nums; }
.drone-detail-canvas { height: calc(100% - 28px); }
.viewport-bottom { position: absolute; left: 23px; right: 23px; bottom: 19px; display: flex; align-items: center; justify-content: space-between; gap: 10px; pointer-events: none; }
.viewport-coordinates { display: flex; gap: 17px; color: #4f5945; font-family: 'JetBrains Mono', 'Consolas', monospace; font-size: 10px; font-variant-numeric: tabular-nums; }
.viewport-coordinates span { display: flex; align-items: center; gap: 7px; }
.viewport-coordinates i { font: normal 10px 'Consolas', monospace; color: #858b7a; }
.viewport-model-note { color: #7f8376; font-size: 10px; }
.viewport-message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; color: #5c6651; background: #f1f0e9dc; padding: 35px; text-align: center; }
.viewport-message-icon { display: block; font-size: 42px; color: #a5b496; margin-bottom: 14px; }
.viewport-message strong { font-size: 15px; font-weight: 600; }
.viewport-message p { max-width: 330px; margin: 10px 0; font-size: 12px; line-height: 1.8; color: #7c8473; }
@media (max-width: 640px) {
  .drone-viewport { min-height: 320px; }
  .viewport-heading { left: 15px; top: 16px; }
  .viewport-hint { right: 15px; top: 17px; font-size: 10px; }
  .viewport-unit { display: none; }
  .drone-detail { top: 44px; right: 14px; width: 126px; height: 110px; }
  .drone-detail-heading { padding: 0 8px; font-size: 10px; height: 25px; }
  .drone-detail-canvas { height: calc(100% - 25px); }
  .viewport-bottom { left: 15px; right: 15px; bottom: 15px; }
  .viewport-coordinates { gap: 11px; }
  .viewport-model-note { font-size: 9px; }
}
</style>
