<script setup>
import { computed, reactive, ref } from 'vue'
import { Box, Check, ChevronDown, CircleAlert, Focus, RotateCcw, SlidersHorizontal } from 'lucide-vue-next'
import AirframeScene from './AirframeScene.vue'
import { DEFAULT_INSPECTION, INSPECTION_LIMITS, validateInspection } from '../lib/inspection.js'

const draft = reactive({ ...DEFAULT_INSPECTION })
const applied = ref({ ...DEFAULT_INSPECTION })
const view = ref('perspective')
const fitKey = ref(0)
const error = ref('')
const size = ref(null)
const dirty = computed(() => Object.keys(DEFAULT_INSPECTION).some(key => draft[key] !== applied.value[key]))
const angles = [
  { key: 'beta', symbol: 'β', label: '倾转角 β', short: '机架倾转', hint: '正值向右侧倾；旋翼反向补偿', tone: 'yellow' },
  { key: 'roll', symbol: 'φ', label: '滚转角 φ', short: '整机滚转', hint: '绕机头方向侧倾；正值右侧降低', tone: 'sage' },
  { key: 'pitch', symbol: 'θ', label: '俯仰角 θ', short: '整机俯仰', hint: '正值抬头，负值低头', tone: 'lavender' },
  { key: 'yaw', symbol: 'ψ', label: '偏航角 ψ', short: '水平转向', hint: '绕竖直轴旋转；正值逆时针', tone: 'white' },
]
const dimensions = [
  { key: 'spanX', label: '左右旋翼中心距' },
  { key: 'spanY', label: '前后旋翼中心距' },
  { key: 'rotorDiameter', label: '旋翼直径' },
]
const views = [{ id: 'perspective', label: '立体' }, { id: 'rear', label: '后视' }, { id: 'top', label: '俯视' }, { id: 'side', label: '侧视' }]
const formatAngle = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value)
const limits = key => INSPECTION_LIMITS[key]

function applyState() {
  const result = validateInspection(draft)
  if (!result.ok) { error.value = result.error; return }
  applied.value = { ...result.value }
  Object.assign(draft, result.value)
  error.value = ''
}
function preset(beta) {
  Object.assign(draft, applied.value, { beta, roll: 0, pitch: 0, yaw: 0 })
  applyState()
}
function reset() {
  Object.assign(draft, DEFAULT_INSPECTION)
  applyState()
  view.value = 'perspective'
  fitKey.value++
}
</script>

<template>
  <section class="airframe-inspector" aria-label="机体姿态展示">
    <article class="panel inspection-model-panel">
      <div class="inspection-model-heading">
        <div class="inspection-title"><Box :size="17"/><h2>机体细节</h2><span class="inspection-model-tag">H 型可倾转四旋翼</span></div>
        <div class="inspection-view-actions">
          <div class="segmented inspection-camera" aria-label="机体观察视角">
            <button v-for="item in views" :key="item.id" :class="{ selected: view === item.id }" :aria-pressed="view === item.id" @click="view = item.id">{{ item.label }}</button>
          </div>
          <button class="icon-button" aria-label="重置机体视角" title="重置机体视角" @click="fitKey++"><Focus :size="17"/></button>
        </div>
      </div>
      <div class="inspection-scene-container"><AirframeScene :state="applied" :view="view" :fit-key="fitKey" @measure="size = $event"/></div>
      <div class="inspection-summary" aria-label="当前显示姿态">
        <div v-for="angle in angles" :key="angle.key" :class="['inspection-angle-stat', angle.tone]">
          <div><span>{{ angle.short }}</span><i>{{ angle.symbol }}</i></div>
          <output :aria-label="`当前${angle.label}`">{{ formatAngle(applied[angle.key]) }}<small>°</small></output>
        </div>
      </div>
      <div class="inspection-scene-foot"><span class="status-dot"/><span>{{ dirty ? '正在显示上一次应用的姿态' : '当前姿态已应用' }}</span><span class="inspection-foot-unit">角度 / ° · 尺寸 / mm</span></div>
    </article>

    <div class="inspection-sidebar">
      <section class="panel inspection-controls">
        <div class="inspection-control-heading"><h2><SlidersHorizontal :size="16"/>姿态参数</h2><button class="inspection-reset" @click="reset"><RotateCcw :size="12"/>恢复默认</button></div>
        <div class="inspection-presets" aria-label="机体姿态预设">
          <button @click="preset(0)">水平姿态</button><button @click="preset(30)">右倾 30°</button><button @click="preset(60)">右倾 60°</button>
        </div>
        <form novalidate @submit.prevent="applyState" @input="error = ''">
          <div class="inspection-angle-fields">
            <div v-for="angle in angles" :key="angle.key" :class="['inspection-field', { 'inspection-beta-field': angle.key === 'beta' }]">
              <label :for="`inspection-${angle.key}`">{{ angle.label }}<small :title="angle.hint">{{ angle.short }}</small></label>
              <div class="inspection-number"><input :id="`inspection-${angle.key}`" v-model.number="draft[angle.key]" :aria-label="angle.label" :title="angle.hint" type="number" inputmode="decimal" :min="limits(angle.key)[0]" :max="limits(angle.key)[1]" step="any" required/><span>°</span></div>
            </div>
          </div>
          <details class="inspection-dimensions">
            <summary><span>机体尺寸 <small>mm</small></span><ChevronDown :size="14"/></summary>
            <div class="inspection-dimension-fields">
              <div v-for="dimension in dimensions" :key="dimension.key" class="inspection-field">
                <label :for="`inspection-${dimension.key}`">{{ dimension.label }}<small>{{ limits(dimension.key)[0] }}–{{ limits(dimension.key)[1] }} mm</small></label>
                <div class="inspection-number inspection-small-number"><input :id="`inspection-${dimension.key}`" v-model.number="draft[dimension.key]" :aria-label="dimension.label" type="number" inputmode="decimal" :min="limits(dimension.key)[0]" :max="limits(dimension.key)[1]" step="any" required/><span>mm</span></div>
              </div>
            </div>
          </details>
          <button type="submit" class="inspection-apply"><Check :size="16"/>应用姿态</button>
          <p v-if="error" class="inspection-error" role="alert"><CircleAlert :size="14"/><span>{{ error }}</span></p>
          <p v-else-if="dirty" class="inspection-pending" role="status">参数已修改，应用后更新模型。</p>
          <p v-else class="inspection-input-hint">β ±75° · 滚转 / 偏航 ±180° · 俯仰 ±90°</p>
        </form>
      </section>

      <section class="inspection-size-panel" aria-label="机体当前外廓">
        <div class="inspection-size-heading"><Box :size="15"/><h2>当前外廓</h2><span>mm</span></div>
        <div class="inspection-size-readout">
          <div v-for="[key, label] in [['width', '横向'], ['depth', '纵向'], ['height', '高度']]" :key="key"><small>{{ label }}</small><output :aria-label="`当前${label}外廓`">{{ size ? (size[key] * 1000).toFixed(1) : '—' }}</output></div>
        </div>
        <p>包含桨叶完整旋转范围</p>
      </section>
      <div class="inspection-note"><span class="inspection-note-symbol">β</span><p>β 改变机架倾角，旋翼反向补偿；滚转、俯仰和偏航改变整机姿态。</p></div>
    </div>
  </section>
</template>

<style scoped>
.airframe-inspector { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 20px; align-items: start; }
.inspection-model-panel { min-width: 0; }
.inspection-model-heading { min-height: 65px; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.inspection-title { display: flex; align-items: center; gap: 8px; color: #535e46; }
.inspection-title h2 { color: #424a38; font-size: 14px; font-weight: 600; white-space: nowrap; }
.inspection-title > svg { color: #929b84; }
.inspection-model-tag { font-size: 9px; color: #858875; background: #f2f3eb; padding: 5px 8px; border-radius: 12px; }
.inspection-view-actions { display: flex; gap: 7px; align-items: center; }
.inspection-camera button { white-space: nowrap; }
.inspection-scene-container { position: relative; height: clamp(450px, 52vh, 650px); min-height: 450px; margin: 0 10px; border-radius: 16px; overflow: hidden; }
.inspection-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 16px 20px 0; }
.inspection-angle-stat { border-radius: 16px; background: #f6f6f0; padding: 13px 15px; min-width: 0; }
.inspection-angle-stat.yellow { background: #f7e6a6; }
.inspection-angle-stat.sage { background: #e4ebd9; }
.inspection-angle-stat.lavender { background: #e8e2f0; }
.inspection-angle-stat > div { display: flex; justify-content: space-between; gap: 5px; font-size: 10px; color: #777d6d; }
.inspection-angle-stat i { font: normal 12px Georgia, serif; }
.inspection-angle-stat output { display: block; margin-top: 6px; font-size: 26px; line-height: 1.25; letter-spacing: -.8px; font-variant-numeric: tabular-nums; color: #34392d; }
.inspection-angle-stat output small { font-size: 12px; margin-left: 4px; font-weight: 400; color: #8b907f; }
.inspection-scene-foot { display: flex; align-items: center; gap: 6px; padding: 16px 21px 18px; color: #8d9580; font-size: 9px; }
.inspection-scene-foot .status-dot { width: 4px; height: 4px; }
.inspection-foot-unit { margin-left: auto; }
.inspection-sidebar { display: flex; flex-direction: column; gap: 17px; }
.inspection-controls { padding: 21px 20px 17px; background: #fffefa; border-color: #e9e7df; }
.inspection-control-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 18px; }
.inspection-control-heading h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; letter-spacing: -.3px; }
.inspection-control-heading h2 svg { color: #767c6a; }
.inspection-reset { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0; border: 0; background: none; color: #888d7d; font-size: 10px; white-space: nowrap; }
.inspection-reset:hover { color: #424a36; }
.inspection-presets { display: flex; gap: 5px; margin-bottom: 19px; }
.inspection-presets button { flex: 1; min-width: 0; padding: 7px 3px; border: 1px solid transparent; border-radius: 20px; color: #727968; background: #f0f1e9; font-size: 10px; white-space: nowrap; }
.inspection-presets button:hover { background: #e6ebdc; color: #354029; }
.inspection-angle-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 12px; }
.inspection-field { min-width: 0; }
.inspection-field label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 1.4; color: #53594b; margin-bottom: 7px; }
.inspection-field label small { color: #969b8c; font-size: 9px; }
.inspection-number { display: flex; height: 48px; align-items: center; background: #f6f5f0; border: 1px solid #e4e3db; border-radius: 13px; overflow: hidden; }
.inspection-number:focus-within { border-color: #afa888; box-shadow: 0 0 0 3px #f5dc7533; }
.inspection-beta-field .inspection-number { background: #fcf4d7; border-color: #eee1af; }
.inspection-number input { width: 100%; min-width: 0; height: 100%; padding: 0 0 0 13px; border: 0; outline: 0; background: none; color: #30352b; font-size: 24px; font-weight: 500; letter-spacing: -.8px; font-variant-numeric: tabular-nums; }
.inspection-number > span { flex-shrink: 0; font-size: 12px; color: #989d8d; padding: 0 10px 0 4px; }
.inspection-dimensions { margin-top: 21px; border-top: 1px solid #ecece3; }
.inspection-dimensions summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; list-style: none; padding: 15px 0; color: #6c7660; font-size: 11px; cursor: pointer; }
.inspection-dimensions summary::-webkit-details-marker { display: none; }
.inspection-dimensions summary small { color: #a5aa9d; font-size: 9px; margin-left: 6px; }
.inspection-dimensions[open] summary > svg { transform: rotate(180deg); }
.inspection-dimension-fields { display: grid; gap: 12px; padding-bottom: 18px; }
.inspection-dimension-fields label { flex-direction: row; justify-content: space-between; align-items: baseline; gap: 5px; }
.inspection-small-number { height: 39px; border-radius: 11px; }
.inspection-small-number input { font-size: 18px; letter-spacing: 0; }
.inspection-small-number > span { font-size: 10px; }
.inspection-apply { width: 100%; height: 41px; display: flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid #f5dc75; border-radius: 22px; background: #f5dc75; color: #353728; font-size: 12px; font-weight: 600; }
.inspection-apply:hover { background: #eed367; border-color: #eed367; }
.inspection-input-hint, .inspection-pending { margin-top: 11px; font-size: 9px; color: #959b88; line-height: 1.7; }
.inspection-pending { color: #8b799f; }
.inspection-error { display: flex; gap: 6px; align-items: flex-start; font-size: 11px; line-height: 1.65; color: #9a6544; background: #fbf0e6; border-radius: 12px; padding: 10px; margin-top: 11px; }
.inspection-error > svg { flex-shrink: 0; margin-top: 2px; }
.inspection-size-panel { border-radius: 22px; background: #303628; color: #edf2df; padding: 19px 20px 16px; }
.inspection-size-heading { display: flex; align-items: center; gap: 7px; color: #cad8b5; }
.inspection-size-heading h2 { font-size: 12px; font-weight: 500; }
.inspection-size-heading > span { margin-left: auto; font-size: 10px; color: #879b71; }
.inspection-size-readout { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 17px; }
.inspection-size-readout small { font-size: 9px; color: #93a67d; }
.inspection-size-readout output { display: block; margin-top: 5px; color: #e0edcc; font: 20px Consolas, monospace; }
.inspection-size-panel p { padding-top: 12px; margin-top: 15px; border-top: 1px solid #4a543b; color: #92a379; font-size: 9px; }
.inspection-note { display: flex; align-items: flex-start; gap: 10px; padding: 1px 5px 0; }
.inspection-note-symbol { color: #859573; border: 1px solid #cdd5c0; border-radius: 50%; height: 22px; width: 22px; flex-shrink: 0; display: grid; place-items: center; font: 14px Georgia, serif; }
.inspection-note p { color: #909780; font-size: 10px; line-height: 1.8; }
@media (max-width: 1280px) { .airframe-inspector { grid-template-columns: minmax(0, 1fr) 285px; gap: 16px; } .inspection-model-tag { display: none; } .inspection-summary { padding-left: 14px; padding-right: 14px; gap: 7px; } .inspection-angle-stat { padding: 12px 10px; } .inspection-angle-stat output { font-size: 23px; } .inspection-controls { padding: 20px 18px 16px; } }
@media (max-width: 1000px) { .airframe-inspector { grid-template-columns: minmax(0, 1fr); } .inspection-sidebar { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: start; } .inspection-controls { grid-row: span 2; } .inspection-scene-container { height: 460px; min-height: 0; } .inspection-summary { padding-left: 18px; padding-right: 18px; } }
@media (max-width: 650px) { .inspection-model-heading { padding: 14px 15px 12px; gap: 12px; } .inspection-title h2 { font-size: 13px; } .inspection-view-actions { margin-left: auto; } .inspection-camera button { font-size: 10px; padding: 5px 8px; } .inspection-scene-container { height: 360px; margin: 0 7px; border-radius: 12px; } .inspection-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 13px 0; gap: 9px; } .inspection-angle-stat { padding: 12px 14px; } .inspection-angle-stat output { font-size: 25px; } .inspection-scene-foot { padding: 15px; flex-wrap: wrap; row-gap: 6px; } .inspection-foot-unit { display: none; } .inspection-sidebar { display: flex; } .inspection-controls, .inspection-size-panel { width: 100%; } .inspection-controls { padding: 22px 20px 18px; } .inspection-size-panel { padding: 20px; } .inspection-note { margin-bottom: 8px; } }
</style>
