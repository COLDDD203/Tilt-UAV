<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { sweptAircraftBounds } from '../lib/droneModel.js'
import { createInspectionModel } from '../lib/inspectionModel.js'
import { applyInspectionPose, inspectionDimensions } from '../lib/inspection.js'

const props = defineProps({
  state: { type: Object, required: true },
  view: { type: String, default: 'perspective' },
  fitKey: { type: Number, default: 0 },
})
const emit = defineEmits(['ready', 'measure'])
const host = ref(null)
const failure = ref('')
const viewLabel = computed(() => ({ perspective: '自由视角', rear: '后视 · 左右侧倾', top: '俯视 · 机头朝向', side: '侧视 · 前后俯仰' })[props.view] || '自由视角')

let scene, camera, renderer, controls, rig, resizeObserver, animationId
let dimensionsKey = '', fitRadius = .25, contextLost = false, active = true
const worldUp = new THREE.Vector3(0, 0, 1)
const origin = new THREE.Vector3()

function disposeObject(object) {
  if (!object) return
  const geometries = new Set(), materials = new Set(), textures = new Set()
  object.traverse(part => {
    if (part.geometry) geometries.add(part.geometry)
    const surfaces = Array.isArray(part.material) ? part.material : [part.material]
    surfaces.filter(Boolean).forEach(surface => {
      materials.add(surface)
      Object.values(surface).forEach(value => { if (value?.isTexture) textures.add(value) })
    })
  })
  geometries.forEach(geometry => geometry.dispose())
  textures.forEach(texture => texture.dispose())
  materials.forEach(surface => surface.dispose())
  object.removeFromParent()
}

function measureRadius() {
  // A fixed, origin-centred envelope preserves the framing while angles change.
  // It includes full swept propeller disks and every allowed beta configuration,
  // so an arbitrary body attitude cannot rotate the aircraft out of the frame.
  const bounds = new THREE.Box3(), corner = new THREE.Vector3()
  fitRadius = 0
  const betas = new Set([-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90, props.state.beta])
  for (const beta of betas) {
    applyInspectionPose(rig, { ...props.state, beta, roll: 0, pitch: 0, yaw: 0 })
    sweptAircraftBounds(rig, bounds)
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          fitRadius = Math.max(fitRadius, corner.set(x, y, z).length())
        }
      }
    }
  }
  fitRadius = Math.max(.05, fitRadius)
  applyInspectionPose(rig, props.state)
}

function updateAircraft() {
  if (!scene) return
  const dimensions = inspectionDimensions(props.state)
  const nextKey = JSON.stringify(dimensions)
  if (!rig || dimensionsKey !== nextKey) {
    disposeObject(rig?.drone)
    rig = createInspectionModel(dimensions)
    dimensionsKey = nextKey
    scene.add(rig.drone)
    measureRadius()
    fitCamera()
  } else {
    applyInspectionPose(rig, props.state)
  }
  const size = sweptAircraftBounds(rig).getSize(new THREE.Vector3())
  emit('measure', { width: size.x, depth: size.y, height: size.z })
}

function cameraDirection() {
  if (props.view === 'rear') return new THREE.Vector3(0, -1, .015)
  if (props.view === 'top') return new THREE.Vector3(0, -.001, 1)
  if (props.view === 'side') return new THREE.Vector3(1, -.001, .015)
  return new THREE.Vector3(1.15, -1.6, 1.05).normalize()
}

function fitCamera(preserveDirection = false) {
  if (!camera || !controls || !rig) return
  const direction = preserveDirection
    ? camera.position.clone().sub(controls.target).normalize()
    : cameraDirection()
  const halfY = THREE.MathUtils.degToRad(camera.fov) / 2
  const halfX = Math.atan(Math.tan(halfY) * camera.aspect)
  const distance = fitRadius / Math.sin(Math.min(halfX, halfY)) / .86
  camera.up.copy(worldUp)
  camera.position.copy(direction.multiplyScalar(distance))
  camera.near = Math.max(.001, fitRadius / 100)
  camera.far = Math.max(20, distance * 20)
  camera.updateProjectionMatrix()
  controls.target.copy(origin)
  controls.minDistance = fitRadius * 1.5
  controls.maxDistance = distance * 5
  controls.update()
}

function resize() {
  if (!renderer || !camera || !host.value) return
  const width = host.value.clientWidth, height = host.value.clientHeight
  if (!width || !height) return
  const nextAspect = width / height
  const aspectChanged = Math.abs(nextAspect - camera.aspect) > .01
  renderer.setSize(width, height, false)
  camera.aspect = nextAspect
  camera.updateProjectionMatrix()
  if (aspectChanged) fitCamera(true)
}

function animate() {
  animationId = requestAnimationFrame(animate)
  if (contextLost || !renderer) return
  controls.update()
  renderer.render(scene, camera)
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

function initialize() {
  if (renderer || !host.value) return
  try {
    failure.value = ''
    contextLost = false
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf1f0e9)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xa5aa97, 2.3))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3)
    keyLight.position.set(2, -3, 5)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xf8edd6, 1.4)
    fillLight.position.set(-3, 2, 2)
    scene.add(fillLight)
    const rimLight = new THREE.DirectionalLight(0xdce3ef, 1.1)
    rimLight.position.set(0, 4, -.8)
    scene.add(rimLight)

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'default' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', '无人机机体姿态三维近景，拖动旋转视角，滚轮缩放')
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
    host.value.appendChild(renderer.domElement)

    camera = new THREE.PerspectiveCamera(36, 1, .001, 20)
    camera.up.copy(worldUp)
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = .08
    controls.enablePan = false
    controls.rotateSpeed = .75
    controls.zoomSpeed = .8
    // Inspection permits underside views as well as a full orbit around the frame.
    controls.minPolarAngle = .005
    controls.maxPolarAngle = Math.PI - .005
    resize()
    updateAircraft()
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host.value)
    animationId = requestAnimationFrame(animate)
    emit('ready')
  } catch (error) {
    console.warn('Unable to initialize aircraft inspection:', error)
    release()
    failure.value = '当前浏览器无法启用三维显示，请使用支持 WebGL 的新版浏览器。'
  }
}

function release() {
  cancelAnimationFrame(animationId)
  resizeObserver?.disconnect()
  controls?.dispose()
  disposeObject(scene)
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }
  renderer = scene = camera = controls = rig = resizeObserver = null
  dimensionsKey = ''
}

watch(() => props.state, updateAircraft, { deep: true })
watch(() => props.view, () => fitCamera())
watch(() => props.fitKey, () => fitCamera())
onMounted(initialize)
onActivated(async () => {
  active = true
  await nextTick()
  if (!active) return
  initialize()
  resize()
})
onDeactivated(() => { active = false; release() })
onBeforeUnmount(() => { active = false; release() })
</script>

<template>
  <div class="airframe-viewport">
    <div ref="host" class="airframe-canvas" />
    <div class="airframe-scene-heading" aria-hidden="true"><span class="scene-dot" /><span>机体近景</span><span class="scene-tag">AIRFRAME</span></div>
    <div v-if="!failure" class="airframe-scene-hint">拖动旋转<span>·</span>滚轮缩放</div>
    <div v-if="failure" class="airframe-scene-message" role="status">
      <span aria-hidden="true">◇</span>
      <strong>三维显示暂不可用</strong>
      <p>{{ failure }}</p>
    </div>
    <div v-else class="airframe-scene-footer"><span>{{ viewLabel }}</span><span class="nose-label"><i />机头 +Y</span></div>
  </div>
</template>

<style scoped>
.airframe-viewport { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #f1f0e9; border-radius: 20px; isolation: isolate; }
.airframe-canvas { position: absolute; inset: 0; }
.airframe-canvas :deep(canvas) { display: block; width: 100%; height: 100%; outline: none; touch-action: none; }
.airframe-scene-heading { position: absolute; top: 23px; left: 24px; display: flex; align-items: center; gap: 8px; color: #616758; font-size: 11px; pointer-events: none; }
.scene-dot { width: 6px; height: 6px; background: #97a486; border-radius: 50%; }
.scene-tag { margin-left: 6px; padding-left: 12px; border-left: 1px solid #d5d6ca; color: #8b8f80; font: 10px 'Consolas', monospace; letter-spacing: 1.1px; }
.airframe-scene-hint { position: absolute; top: 23px; right: 24px; color: #7f8376; font-size: 10px; pointer-events: none; }
.airframe-scene-hint span { margin: 0 8px; }
.airframe-scene-footer { position: absolute; left: 24px; right: 24px; bottom: 21px; display: flex; align-items: center; justify-content: space-between; color: #787f6c; font-size: 10px; pointer-events: none; }
.nose-label { display: inline-flex; align-items: center; gap: 7px; }
.nose-label i { display: block; width: 6px; height: 6px; background: #27a99a; border-radius: 2px; transform: rotate(45deg); }
.airframe-scene-message { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 28px; background: #f1f0e9ec; color: #59634d; text-align: center; }
.airframe-scene-message > span { margin-bottom: 12px; color: #a5b496; font-size: 42px; }
.airframe-scene-message strong { font-size: 15px; font-weight: 600; }
.airframe-scene-message p { max-width: 320px; margin: 12px 0; color: #7c8473; font-size: 12px; line-height: 1.8; }
@media (max-width: 640px) {
  .airframe-viewport { border-radius: 16px; }
  .airframe-scene-heading { left: 16px; top: 18px; }
  .scene-tag { display: none; }
  .airframe-scene-hint { right: 16px; top: 18px; }
  .airframe-scene-hint span { margin: 0 5px; }
  .airframe-scene-footer { left: 16px; right: 16px; bottom: 17px; }
}
</style>
