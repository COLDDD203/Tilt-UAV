<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElButton } from 'element-plus'
import { CheckCircle2, ChevronDown, CircleAlert, Info, SlidersHorizontal, Sparkles } from 'lucide-vue-next'
import { DEFAULT_PLAN_PARAMS, planFlight } from '../lib/planner.js'

const props = defineProps({
  activeParameters: { type: Object, default: null },
  activeSummary: { type: Object, default: null },
})
const emit = defineEmits(['generated', 'calculating'])
const form = reactive({ ...DEFAULT_PLAN_PARAMS })
const busy = ref(false), lastResult = ref(null), submitted = ref('')
const fingerprint = computed(() => JSON.stringify(form))
const dirty = computed(() => lastResult.value && fingerprint.value !== submitted.value)
const resultIsCurrent = computed(() => props.activeParameters && submitted.value && Object.keys(DEFAULT_PLAN_PARAMS).every(key => props.activeParameters[key] === JSON.parse(submitted.value)[key]))
const success = computed(() => !dirty.value && lastResult.value?.ok && resultIsCurrent.value)
const result = computed(() => success.value ? lastResult.value.summary : null)
const presets = [
  { name: '宽缝通过', width: .40, height: 2 },
  { name: '倾转穿越', width: .24, height: 2 },
  { name: '穿越后升高', width: .24, height: 3.5 },
]
const f = (v, n = 2) => Number.isFinite(v) ? v.toFixed(n) : '—'

// Selecting a saved plan restores its controls and calculated summary.
watch(() => [props.activeParameters, props.activeSummary], ([parameters, summary]) => {
  if (!parameters) {
    lastResult.value = null
    submitted.value = ''
    return
  }
  const params = Object.fromEntries(Object.keys(DEFAULT_PLAN_PARAMS).map(key => [key, parameters[key] ?? DEFAULT_PLAN_PARAMS[key]]))
  Object.assign(form, params)
  const nextFingerprint = JSON.stringify(params)
  submitted.value = nextFingerprint
  lastResult.value = summary ? { ok: true, summary } : null
}, { immediate: true })

function preset(item) { Object.assign(form, DEFAULT_PLAN_PARAMS, { gapWidth: item.width, targetHeight: item.height }) }
async function calculate() {
  if (busy.value) return
  busy.value = true
  emit('calculating')
  const params = { ...form }
  submitted.value = JSON.stringify(params)
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 20))
  try {
    const answer = planFlight(params)
    lastResult.value = answer
    if (answer.ok) emit('generated', answer)
  } catch (error) {
    lastResult.value = { ok: false, error: '计算未完成：' + error.message }
  } finally { busy.value = false }
}
</script>

<template>
  <section class="panel planner-panel" aria-label="参数化飞行设置">
    <div class="planner-heading">
      <h2><SlidersHorizontal :size="16"/>飞行参数</h2>
      <div class="planner-presets" aria-label="参数预设">
        <button v-for="item in presets" :key="item.name" type="button" :disabled="busy" @click="preset(item)">{{ item.name }}</button>
      </div>
    </div>
    <form @submit.prevent="calculate">
      <fieldset :disabled="busy" class="planner-fields">
        <div class="planner-main-inputs">
          <div class="planner-field">
            <label for="plan-gap">狭缝净宽 <small>0.12–1.20 m</small></label>
            <div class="parameter-input"><input id="plan-gap" v-model.number="form.gapWidth" type="number" inputmode="decimal" min="0.12" max="1.2" step="0.001" required aria-label="狭缝净宽" title="两墙内侧的距离"/><span>m</span></div>
          </div>
          <div class="planner-field">
            <label for="plan-height">最终悬停高度 <small>0.30–5.00 m</small></label>
            <div class="parameter-input"><input id="plan-height" v-model.number="form.targetHeight" type="number" inputmode="decimal" min="0.3" max="5" step="0.01" required aria-label="最终悬停高度" title="机体中心离地高度"/><span>m</span></div>
          </div>
          <ElButton type="primary" native-type="submit" :loading="busy" class="calculate-button"><Sparkles v-if="!busy" :size="15"/>{{ busy ? '正在计算' : '计算并演示' }}</ElButton>
        </div>
        <details class="planner-advanced">
          <summary>更多参数<ChevronDown :size="13"/></summary>
          <div class="planner-advanced-grid">
            <div class="planner-field"><label for="plan-max-tilt">最大倾转角 <small>0–75°</small></label><div class="parameter-input small-input"><input id="plan-max-tilt" v-model.number="form.maxTiltDeg" type="number" min="0" max="75" step="0.25" required aria-label="最大倾转角" title="设为 0 时仅尝试水平通过"/><span>°</span></div></div>
            <div class="planner-field"><label for="plan-clearance">每侧预留间隙 <small>0.005–0.050 m</small></label><div class="parameter-input small-input"><input id="plan-clearance" v-model.number="form.clearance" type="number" min="0.005" max="0.05" step="0.001" required aria-label="每侧预留间隙" title="从桨叶外缘算起"/><span>m</span></div></div>
            <div class="planner-field"><label for="plan-speed">峰值飞行速度 <small>0.10–1.50 m/s</small></label><div class="parameter-input small-input"><input id="plan-speed" v-model.number="form.speed" type="number" min="0.1" max="1.5" step="0.05" required aria-label="峰值飞行速度"/><span>m/s</span></div></div>
          </div>
        </details>
      </fieldset>
    </form>
    <div v-if="dirty" class="planner-pending" role="status"><Info :size="14"/><span>参数已修改，点击“计算并演示”应用。</span></div>
    <div v-else-if="lastResult && !lastResult.ok" class="planner-error" role="alert"><CircleAlert :size="17"/><div><strong>无法通过，请调整参数</strong><p>{{ lastResult.error }}</p></div></div>
    <div v-else-if="success" class="planner-result" role="status">
      <div class="planner-result-title"><CheckCircle2 :size="16"/><strong>{{ result.tiltDeg === 0 ? '可水平通过' : '可倾转通过' }}</strong></div>
      <div class="planner-result-grid">
        <div><small>最小倾角</small><strong>{{ f(result.tiltDeg, 2) }}<em>°</em></strong></div>
        <div><small>穿越高度</small><strong>{{ f(result.transitHeight) }}<em>m</em></strong></div>
        <div><small>单侧净距</small><strong>{{ f(result.actualClearance * 1000, 1) }}<em>mm</em></strong></div>
        <div><small>演示时长</small><strong>{{ f(result.duration, 1) }}<em>s</em></strong></div>
      </div>
      <p v-if="Math.abs(result.transitHeight - result.targetHeight) > .01" class="height-explanation">以 {{ f(result.transitHeight) }} m 穿越，出通道后调整至 {{ f(result.targetHeight) }} m 悬停。</p>
    </div>
    <p class="planner-explainer"><Info :size="12"/>几何与运动学演示，非 MATLAB 闭环仿真。</p>
  </section>
</template>

<style scoped>
.planner-panel{margin-bottom:18px;overflow:visible;padding:18px 22px 13px}
.planner-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
.planner-heading h2{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;color:#456455;white-space:nowrap}
.planner-heading h2 svg{color:#79a08c}
.planner-presets{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.planner-presets button{background:#f6f9f7;border:1px solid #e5ece6;border-radius:5px;color:#759382;font-size:10px;padding:5px 9px;cursor:pointer;transition:background .15s,border-color .15s}
.planner-presets button:hover{color:#20846c;background:#eaf5ee;border-color:#cddfd3}
.planner-presets button:focus-visible{outline:2px solid #62b49e;outline-offset:2px}
.planner-presets button:disabled{opacity:.55;cursor:wait}
.planner-fields{border:0;margin:0;padding:0;min-width:0}
.planner-main-inputs{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 166px;gap:22px;align-items:end}
.planner-field{min-width:0}
.planner-field>label{display:flex;align-items:baseline;justify-content:space-between;gap:7px;color:#5b7767;font-size:11px;margin-bottom:8px}
.planner-field label small{font-size:9px;color:#9aaca0;font-weight:400;white-space:nowrap}
.parameter-input{height:41px;display:flex;align-items:center;border:1px solid #dce6de;border-radius:6px;overflow:hidden;background:#fcfefd;transition:border-color .15s,box-shadow .15s}
.parameter-input:focus-within{border-color:#62b49e;box-shadow:0 0 0 3px #1b997512}
.parameter-input input{border:0;outline:0;background:none;min-width:0;width:100%;height:100%;padding:0 12px;color:#355d4d;font:20px Consolas,monospace;font-variant-numeric:tabular-nums}
.parameter-input>span{font-size:10px;color:#8fa395;padding-right:12px;white-space:nowrap}
.calculate-button{height:41px!important;width:100%;font-size:12px}
.planner-advanced{margin-top:13px}
.planner-advanced summary{display:flex;align-items:center;gap:5px;width:fit-content;padding:3px 0;color:#8ba292;font-size:10px;cursor:pointer;list-style:none}
.planner-advanced summary::-webkit-details-marker{display:none}
.planner-advanced summary>svg{transition:transform .2s}
.planner-advanced[open] summary>svg{transform:rotate(180deg)}
.planner-advanced-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;padding:16px 0 4px}
.small-input{height:35px}.small-input input{font-size:16px}
.planner-explainer{display:flex;align-items:center;gap:5px;margin:10px 0 0;color:#a0afa5;font-size:9px;line-height:1.6}
.planner-explainer svg{flex-shrink:0}
.planner-result{display:flex;align-items:center;flex-wrap:wrap;gap:13px 24px;margin-top:13px;background:#f2f8f4;border:1px solid #e2ede5;border-radius:6px;padding:12px 15px}
.planner-result-title{display:flex;gap:6px;align-items:center;color:#559978;white-space:nowrap}
.planner-result-title strong{font-size:11px;font-weight:500}
.planner-result-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;flex:1}
.planner-result-grid>div{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.planner-result-grid small{font-size:9px;color:#8aa18f}
.planner-result-grid strong{font:17px Consolas,monospace;color:#4b7962;white-space:nowrap}
.planner-result-grid em{font-size:9px;color:#8da793;font-style:normal;margin-left:3px}
.height-explanation{width:100%;margin:0;padding-top:9px;border-top:1px solid #e0ebe2;font-size:10px;color:#7d9c87;line-height:1.7}
.planner-error{display:flex;align-items:flex-start;gap:9px;background:#fff8f2;border:1px solid #f1dfcc;border-radius:6px;padding:12px 15px;margin-top:13px;color:#b77f45}
.planner-error>svg{flex-shrink:0;margin-top:1px}
.planner-error strong{font-size:11px;font-weight:500}
.planner-error p{margin:5px 0 0;font-size:11px;line-height:1.7}
.planner-pending{display:flex;align-items:center;gap:7px;margin-top:13px;border:1px solid #e5edf0;background:#f5f8fa;border-radius:6px;padding:9px 12px;font-size:10px;color:#8b9faa;line-height:1.7}
.planner-pending svg{flex-shrink:0}
@media(max-width:1200px){.planner-result-grid>div{display:block}.planner-result-grid strong{display:block;margin-top:5px}.planner-main-inputs{gap:17px}.planner-field label small{font-size:8px}}
@media(max-width:760px){.planner-panel{padding:15px 16px 12px}.planner-heading{flex-wrap:wrap;gap:12px;margin-bottom:16px}.planner-heading h2{font-size:12px}.planner-presets{gap:6px}.planner-presets button{font-size:9px;padding:4px 7px}.planner-main-inputs{grid-template-columns:1fr 1fr;gap:13px}.calculate-button{grid-column:1/-1}.planner-field>label{font-size:10px;flex-wrap:wrap;gap:4px}.planner-field label small{font-size:8px}.planner-advanced-grid{grid-template-columns:1fr;gap:13px}.planner-advanced-grid label{justify-content:flex-start;gap:12px}.planner-result{gap:12px;padding:12px}.planner-result-title{width:100%}.planner-result-grid{gap:10px}.planner-result-grid small{font-size:8px}.planner-result-grid strong{font-size:16px}.planner-result-grid em{font-size:8px}.planner-explainer{font-size:8px}.planner-error{padding:12px}}
@media(max-width:380px){.planner-result-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.planner-heading{gap:10px}.planner-presets button{font-size:8px}}
</style>

