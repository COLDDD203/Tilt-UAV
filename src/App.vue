<script setup>
import { computed, markRaw, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElButton, ElDialog, ElMessage, ElOption, ElSelect, ElSlider, ElSwitch } from 'element-plus'
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Box, ChartNoAxesCombined, Check, ChevronRight, CircleHelp, Clock3, Database, Expand, FileJson, Focus, FolderOpen, GraduationCap, Info, LayoutDashboard, MoveUpRight, Pause, Play, RotateCcw, Rotate3d, Settings2, SlidersHorizontal, Upload, Wind } from 'lucide-vue-next'
import DroneScene from './components/DroneScene.vue'
import FlightChart from './components/FlightChart.vue'
import PlannerPanel from './components/PlannerPanel.vue'
import { PASSAGE } from './lib/droneModel.js'
import recorded from '../public/data/recorded.json'
import { downloadText, errorMagnitude, sampleAt, summarize, toCsv, validateDataset } from './lib/data.js'

const baseData = markRaw(validateDataset(recorded))
const datasets = ref([{ id: 'recorded', data: baseData }])
const activeId = ref('recorded')
const activeData = computed(() => datasets.value.find(d => d.id === activeId.value).data)
const samples = computed(() => activeData.value.samples)
const metadata = computed(() => activeData.value.metadata)
const currentTime = ref(0)
const startTime = computed(() => samples.value[0].t)
const endTime = computed(() => samples.value.at(-1).t)
const sample = computed(() => sampleAt(samples.value, currentTime.value))
const stats = computed(() => summarize(samples.value))
const error = computed(() => errorMagnitude(sample.value))
const hasReferences = computed(() => ['refX', 'refY', 'refZ'].every(key => Number.isFinite(samples.value[0][key])))
const isPlanned = computed(() => metadata.value.kind === 'synthetic' && metadata.value.modelType === 'geometry-planner')
const planSummary = computed(() => isPlanned.value ? metadata.value.planner?.summary : null)
const scenePassage = computed(() => metadata.value.scene?.passage || PASSAGE)
const headingOffsetRad = computed(() => metadata.value.scene?.headingOffsetRad ?? 0)
const hoverTarget = computed(() => metadata.value.scene?.hoverTarget || (isPlanned.value ? { x: samples.value.at(-1).x, y: samples.value.at(-1).y, z: samples.value.at(-1).z } : null))
const page = ref('workspace')
const playing = ref(false)
const speed = ref(1)
const loop = ref(false)
const showTrail = ref(true), showReference = ref(true), showWalls = ref(true)
const cameraMode = ref('perspective'), fitKey = ref(0)
const chartMode = ref('position')
const infoOpen = ref(false)
const fileInput = ref(null)
const presenting = ref(false)
const importBusy = ref(false)
const navigation = [
  { id: 'workspace', label: '实验工作台', icon: LayoutDashboard },
  { id: 'analysis', label: '数据分析', icon: ChartNoAxesCombined },
  { id: 'records', label: '实验记录', icon: FolderOpen },
]
const chartTabs = [{ id: 'position', label: '位置跟踪' }, { id: 'attitude', label: '姿态与倾转' }, { id: 'error', label: '跟踪误差' }, { id: 'rotors', label: '旋翼转速' }]
const originalStages = [
  { name: '起飞悬停', from: 0, to: 10, icon: MoveUpRight },
  { name: '倾转变形', from: 10, to: 15, icon: Rotate3d },
  { name: '穿越间隙', from: 15, to: 25, icon: ArrowRight },
  { name: '姿态恢复', from: 25, to: 30, icon: RotateCcw },
  { name: '下降着陆', from: 30, to: 40, icon: ArrowDownToLine },
]
const isOriginal = computed(() => activeId.value === 'recorded')
const stages = computed(() => isOriginal.value ? originalStages : metadata.value.stages || [])
const stageIndex = computed(() => stages.value.length ? Math.max(0, stages.value.findLastIndex(s => currentTime.value >= s.from)) : -1)
const stageName = computed(() => stages.value[stageIndex.value]?.name || '自定义实验')
const hasLanded = computed(() => isPlanned.value && stageName.value === '着陆完成')
const tablePage = ref(1)
const tableRows = computed(() => samples.value.filter((_, i) => i % Math.max(1, Math.round(samples.value.length / 81)) === 0))
const pageCount = computed(() => Math.ceil(tableRows.value.length / 10))
const visibleRows = computed(() => tableRows.value.slice((tablePage.value - 1) * 10, tablePage.value * 10))
const limitations = computed(() => {
  const values = metadata.value.limitations
  return Array.isArray(values) ? values : values ? [String(values)] : []
})
let animationId, lastTick = 0
const f = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—'
const deg = value => value * 180 / Math.PI

function tick(now) {
  animationId = requestAnimationFrame(tick)
  const dt = lastTick ? Math.min((now - lastTick) / 1000, .1) : 0
  lastTick = now
  if (playing.value) {
    const next = currentTime.value + dt * speed.value
    if (next >= endTime.value) {
      currentTime.value = loop.value ? startTime.value : endTime.value
      if (!loop.value) playing.value = false
    } else currentTime.value = next
  }
}
function togglePlay() {
  if (currentTime.value >= endTime.value) currentTime.value = startTime.value
  playing.value = !playing.value
}
function seek(value) {
  playing.value = false
  currentTime.value = Math.max(startTime.value, Math.min(endTime.value, Number(value)))
}
function reset() { seek(startTime.value) }
function selectDataset(id) {
  activeId.value = id
  playing.value = false
  currentTime.value = startTime.value
  tablePage.value = 1
  showWalls.value = id === 'recorded' || Boolean(metadata.value.scene?.passage)
  fitKey.value++
}
function applyGeneratedPlan(answer) {
  const data = markRaw(validateDataset(answer.dataset))
  const id = `plan-${Date.now()}`
  datasets.value.push({ id, data })
  selectDataset(id)
  showWalls.value = true
  chartMode.value = 'attitude'
  speed.value = 1
  loop.value = false
  playing.value = true
  ElMessage.closeAll()
  ElMessage.success('方案已生成')
}
async function importFile(event) {
  const file = event.target.files?.[0]
  if (!file) return
  importBusy.value = true
  try {
    if (file.size > 35 * 1024 * 1024) throw new Error('文件超过 35 MB，请先减少采样点。')
    const data = markRaw(validateDataset(JSON.parse(await file.text())))
    const id = `import-${Date.now()}`
    datasets.value.push({ id, data })
    selectDataset(id)
    page.value = 'workspace'
    ElMessage.success(`已导入 ${data.samples.length.toLocaleString()} 个采样点`)
  } catch (error) {
    ElMessage.error(error instanceof SyntaxError ? '无法解析 JSON，请选择导出函数生成的 JSON 文件。' : error.message)
  } finally { importBusy.value = false; event.target.value = '' }
}
function exportJson() { downloadText(JSON.stringify(activeData.value, null, 2), 'tiltlab-flight.json') }
function exportCsv() { downloadText(toCsv(samples.value), 'tiltlab-flight.csv', 'text/csv;charset=utf-8') }
function keydown(event) {
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName) || event.target.isContentEditable || event.target.closest('[role="slider"], [role="combobox"], .el-dialog') || infoOpen.value) return
  if (event.code === 'Space') { event.preventDefault(); togglePlay() }
  if (event.code === 'ArrowRight') { event.preventDefault(); seek(currentTime.value + 1) }
  if (event.code === 'ArrowLeft') { event.preventDefault(); seek(currentTime.value - 1) }
  if (event.code === 'Escape') presenting.value = false
}
function useRecord(id) { selectDataset(id); page.value = 'workspace' }
function setPage(value) { page.value = value; if (value === 'guide' || value === 'records') playing.value = false }
onMounted(() => { currentTime.value = startTime.value; animationId = requestAnimationFrame(tick); window.addEventListener('keydown', keydown) })
onBeforeUnmount(() => { cancelAnimationFrame(animationId); window.removeEventListener('keydown', keydown) })
</script>

<template>
  <div class="app-shell" :class="{ presenting }">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="setPage('workspace')" aria-label="TiltLab 实验工作台">
        <span class="brand-icon"><svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m12 12 16 16m0-16L12 28" stroke="currentColor" stroke-width="2"/><circle v-for="p in [[11,11],[29,11],[11,29],[29,29]]" :key="p.join()" :cx="p[0]" :cy="p[1]" r="6" stroke="currentColor" stroke-width="1.7"/><rect x="17" y="15" width="6" height="10" rx="2" fill="currentColor"/></svg></span>
        <span class="brand-word">Tilt<span>Lab</span><small>倾转飞行实验室</small></span>
      </a>
      <div class="nav-caption">工作空间 <span>WORKSPACE</span></div>
      <nav aria-label="主导航">
        <button v-for="item in navigation" :key="item.id" :aria-label="item.label" :title="item.label" :class="['nav-item', { active: page === item.id }]" @click="setPage(item.id)">
          <component :is="item.icon" :size="18" :stroke-width="1.7"/><span>{{ item.label }}</span><ChevronRight v-if="page === item.id" :size="14" class="nav-arrow"/>
        </button>
      </nav>
      <div class="sidebar-bottom"><div class="sidebar-lab-mark" aria-hidden="true"><svg viewBox="0 0 160 110" fill="none"><ellipse cx="80" cy="55" rx="65" ry="24" transform="rotate(-30 80 55)"/><ellipse cx="80" cy="55" rx="65" ry="24" transform="rotate(30 80 55)"/><circle cx="80" cy="55" r="9"/><circle cx="128" cy="28" r="4"/></svg><span>EXPLORE EVERY ANGLE</span></div><div class="local-status"><span class="status-dot"/><div><strong>浏览器本地计算</strong></div></div><button class="nav-item guide-nav" aria-label="使用指南" title="使用指南" :class="{ active: page === 'guide' }" @click="setPage('guide')"><CircleHelp :size="18"/><span>使用指南</span><ArrowUpRight :size="14" class="nav-arrow"/></button><div class="sidebar-version">TiltLab <span>FLIGHT STUDIO</span></div></div>
    </aside>

    <div class="main-shell">
      <header class="topbar"><div class="breadcrumb"><span>无人机控制实验</span><ChevronRight :size="13"/><strong>{{ navigation.find(n => n.id === page)?.label || '使用指南' }}</strong></div><div class="topbar-right"><span class="offline-pill"><span class="status-dot"/>{{ isPlanned ? '参数化规划' : '离线回放' }}</span></div></header>
      <main :class="{ 'workspace-page': page === 'workspace' }">
        <div class="page-heading">
          <div><span class="page-kicker">TILTLAB <span>/</span> {{ page === 'workspace' ? 'FLIGHT WORKSPACE' : page === 'analysis' ? 'FLIGHT ANALYTICS' : page === 'records' ? 'FLIGHT RECORDS' : 'GETTING STARTED' }}</span><h1>{{ page === 'workspace' ? '让每一度倾转，清晰可见。' : page === 'analysis' ? '数据分析' : page === 'records' ? '实验记录' : '使用指南' }}</h1><p v-if="page === 'workspace'">可倾转四旋翼 · 参数规划与飞行回放</p></div>
          <div class="heading-actions"><ElButton v-if="page !== 'guide'" @click="infoOpen = true"><Info :size="15"/>数据说明</ElButton><ElButton type="primary" :loading="importBusy" @click="fileInput?.click()"><Upload :size="15"/>导入数据</ElButton></div>
        </div>
        <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" aria-label="导入仿真 JSON 数据" @change="importFile" />

        <section v-if="page === 'workspace'" class="record-toolbar" aria-label="当前演示记录">
          <label for="dataset-select"><Database :size="15"/>当前记录</label>
          <ElSelect id="dataset-select" :model-value="activeId" @update:model-value="selectDataset" aria-label="选择实验数据"><ElOption v-for="d in datasets" :key="d.id" :label="d.id === 'recorded' ? '倾转穿越 · 配套实验' : d.data.metadata.title" :value="d.id"/></ElSelect>
          <span class="record-kind">{{ isPlanned ? '运动学规划' : isOriginal ? '实验回放' : '导入记录' }}</span>
          <span v-if="showWalls" class="current-gap">当前狭缝 <b>{{ f(scenePassage.right - scenePassage.left, 3) }} m</b></span>
        </section>
        <PlannerPanel v-show="page === 'workspace'" :active-parameters="isPlanned ? metadata.planner?.parameters : null" :active-summary="planSummary" @calculating="playing = false" @generated="applyGeneratedPlan" />
        <template v-if="page === 'workspace' || page === 'analysis'">
          <section class="metric-grid" aria-label="飞行数据概览">
            <article class="metric-card"><div class="metric-label"><span>{{ page === 'analysis' ? '最高飞行高度' : '当前高度' }}</span><MoveUpRight :size="16"/></div><div class="metric-value">{{ f(page === 'analysis' ? stats.maxAltitude : sample.z) }}<small>m</small></div></article>
            <article class="metric-card"><div class="metric-label"><span>{{ page === 'analysis' ? '最大倾转角' : '当前倾转角' }}</span><Rotate3d :size="16"/></div><div class="metric-value">{{ f(page === 'analysis' ? stats.maxTilt : deg(sample.tilt), 1) }}<small>°</small></div></article>
            <article class="metric-card"><div class="metric-label"><span :title="isPlanned ? '完整机体与旋翼扫掠包络的最小单侧净距' : '三轴位置误差'">{{ isPlanned ? '规划最小单侧净距' : page === 'analysis' ? '全程位置 RMSE' : '位置误差' }}</span><Activity :size="16"/></div><div class="metric-value">{{ f(isPlanned ? planSummary?.actualClearance : page === 'analysis' ? stats.rmse : error, 3) }}<small>m</small></div></article>
            <article class="metric-card"><div class="metric-label"><span>{{ page === 'analysis' ? '采样点数' : '飞行时间' }}</span><Clock3 :size="16"/></div><div class="metric-value">{{ page === 'analysis' ? stats.count.toLocaleString() : f(currentTime, 1) }}<small>{{ page === 'analysis' ? '点' : `/ ${f(endTime, 1)} s` }}</small></div></article>
          </section>

          <template v-if="page === 'workspace'">
            <div class="workspace-grid">
              <section class="panel flight-panel"><div class="panel-heading"><div class="panel-title"><Box :size="17"/><h2>三维飞行视图</h2><span class="subtle-tag">{{ stageName }}</span></div><div class="scene-actions"><div class="segmented camera-switch" aria-label="相机视角"><button v-for="c in [{ id: 'perspective', label: '透视' }, { id: 'rear', label: '沿通道' }, { id: 'top', label: '俯视' }, { id: 'side', label: '侧视' }]" :key="c.id" :class="{ selected: cameraMode === c.id }" @click="cameraMode = c.id">{{ c.label }}</button></div><button class="icon-button" title="重置视角" aria-label="重置视角" @click="fitKey++"><Focus :size="17"/></button><button class="icon-button" :title="presenting ? '退出专注模式' : '专注模式'" aria-label="切换专注模式" @click="presenting = !presenting"><Expand :size="16"/></button></div></div>
                <div class="scene-container"><DroneScene :sample="sample" :samples="samples" :show-trail="showTrail" :show-reference="showReference" :show-walls="showWalls" :camera-mode="cameraMode" :playing="playing" :landed="hasLanded" :fit-key="fitKey" :passage="scenePassage" :hover-target="hoverTarget" :heading-offset-rad="headingOffsetRad"/><div class="scene-legend"><span><i class="legend-line"/>{{ isPlanned ? '规划航迹' : '飞行轨迹' }}</span><span v-if="hasReferences"><i class="legend-line dashed"/>参考轨迹</span></div></div>
                <div class="playback-bar"><div class="playback-top"><div class="playback-left"><button class="play-button" :aria-label="playing ? '暂停回放' : '开始回放'" @click="togglePlay"><Pause v-if="playing" :size="18" fill="currentColor"/><Play v-else :size="18" fill="currentColor"/></button><button class="icon-button" title="返回起点" aria-label="返回起点" @click="reset"><RotateCcw :size="17"/></button><div class="time-display">{{ f(currentTime, 2) }}<span>/ {{ f(endTime, 2) }} s</span></div><span class="playback-state">{{ hasLanded ? '已着陆' : playing ? '正在回放' : currentTime >= endTime ? '回放结束' : '已暂停' }}</span></div><div class="playback-right"><span>播放速度</span><ElSelect v-model="speed" size="small" aria-label="播放速度" class="speed-select"><ElOption v-for="rate in [.5, 1, 2, 4]" :key="rate" :label="`${rate}×`" :value="rate"/></ElSelect></div></div><div class="timeline"><ElSlider :model-value="currentTime" :min="startTime" :max="endTime" :step=".01" :format-tooltip="v => `${f(v, 2)} s`" aria-label="回放时间" @update:model-value="seek"/><div class="time-ticks"><span v-for="i in 5" :key="i">{{ f(startTime + (endTime - startTime) * (i - 1) / 4, 0) }} s</span></div></div></div>
              </section>
              <aside class="panel settings-panel">
                <div class="panel-heading"><div class="panel-title"><SlidersHorizontal :size="17"/><h2>显示设置</h2></div></div>
                <div class="settings-body">
                  <div class="display-options">
                    <div class="switch-row"><span>飞行轨迹</span><ElSwitch v-model="showTrail" aria-label="显示飞行轨迹"/></div>
                    <div class="switch-row"><span>参考轨迹</span><ElSwitch :model-value="hasReferences && showReference" @update:model-value="showReference = $event" :disabled="!hasReferences" aria-label="显示参考轨迹" :title="hasReferences ? '参考轨迹' : '当前记录未提供参考轨迹'"/></div>
                    <div class="switch-row"><span>狭缝环境</span><ElSwitch v-model="showWalls" aria-label="显示窄隙环境"/></div>
                    <div class="switch-row"><span>循环播放</span><ElSwitch v-model="loop" aria-label="循环播放"/></div>
                  </div>
                  <div class="attitude-box"><div class="section-label">{{ headingOffsetRad ? '原始姿态角' : '姿态角' }}</div><div class="attitude-values"><div><small>滚转</small><strong>{{ f(deg(sample.roll), 1) }}<em>°</em></strong></div><div><small>俯仰</small><strong>{{ f(deg(sample.pitch), 1) }}<em>°</em></strong></div><div><small>偏航</small><strong>{{ f(deg(sample.yaw), 1) }}<em>°</em></strong></div></div></div>
                  <button class="source-note" @click="infoOpen = true"><Info :size="14"/><span>{{ isPlanned ? '运动学规划 · 非闭环仿真' : isOriginal ? '实验回放 · 位置由误差重建' : '用户导入数据' }}</span><ChevronRight :size="12"/></button>
                </div>
              </aside>
            </div>
            <section v-if="stages.length" class="stage-strip" aria-label="参考任务阶段"><div class="stage-caption"><Wind :size="16"/><span>飞行阶段</span></div><button v-for="(stage, i) in stages" :key="stage.name" :class="['stage-item', { current: stageIndex === i, completed: stageIndex > i }]" @click="seek(stage.from)"><span class="stage-number"><Check v-if="stageIndex > i" :size="13"/><span v-else>{{ String(i + 1).padStart(2, '0') }}</span></span><span class="stage-text">{{ stage.name }}<small>{{ f(stage.from, isPlanned ? 1 : 0) }}–{{ f(stage.to, isPlanned ? 1 : 0) }} s</small></span><ChevronRight v-if="i !== stages.length - 1" :size="13" class="stage-arrow"/></button></section>
          </template>

          <section class="panel chart-panel" :class="{ 'analysis-chart': page === 'analysis' }"><div class="panel-heading"><div class="panel-title"><ChartNoAxesCombined :size="17"/><h2>飞行曲线</h2></div><div class="chart-tabs" aria-label="响应曲线类型"><button v-for="tab in chartTabs" :key="tab.id" :class="{ active: chartMode === tab.id }" @click="chartMode = tab.id">{{ tab.label }}</button></div><button v-if="page === 'workspace'" class="text-button chart-expand" @click="setPage('analysis')">详细分析 <ArrowUpRight :size="14"/></button><ElButton v-else size="small" @click="exportCsv"><ArrowDownToLine :size="14"/>导出 CSV</ElButton></div><div class="chart-container"><FlightChart :samples="samples" :time="currentTime" :mode="chartMode" :rotor-unit="metadata.rotorSpeedUnit || '单位未提供'" @seek="seek"/></div><div class="chart-footer"><span><span class="small-dot teal"/>点击曲线定位时间</span><span class="mono">t = {{ f(currentTime, 2) }} s</span></div></section>
          <section v-if="page === 'analysis'" class="panel table-panel"><div class="panel-heading"><div class="panel-title"><Database :size="17"/><h2>采样数据预览</h2><span class="subtle-tag">约 {{ tableRows.length }} 点预览</span></div><span class="tiny-label">完整数据可导出 CSV</span></div><div class="table-scroll"><table><thead><tr><th>时间 / s</th><th>X / m</th><th>Y / m</th><th>Z / m</th><th>滚转 / °</th><th>俯仰 / °</th><th>偏航 / °</th><th>倾转 / °</th></tr></thead><tbody><tr v-for="s in visibleRows" :key="s.t" @click="seek(s.t)"><td>{{ f(s.t) }}</td><td>{{ f(s.x, 3) }}</td><td>{{ f(s.y, 3) }}</td><td>{{ f(s.z, 3) }}</td><td>{{ f(deg(s.roll)) }}</td><td>{{ f(deg(s.pitch)) }}</td><td>{{ f(deg(s.yaw)) }}</td><td>{{ f(deg(s.tilt)) }}</td></tr></tbody></table></div><div class="table-pagination"><span>点击数据行可定位曲线时间</span><div><button class="icon-button" :disabled="tablePage === 1" aria-label="上一页数据" @click="tablePage--"><ArrowLeft :size="15"/></button><span>{{ tablePage }} / {{ pageCount }}</span><button class="icon-button" :disabled="tablePage >= pageCount" aria-label="下一页数据" @click="tablePage++"><ArrowRight :size="15"/></button></div></div></section>
        </template>

        <template v-else-if="page === 'records'">
          <section class="record-grid"><article v-for="d in datasets" :key="d.id" class="panel record-card"><div class="record-card-top"><span class="record-file-icon"><FileJson :size="24"/></span><span class="subtle-tag" :class="{ 'green-tag': activeId === d.id }">{{ activeId === d.id ? '当前实验' : '可回放' }}</span></div><h2>{{ d.id === 'recorded' ? '倾转穿越 · 配套实验' : d.data.metadata.title }}</h2><p>{{ d.id === 'recorded' ? 'MATLAB 图文件记录，包含位置、姿态、倾转角和旋翼转速。' : d.data.metadata.description || '从本地导入的仿真结果。' }}</p><div class="record-meta"><span>{{ d.data.samples.length.toLocaleString() }} 采样点</span><span>{{ f(d.data.samples.at(-1).t - d.data.samples[0].t, 1) }} s</span></div><button class="record-open" @click="useRecord(d.id)">打开实验 <ArrowRight :size="16"/></button></article><button class="record-import" @click="fileInput?.click()"><span><Upload :size="25"/></span><strong>添加实验记录</strong><small>导入 MATLAB 导出的 JSON 文件</small></button></section><p class="page-note"><Info :size="15"/>导入记录保留在当前页面会话中。刷新前可导出 JSON 保存；不会上传到外部服务器。</p>
        </template>

        <template v-else>
          <section class="guide-hero panel"><div class="guide-icon"><GraduationCap :size="32"/></div><div><span class="eyebrow">GETTING STARTED</span><h2>先复现仿真，再讲清楚你的实验。</h2><p>TiltLab 将现有 MATLAB / Simulink 结果转为可交互的三维回放。位置、姿态和曲线共享同一条时间轴，适合课堂讲解、项目答辩与研究记录。</p></div></section><div class="guide-grid"><article class="panel guide-card"><span class="guide-step">01</span><h2>运行与导出</h2><p>在 MATLAB 中完成仿真，将时间、位置、姿态和倾转角整理成等长列向量。使用项目内的 <code>matlab/export_demo_data.m</code> 导出标准 JSON。</p><div class="guide-tip">单位明确：位置用 m，时间用 s；输入角度统一用 rad 或 deg。</div></article><article class="panel guide-card"><span class="guide-step">02</span><h2>导入与检查</h2><p>点击“导入数据”，选择 JSON。系统检查字段、数值和时间顺序，再将角度统一换算。请先核对起点、终点和坐标轴方向。</p><div class="guide-tip">每次最多 100,000 点，35 MB；导入处理全程在浏览器内完成。</div></article><article class="panel guide-card"><span class="guide-step">03</span><h2>回放与分析</h2><p>播放或拖动时间轴观察机架倾转，切换视角与曲线类型。在“数据分析”页面查看全程指标，并导出完整 CSV。</p><div class="guide-tip"><kbd>Space</kbd> 播放 / 暂停　<kbd>←</kbd> <kbd>→</kbd> 前后 1 秒</div></article></div><section class="panel guide-details"><h2>参数化飞行怎么用</h2><p>在实验工作台直接输入狭缝净宽与目标悬停高度，再点击“计算并演示”。可在“更多参数”调整最大倾转角、每侧预留间隙与峰值速度。0.40 m 狭缝通常可以水平通过；0.24 m 狭缝配合默认余量，会自动计算出明显的倾转动作。</p><p>系统按固定机体和完整桨盘尺寸，在允许范围内以 0.25° 分辨率寻找最小可行倾转角。穿越期间机头沿通道对齐，宽度不够时提示无法通过。目标高度过高时，先在通道有效高度内穿越，再于出口外上升至目标，悬停 3 秒后平稳降落。生成的方案可从“数据说明”导出 JSON，后续导入会同时恢复通道和任务阶段。</p><p>在页面顶部的“当前记录”中，可随时选择配套实验或已生成方案进行回放。　这些是浏览器生成的几何与运动学方案，不是论文控制器的闭环仿真。规划净距可直接观察，跟踪误差和旋翼转速不作虚构。</p></section><section class="panel guide-details"><h2>这个版本支持什么</h2><div class="scope-grid"><div><h3><Check :size="17"/>现在可以使用</h3><p>参数化狭缝与悬停高度、自动倾角计算、三维轨迹、曲线联动、实验导入与结果导出。构建后可在本地离线使用。</p></div><div><h3><Settings2 :size="17"/>后续可扩展</h3><p>网页调参运行 Simulink、故障注入与多算法对比需要接入实际可运行的模型及后端。参数化模式在浏览器中计算几何可行倾角与平滑航迹；真实闭环控制仿真仍需后端模型。</p></div></div><h3>坐标与模型约定</h3><p>世界坐标 Z 轴向上；原始姿态采用 Rz(yaw) · Ry(pitch) · Rx(roll)。机头沿局部 +Y，正倾转使右侧降低，旋翼反向补偿。内置穿缝示意将显示航向校准 −60° 以对齐通道，原始姿态读数与曲线保持不变。三维机体按示意比例绘制，参数化模式检查当前几何包络与规划通道的净距；结果不代表实机或动力学通过性验证。</p><ElButton @click="infoOpen = true"><Info :size="15"/>查看内置实验数据说明</ElButton></section>
        </template>
        <footer class="page-footer"><span><span class="status-dot"/>{{ isPlanned ? '浏览器几何与运动学规划' : 'MATLAB / Simulink 仿真结果可视化' }}</span><span>TiltLab · 本地演示</span></footer>
      </main>
    </div>
    <ElDialog v-model="infoOpen" title="实验数据来源与说明" width="640px" class="source-dialog" :close-on-click-modal="false"><div class="dialog-record"><Database :size="21"/><div><strong>{{ metadata.title }}</strong><span>{{ samples.length.toLocaleString() }} 点 · {{ f(startTime, 1) }}–{{ f(endTime, 1) }} s · 位置 m / 角度 rad</span></div></div><p>{{ metadata.description }}</p><template v-if="isOriginal"><h3>原始材料</h3><p>来自“倾转四旋翼无人机(1).zip”中的 figure1–figure8.fig。使用已保存的曲线，没有重新运行仿真。原位置图部分通道与误差图矛盾，当前轨迹依据模型中的误差定义和参考轨迹重建。</p></template><h3>阅读与演示时请注意</h3><ul class="limitation-list"><li v-for="(note, i) in limitations" :key="i">{{ note }}</li><li>{{ isPlanned ? '规划按显示机体及完整旋翼包络检查几何净距，未进行动力学验证。' : '三维机体及旋翼自转为示意，记录回放不执行在线碰撞控制。' }}</li><li>播放速度只改变演示快慢，不改变数据；页面未接入在线 MATLAB 计算。</li></ul><p class="dialog-footnote">导出 JSON 包含完整 metadata 来源说明。姿态显示单位为 °，CSV 与 JSON 姿态单位为 rad。</p><template #footer><ElButton @click="exportJson"><ArrowDownToLine :size="15"/>导出完整 JSON</ElButton><ElButton type="primary" @click="infoOpen = false">了解，开始探索</ElButton></template></ElDialog>
  </div>
</template>
