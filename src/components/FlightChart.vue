<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer])

const props = defineProps({
  samples: { type: Array, default: () => [] },
  time: { type: Number, default: 0 },
  mode: { type: String, default: 'position' },
  axis: { type: String, default: 'all' },
  rotorUnit: { type: String, default: '单位未提供' },
})
const emit = defineEmits(['seek'])
const host = ref(null)
const ready = ref(false)
let chart, resizeObserver, cursorTimer, resizeFrame
let lastCursorUpdate = 0
const colors = ['#129b8f', '#5484c5', '#d59b50', '#9b7ac6']
const valid = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
const reference = (sample, axis) => sample[`ref${axis.toUpperCase()}`] ?? sample.reference?.[axis] ?? sample[`${axis}Ref`] ?? sample[`${axis}r`]
const modes = {
  position: { unit: '位置 / m', keys: ['x', 'y', 'z'], names: ['X 位置', 'Y 位置', 'Z 高度'] },
  attitude: { unit: '角度 / °', keys: ['roll', 'pitch', 'yaw', 'tilt'], names: ['滚转角', '俯仰角', '偏航角', '倾转角'] },
  error: { unit: '误差 / m', keys: ['x', 'y', 'z'], names: ['X 误差', 'Y 误差', 'Z 误差'] },
  rotors: { unit: '转速 / 原始单位', keys: ['w1', 'w2', 'w3', 'w4'], names: ['旋翼 1', '旋翼 2', '旋翼 3', '旋翼 4'] },
}
const configuration = computed(() => props.mode === 'rotors' ? { ...modes.rotors, unit: `转速 / ${props.rotorUnit}` } : modes[props.mode] || modes.position)
const fields = computed(() => configuration.value.keys.filter(key => props.axis === 'all' || key === props.axis))

function valueAt(sample, key) {
  if (!valid(sample[key])) return null
  if (props.mode === 'error') {
    const target = reference(sample, key)
    return valid(target) ? Number(target) - Number(sample[key]) : null
  }
  return Number(sample[key]) * (props.mode === 'attitude' ? 180 / Math.PI : 1)
}

const available = computed(() => fields.value.filter(key => props.samples.some(sample => valid(sample.t) && valueAt(sample, key) !== null)))
const emptyText = computed(() => props.mode === 'rotors'
  ? '当前数据未包含旋翼转速，请导入含 w1–w4 字段的仿真结果。'
  : props.mode === 'error'
    ? '当前数据缺少参考轨迹，无法计算跟踪误差。'
    : '当前数据未包含可显示的曲线。')

function cursor() {
  return {
    silent: true,
    symbol: ['none', 'none'],
    animation: false,
    lineStyle: { color: '#314f61', type: 'dashed', width: 1, opacity: .65 },
    label: {
      show: true, position: 'insideEndTop', distance: 6,
      formatter: `${Number(props.time).toFixed(2)} s`,
      color: '#5b7180', fontSize: 9, backgroundColor: '#ffffffdf', padding: [3, 4],
    },
    data: Number.isFinite(props.time) ? [{ xAxis: props.time }] : [],
  }
}

function makeSeries(key) {
  const index = configuration.value.keys.indexOf(key)
  return {
    id: `actual-${key}`,
    name: configuration.value.names[index],
    type: 'line',
    data: props.samples.filter(sample => valid(sample.t)).map(sample => [Number(sample.t), valueAt(sample, key)]),
    showSymbol: false, symbol: 'none', connectNulls: false,
    animation: false, sampling: 'lttb', clip: true,
    lineStyle: { width: 1.65, color: colors[index] },
    itemStyle: { color: colors[index] },
    emphasis: { focus: 'series', lineStyle: { width: 2.3 } },
  }
}

function rebuild() {
  if (!chart) return
  clearTimeout(cursorTimer)
  cursorTimer = undefined
  const series = available.value.map(makeSeries)
  if (props.mode === 'position') {
    for (const key of fields.value) {
      if (!props.samples.some(sample => valid(reference(sample, key)))) continue
      const index = configuration.value.keys.indexOf(key)
      series.push({
        id: `reference-${key}`, name: `${key.toUpperCase()} 参考`, type: 'line',
        data: props.samples.filter(sample => valid(sample.t)).map(sample => [Number(sample.t), valid(reference(sample, key)) ? Number(reference(sample, key)) : null]),
        showSymbol: false, symbol: 'none', connectNulls: false,
        animation: false, sampling: 'lttb', clip: true,
        lineStyle: { color: colors[index], width: 1.15, type: 'dashed', opacity: .48 },
        itemStyle: { color: colors[index], opacity: .5 },
        emphasis: { focus: 'series' },
      })
    }
  }
  series.push({ id: 'replay-cursor', type: 'line', data: [], silent: true, animation: false, markLine: cursor() })
  const times = props.samples.filter(sample => valid(sample.t)).map(sample => Number(sample.t))
  const first = times.length ? times[0] : 0
  const last = times.length ? times[times.length - 1] : 40
  chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif', fontSize: 11, color: '#718290' },
    grid: { top: 55, left: 56, right: 23, bottom: 34, containLabel: false },
    legend: {
      top: 3, right: 15, left: 105, type: 'scroll', itemWidth: 14, itemHeight: 3, itemGap: 16,
      icon: 'roundRect', textStyle: { color: '#718290', fontSize: 10 },
      pageIconColor: '#67818e', pageIconInactiveColor: '#d9e0e5', pageTextStyle: { color: '#8795a1' },
      data: series.filter(item => item.name).map(item => item.name),
    },
    tooltip: {
      trigger: 'axis', confine: true, transitionDuration: 0,
      backgroundColor: 'rgba(255,255,255,.97)', borderColor: '#e5ecef', borderWidth: 1,
      padding: [10, 13], textStyle: { color: '#506475', fontSize: 11 },
      extraCssText: 'box-shadow:0 4px 18px rgba(35,62,78,.08);border-radius:8px;',
      axisPointer: { type: 'line', lineStyle: { color: '#a7b8c3', type: 'dashed' } },
      formatter: params => {
        if (!params?.length) return ''
        const time = Number(params[0].value?.[0] ?? params[0].axisValue)
        const entries = params.filter(item => item.seriesId !== 'replay-cursor').map(item => {
          const value = item.value?.[1]
          return `${item.marker} ${item.seriesName}<span style="float:right;margin-left:22px;font-variant-numeric:tabular-nums">${valid(value) ? Number(value).toFixed(3) : '—'}</span>`
        })
        return `<div style="margin-bottom:7px;color:#8b9aa6">时间 ${Number.isFinite(time) ? time.toFixed(2) : '—'} s</div>${entries.join('<br>')}`
      },
    },
    xAxis: {
      type: 'value', min: first, max: last > first ? last : first + 1,
      name: '时间 / s', nameLocation: 'end', nameGap: -39,
      nameTextStyle: { color: '#91a0aa', fontSize: 9, padding: [27, 0, 0, 0] },
      splitNumber: 8, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#94a2ac', fontSize: 10, margin: 11, hideOverlap: true, formatter: value => Number(value.toFixed(2)) },
      splitLine: { show: true, lineStyle: { color: '#eef2f5', type: 'dashed' } },
      axisPointer: { label: { show: false } },
    },
    yAxis: {
      type: 'value', scale: props.mode !== 'error', splitNumber: 4,
      name: configuration.value.unit, nameLocation: 'end', nameGap: 19,
      nameTextStyle: { color: '#899ba7', fontSize: 10, align: 'left', padding: [0, 0, 0, -38] },
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#94a2ac', fontSize: 10, margin: 12, formatter: value => Math.abs(value) >= 10000 ? value.toExponential(1) : Number(value.toFixed(3)) },
      splitLine: { show: true, lineStyle: { color: '#edf1f4', type: 'dashed' } },
    },
    series,
  }, { notMerge: true, lazyUpdate: false })
  lastCursorUpdate = performance.now()
}

function updateCursor() {
  if (!chart || !available.value.length) return
  // Only the tiny cursor series is merged; sampled flight curves remain unchanged.
  chart.setOption({ series: [{ id: 'replay-cursor', markLine: cursor() }] }, { lazyUpdate: true, silent: true })
  lastCursorUpdate = performance.now()
}

function scheduleCursor() {
  if (cursorTimer !== undefined) return
  const delay = Math.max(0, 1000 / 15 - (performance.now() - lastCursorUpdate))
  if (delay === 0) updateCursor()
  else cursorTimer = setTimeout(() => { cursorTimer = undefined; updateCursor() }, delay)
}

function seekAt(event) {
  if (!chart || !available.value.length) return
  const pixel = [event.offsetX, event.offsetY]
  if (!chart.containPixel({ gridIndex: 0 }, pixel)) return
  const values = chart.convertFromPixel({ gridIndex: 0 }, pixel)
  const value = Array.isArray(values) ? values[0] : values
  if (Number.isFinite(value)) emit('seek', value)
}

watch(() => [props.samples, props.mode, props.axis, props.rotorUnit], rebuild)
watch(() => props.time, scheduleCursor)

onMounted(() => {
  chart = echarts.init(host.value, null, { renderer: 'canvas' })
  chart.getZr().on('click', seekAt)
  rebuild()
  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => chart?.resize())
  })
  resizeObserver.observe(host.value)
  ready.value = true
})

onBeforeUnmount(() => {
  clearTimeout(cursorTimer)
  cancelAnimationFrame(resizeFrame)
  resizeObserver?.disconnect()
  if (chart) {
    chart.getZr().off('click', seekAt)
    chart.dispose()
    chart = null
  }
})
</script>

<template>
  <div class="flight-chart">
    <div ref="host" class="flight-chart-canvas" :aria-label="`${configuration.unit}随时间变化的曲线，点击曲线区域定位回放时间`" role="img" />
    <div v-if="ready && !available.length" class="flight-chart-empty" role="status">
      <span class="empty-wave">∿</span>
      <strong>{{ mode === 'rotors' ? '暂无旋翼转速数据' : '暂无可显示的数据' }}</strong>
      <p>{{ emptyText }}</p>
    </div>
  </div>
</template>

<style scoped>
.flight-chart { position: relative; height: 100%; width: 100%; min-height: 190px; background: #fff; }
.flight-chart-canvas { position: absolute; inset: 0; }
.flight-chart-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 18px; background: #ffffffed; text-align: center; }
.empty-wave { height: 38px; color: #a7c5c5; font: 42px/1 monospace; margin-bottom: 10px; }
.flight-chart-empty strong { font-size: 12px; font-weight: 500; color: #7c909c; }
.flight-chart-empty p { margin: 8px 0 0; max-width: 360px; font-size: 11px; line-height: 1.7; color: #9ba9b3; }
</style>
