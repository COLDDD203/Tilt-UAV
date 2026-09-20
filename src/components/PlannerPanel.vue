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
      <span class="planner-heading-mark" aria-hidden="true">01 / PLAN</span>
    </div>
    <div class="planner-presets" aria-label="参数预设">
      <button v-for="item in presets" :key="item.name" type="button" :disabled="busy" @click="preset(item)">{{ item.name }}</button>
    </div>
    <form @submit.prevent="calculate">
      <fieldset :disabled="busy" class="planner-fields">
        <div class="planner-main-inputs">
          <div class="planner-field">
            <label for="plan-gap">狭缝净宽 <small>0.12–1.20 m</small></label>
            <div class="parameter-input"><input id="plan-gap" v-model.number="form.gapWidth" type="number" inputmode="decimal" min="0.12" max="1.2" step="0.001" required aria-label="狭缝净宽" title="两墙内侧的距离"/><span>m</span></div>
          </div>
          <div class="planner-field">
            <label for="plan-height">目标悬停高度 <small>0.30–5.00 m</small></label>
            <div class="parameter-input"><input id="plan-height" v-model.number="form.targetHeight" type="number" inputmode="decimal" min="0.3" max="5" step="0.01" required aria-label="目标悬停高度" title="机体中心离地高度；悬停 3 秒后自动降落"/><span>m</span></div>
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
    <p class="planner-explainer"><Info :size="12"/><span>悬停 3 秒后自动降落<br/>运动学演示 · 非闭环仿真</span></p>
  </section>
</template>

<style scoped>
.planner-panel{margin:0;overflow:visible;padding:18px 20px;border:1px solid #e9e7df;border-radius:24px;background:#fffefa;box-shadow:none}
.planner-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}
.planner-heading h2{display:flex;align-items:center;gap:9px;margin:0;font-size:15px;font-weight:600;letter-spacing:-.3px;color:#292a27;white-space:nowrap}
.planner-heading h2 svg{color:#67685e}
.planner-heading-mark{font-size:9px;font-weight:500;letter-spacing:1px;color:#88897e;white-space:nowrap}
.planner-presets{display:flex;align-items:center;gap:5px;margin-bottom:14px}
.planner-presets button{flex:1;min-width:0;background:#f2f1eb;border:1px solid transparent;border-radius:100px;color:#606258;font:inherit;font-size:10px;line-height:1.4;padding:6px 4px;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.planner-presets button:hover{color:#292a27;background:#e8e3d0;border-color:#ded7bd}
.planner-presets button:focus-visible{outline:2px solid #292a27;outline-offset:2px}
.planner-presets button:disabled{opacity:.55;cursor:wait}
.planner-fields{border:0;margin:0;padding:0;min-width:0}
.planner-main-inputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:end}
.planner-field{min-width:0}
.planner-field>label{display:flex;flex-direction:column;gap:2px;color:#53564e;font-size:11px;line-height:1.4;margin-bottom:6px}
.planner-field label small{font-size:9px;color:#85877d;font-weight:400;white-space:nowrap}
.parameter-input{height:46px;display:flex;align-items:center;border:1px solid #e4e3db;border-radius:13px;overflow:hidden;background:#f7f6f1;transition:border-color .15s,box-shadow .15s}
.parameter-input:focus-within{border-color:#a9a58e;box-shadow:0 0 0 3px #f5dc7545}
.parameter-input input{border:0;outline:0;background:none;min-width:0;width:100%;height:100%;padding:0 0 0 12px;color:#292a27;font:500 24px 'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-1px}
.parameter-input>span{font-size:10px;color:#85877d;padding:0 10px 0 4px;white-space:nowrap}
.calculate-button{grid-column:1/-1;height:40px!important;width:100%;border:1px solid #f5dc75!important;border-radius:100px!important;background:#f5dc75!important;color:#292a27!important;font-size:12px;font-weight:600;letter-spacing:.2px;box-shadow:none!important;transition:background .15s,transform .15s}
.calculate-button:hover{background:#efcf5d!important;border-color:#efcf5d!important;transform:translateY(-1px)}
.calculate-button:focus-visible{outline:2px solid #292a27;outline-offset:3px}
.calculate-button :deep(span){display:flex;align-items:center;justify-content:center;gap:8px}
.planner-advanced{margin-top:7px}
.planner-advanced summary{display:flex;align-items:center;justify-content:space-between;padding:5px 1px;color:#73766b;font-size:10px;cursor:pointer;list-style:none}
.planner-advanced summary::-webkit-details-marker{display:none}
.planner-advanced summary:focus-visible{outline:2px solid #a9a58e;outline-offset:4px;border-radius:3px}
.planner-advanced summary>svg{transition:transform .2s}
.planner-advanced[open] summary>svg{transform:rotate(180deg)}
.planner-advanced-grid{display:grid;grid-template-columns:1fr;gap:12px;padding:13px 0 5px}
.planner-advanced-grid .planner-field>label{flex-direction:row;align-items:baseline;justify-content:space-between;gap:8px}
.small-input{height:39px;border-radius:11px}.small-input input{font-size:18px;letter-spacing:0}
.planner-explainer{display:flex;align-items:flex-start;gap:7px;margin:8px 0 0;padding-top:8px;border-top:1px solid #eeede6;color:#85877c;font-size:9px;line-height:1.55}
.planner-explainer svg{flex-shrink:0;margin-top:2px}
.planner-result{margin-top:11px;background:#e9efdf;border:0;border-radius:16px;padding:12px 14px}
.planner-result-title{display:flex;gap:7px;align-items:center;color:#536044;white-space:nowrap}
.planner-result-title strong{font-size:11px;font-weight:600}
.planner-result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 12px;margin-top:10px}
.planner-result-grid>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.planner-result-grid small{font-size:9px;color:#717e64}
.planner-result-grid strong{font:500 20px 'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-.7px;color:#3d4932;white-space:nowrap}
.planner-result-grid em{font-size:9px;font-weight:400;color:#717e64;font-style:normal;letter-spacing:0;margin-left:4px}
.height-explanation{margin:10px 0 0;padding-top:8px;border-top:1px solid #d8e1cc;font-size:10px;color:#6c795e;line-height:1.7}
.planner-error{display:flex;align-items:flex-start;gap:8px;background:#fff1e5;border:1px solid #f1dbca;border-radius:14px;padding:14px;margin-top:15px;color:#936038}
.planner-error>svg{flex-shrink:0;margin-top:1px}
.planner-error strong{font-size:11px;font-weight:600}
.planner-error p{margin:6px 0 0;font-size:10px;line-height:1.8}
.planner-pending{display:flex;align-items:flex-start;gap:7px;margin-top:15px;border:1px solid #e5dfed;background:#f0edf6;border-radius:13px;padding:11px 12px;font-size:10px;color:#796c8d;line-height:1.7}
.planner-pending svg{flex-shrink:0;margin-top:2px}
@media(max-width:760px){.planner-panel{padding:19px 21px}.planner-main-inputs{gap:12px}.planner-presets button{font-size:11px}.planner-field>label{font-size:12px}.planner-field label small{font-size:10px}.parameter-input{height:48px}.parameter-input input{font-size:25px}.planner-explainer{font-size:10px}.planner-advanced summary{font-size:11px}}
@media(prefers-reduced-motion:reduce){.planner-presets button,.parameter-input,.calculate-button,.planner-advanced summary>svg{transition:none}.calculate-button:hover{transform:none}}
</style>
