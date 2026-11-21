<script setup>
// Entity-relationship diagram of the current database / schema.
// Layout: dagre for tables that have relations, a grid for the rest. Drawing
// uses SVG attributes (not CSS classes) so an exported SVG/PNG keeps its look.
import { ref, reactive, computed, watch, nextTick } from 'vue'
import dagre from '@dagrejs/dagre'
import { call, bridge } from '../lib/api'
import { store, toast, openTableTab } from '../lib/store'
import Icon from './Icon.vue'
import ErNode from './ErNode.vue'
import { C, FONT, HEAD, ROW, trunc } from '../lib/erTheme'
import { t, i18n } from '../lib/i18n'

const props = defineProps({ tab: Object, active: Boolean })
const tab = props.tab

const MAX_COLS = 40
const DETAIL_ZOOM = 0.45

// Real text widths (the fallback fonts in the stack differ in width).
const measureCtx = document.createElement('canvas').getContext('2d')
function measure(text, size = 12, weight = 400) {
  measureCtx.font = `${weight} ${size}px ${FONT}`
  return measureCtx.measureText(text).width
}

const loading = ref(false)
const error = ref(null)
const model = ref({ tables: [], relations: [] })
const keysOnly = ref(false)
const inferOn = ref(false)
const selected = ref(null)
const search = ref('')
const pos = reactive({}) // table -> { x, y }
const view = reactive({ x: 40, y: 40, k: 1 })
const svg = ref(null)
let dragging = null

// --- model -----------------------------------------------------------------------

const declared = computed(() => model.value.relations.map((r) => ({ ...r, inferred: false })))

// Many schemas have no FK constraints; guess `<name>_id` -> table <name>/<name>s.
const inferred = computed(() => {
  const byName = new Map(model.value.tables.map((t) => [t.name.toLowerCase(), t]))
  const have = new Set(declared.value.map((r) => `${r.from.table}.${r.from.columns.join()}`))
  const out = []
  for (const t of model.value.tables) {
    for (const c of t.columns) {
      const m = /^(.+?)_?id$/i.exec(c.name)
      if (!m || c.primary || !/_id$|Id$/.test(c.name)) continue
      const base = m[1].toLowerCase()
      const target = [base, base + 's', base + 'es', base.replace(/y$/, 'ies')].map((n) => byName.get(n)).find(Boolean)
      if (!target || target === t || have.has(`${t.name}.${c.name}`)) continue
      const pk = target.columns.filter((x) => x.primary)
      if (pk.length !== 1) continue
      out.push({ name: `${t.name}.${c.name} → ${target.name}`, from: { table: t.name, columns: [c.name] }, to: { table: target.name, columns: [pk[0].name] }, inferred: true })
    }
  }
  return out
})

const relations = computed(() => (inferOn.value ? [...declared.value, ...inferred.value] : declared.value))

const fkCols = computed(() => {
  const s = new Set()
  for (const r of relations.value) for (const c of r.from.columns) s.add(`${r.from.table}.${c}`)
  return s
})

// Visible columns per table (keys-only mode keeps PK / FK columns).
const nodes = computed(() => model.value.tables.map((t) => {
  let cols = t.columns.map((c) => ({ ...c, fk: fkCols.value.has(`${t.name}.${c.name}`) }))
  const total = cols.length
  if (keysOnly.value) cols = cols.filter((c) => c.primary || c.fk)
  const hidden = Math.max(0, cols.length - MAX_COLS) + (total - cols.length)
  cols = cols.slice(0, MAX_COLS)
  const width = Math.ceil(Math.min(440, Math.max(160,
    measure(trunc(t.name, 40), 12.5, 700) + (t.type === 'view' ? 70 : 34),
    ...cols.map((c) => 34 + measure(trunc(c.name, 28), 12, c.primary ? 700 : 400) + 20 + measure(trunc(c.type, 22) + (c.nullable ? '' : ' *'), 11) + 12))))
  const height = HEAD + cols.length * ROW + (hidden ? ROW : 0) + 6
  return { ...t, cols, hidden, width, height }
}))
// Columns are unreadable when zoomed far out; skip drawing them (big schemas stay smooth).
const forceDetail = ref(false) // exports always carry every column
const detail = computed(() => forceDetail.value || view.k >= DETAIL_ZOOM)
const nodeMap = computed(() => new Map(nodes.value.map((n) => [n.name, n])))

// --- layout ------------------------------------------------------------------------

// Lay out each connected group of tables on its own (dagre, LR or TB, whichever
// is closer to the screen's shape), then pack groups and loose tables in rows.
const GAP = 60
function layout() {
  const ns = nodes.value
  const byName = new Map(ns.map((n) => [n.name, n]))
  const rels = relations.value.filter((r) => r.from.table !== r.to.table && byName.has(r.from.table) && byName.has(r.to.table))

  // union-find for connected components
  const parent = new Map(ns.map((n) => [n.name, n.name]))
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)))
  for (const r of rels) parent.set(find(r.from.table), find(r.to.table))
  const groups = new Map()
  for (const n of ns) {
    const root = find(n.name)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(n)
  }

  const el = svg.value
  const target = el && el.clientHeight ? el.clientWidth / el.clientHeight : 1.6
  const blocks = []
  for (const members of groups.values()) {
    if (members.length === 1) {
      const n = members[0]
      blocks.push({ w: n.width, h: n.height, place: [[n.name, 0, 0]], size: 1 })
      continue
    }
    const names = new Set(members.map((n) => n.name))
    let best = null
    for (const rankdir of ['LR', 'TB']) {
      const g = new dagre.graphlib.Graph({ multigraph: true })
      g.setGraph({ rankdir, nodesep: 36, ranksep: rankdir === 'LR' ? 110 : 80, marginx: 0, marginy: 0 })
      g.setDefaultEdgeLabel(() => ({}))
      for (const n of members) g.setNode(n.name, { width: n.width, height: n.height })
      rels.forEach((r, i) => { if (names.has(r.from.table)) g.setEdge(r.to.table, r.from.table, {}, `e${i}`) })
      dagre.layout(g)
      const { width: w, height: h } = g.graph()
      const score = Math.abs(Math.log(w / h / target))
      if (!best || score < best.score) {
        best = { score, w, h, size: members.length, place: g.nodes().map((name) => { const p = g.node(name); return [name, p.x - p.width / 2, p.y - p.height / 2] }) }
      }
    }
    blocks.push(best)
  }

  // Shelf packing: big groups first, rows about as wide as the target ratio asks.
  blocks.sort((a, b) => b.size - a.size || b.h - a.h)
  const area = blocks.reduce((a, b) => a + (b.w + GAP) * (b.h + GAP), 0)
  const rowWidth = Math.max(blocks[0]?.w ?? 0, Math.sqrt(area * target))
  let x = 0, y = 0, rowH = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) { x = 0; y += rowH + GAP; rowH = 0 }
    for (const [name, px, py] of b.place) pos[name] = { x: x + px, y: y + py }
    x += b.w + GAP
    rowH = Math.max(rowH, b.h)
  }
}

function bounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const n of nodes.value) {
    const p = pos[n.name]
    if (!p) continue
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x + n.width); y2 = Math.max(y2, p.y + n.height)
  }
  return x1 === Infinity ? { x1: 0, y1: 0, x2: 100, y2: 100 } : { x1, y1, x2, y2 }
}

function fit() {
  const el = svg.value
  if (!el) return
  const b = bounds()
  const w = el.clientWidth, h = el.clientHeight
  const k = Math.min(1.2, Math.max(0.03, Math.min((w - 60) / (b.x2 - b.x1), (h - 60) / (b.y2 - b.y1))))
  view.k = k
  view.x = (w - (b.x2 - b.x1) * k) / 2 - b.x1 * k
  view.y = (h - (b.y2 - b.y1) * k) / 2 - b.y1 * k
}

function zoomBy(f, cx, cy) {
  const el = svg.value
  cx ??= el.clientWidth / 2
  cy ??= el.clientHeight / 2
  const k = Math.min(3, Math.max(0.03, view.k * f))
  view.x = cx - ((cx - view.x) * k) / view.k
  view.y = cy - ((cy - view.y) * k) / view.k
  view.k = k
}

function center(name) {
  const n = nodeMap.value.get(name), p = pos[name], el = svg.value
  if (!n || !p || !el) return
  if (view.k < 0.6) view.k = 0.8
  view.x = el.clientWidth / 2 - (p.x + n.width / 2) * view.k
  view.y = el.clientHeight / 2 - (p.y + n.height / 2) * view.k
}

async function load() {
  loading.value = true
  error.value = null
  try {
    model.value = await call('er/model', { sId: store.connection.sId })
    // No declared FKs at all: show the guessed ones right away.
    inferOn.value = !model.value.relations.length && inferred.value.length > 0
    for (const k of Object.keys(pos)) delete pos[k]
    layout()
    await nextTick()
    fit()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch([keysOnly, inferOn], async () => {
  layout()
  await nextTick()
  fit()
})
watch(() => props.active, (a) => { if (a && !model.value.tables.length && !loading.value) load() }, { immediate: true })

// --- edges ---------------------------------------------------------------------------

function anchorY(n, col) {
  const i = n.cols.findIndex((c) => c.name === col)
  return i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2
}

const edges = computed(() => relations.value.map((r, i) => {
  const a = nodeMap.value.get(r.from.table), b = nodeMap.value.get(r.to.table)
  const pa = pos[r.from.table], pb = pos[r.to.table]
  if (!a || !b || !pa || !pb) return null
  const sy = pa.y + anchorY(a, r.from.columns[0])
  const ty = pb.y + anchorY(b, r.to.columns[0])
  let sx, tx, sd, td // d = direction leaving the box (+1 right, -1 left)
  if (a === b) { sx = tx = pa.x + a.width; sd = td = 1 }
  else if (pa.x + a.width + 20 < pb.x) { sx = pa.x + a.width; tx = pb.x; sd = 1; td = -1 }
  else if (pb.x + b.width + 20 < pa.x) { sx = pa.x; tx = pb.x + b.width; sd = -1; td = 1 }
  else { sx = pa.x + a.width; tx = pb.x + b.width; sd = td = 1 }
  const off = 14 // room for the crow's foot / bar
  const s1 = sx + sd * off, t1 = tx + td * off
  const bend = a === b ? 46 : Math.max(36, Math.abs(t1 - s1) / 2)
  const d = `M${sx},${sy} H${s1} C${s1 + sd * bend},${sy} ${t1 + td * bend},${ty} ${t1},${ty} H${tx}`
  // many (crow's foot) at the FK side, one (double bar) at the referenced side
  const foot = `M${s1},${sy} L${sx},${sy - 6} M${s1},${sy} L${sx},${sy + 6} M${s1},${sy - 6} V${sy + 6}`
  const bar = `M${tx + td * 5},${ty - 6} V${ty + 6} M${tx + td * 9},${ty - 6} V${ty + 6}`
  return { id: i, r, d, marks: foot + ' ' + bar }
}).filter(Boolean))

// --- highlighting --------------------------------------------------------------------

const related = computed(() => {
  const s = selected.value
  if (!s) return null
  const set = new Set([s])
  for (const r of relations.value) {
    if (r.from.table === s) set.add(r.to.table)
    if (r.to.table === s) set.add(r.from.table)
  }
  return set
})
const matches = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? nodes.value.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.name) : []
})
const nodeOpacity = (name) => (related.value && !related.value.has(name) ? 0.22 : search.value && !matches.value.includes(name) ? 0.35 : 1)
const edgeHot = (e) => !!selected.value && (e.r.from.table === selected.value || e.r.to.table === selected.value)
const edgeOpacity = (e) => (selected.value ? (edgeHot(e) ? 1 : 0.1) : search.value ? 0.25 : 0.9)

function onSearchKey(e) {
  if (e.key === 'Enter' && matches.value.length) {
    selected.value = matches.value[0]
    center(matches.value[0])
  } else if (e.key === 'Escape') {
    search.value = ''
  }
}

// --- pointer interaction ------------------------------------------------------------

function toWorld(e) {
  const r = svg.value.getBoundingClientRect()
  return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }
}

function onPointerDown(e, name = null) {
  if (e.button !== 0) return
  const w = toWorld(e)
  dragging = name
    ? { kind: 'node', name, dx: w.x - pos[name].x, dy: w.y - pos[name].y, moved: false, id: e.pointerId, x0: e.clientX, y0: e.clientY }
    : { kind: 'pan', sx: e.clientX - view.x, sy: e.clientY - view.y, moved: false, id: e.pointerId, x0: e.clientX, y0: e.clientY }
}

function onPointerMove(e) {
  if (!dragging) return
  if (!dragging.moved) {
    if (Math.abs(e.clientX - dragging.x0) + Math.abs(e.clientY - dragging.y0) < 4) return
    // Capture only once it is really a drag, so clicks / double clicks stay on the node.
    dragging.moved = true
    svg.value.setPointerCapture(dragging.id)
  }
  if (dragging.kind === 'pan') {
    view.x = e.clientX - dragging.sx
    view.y = e.clientY - dragging.sy
  } else {
    const w = toWorld(e)
    pos[dragging.name] = { x: w.x - dragging.dx, y: w.y - dragging.dy }
  }
}

function onPointerUp() {
  if (dragging && !dragging.moved) selected.value = dragging.kind === 'node' ? (selected.value === dragging.name ? null : dragging.name) : null
  dragging = null
}

function onWheel(e) {
  e.preventDefault()
  const r = svg.value.getBoundingClientRect()
  zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
}

function openTable(n) {
  const t = store.tables.find((x) => x.name === n.name && (x.schema ?? null) === (n.schema ?? x.schema ?? null))
  openTableTab(t || { name: n.name, schema: n.schema, type: n.type })
}

// --- export --------------------------------------------------------------------------

function exportSvgText() {
  const b = bounds()
  const pad = 30
  const w = Math.ceil(b.x2 - b.x1 + pad * 2), h = Math.ceil(b.y2 - b.y1 + pad * 2)
  const clone = svg.value.cloneNode(true)
  clone.querySelector('.bg-grid')?.remove()
  clone.querySelector('.viewport').setAttribute('transform', `translate(${pad - b.x1},${pad - b.y1})`)
  clone.setAttribute('width', w)
  clone.setAttribute('height', h)
  clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.removeAttribute('class')
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', w); bg.setAttribute('height', h); bg.setAttribute('fill', C.bg)
  clone.insertBefore(bg, clone.firstChild)
  return { text: new XMLSerializer().serializeToString(clone), w, h }
}

const fileBase = () => `er_${(tab.scope || t('banco')).replace(/[^\w.-]+/g, '_')}`

async function exportSvg() {
  const prev = selected.value
  selected.value = null
  forceDetail.value = true
  await nextTick()
  const { text } = exportSvgText()
  selected.value = prev
  forceDetail.value = false
  const file = await bridge.saveFile({ defaultName: `${fileBase()}.svg`, content: text, filters: [{ name: 'SVG', extensions: ['svg'] }] })
  if (file) toast(t('Diagrama exportado'), 'success', 5000, { label: t('Mostrar na pasta'), run: () => bridge.showItem(file) })
}

async function exportPng() {
  const prev = selected.value
  selected.value = null
  forceDetail.value = true
  await nextTick()
  const { text, w, h } = exportSvgText()
  selected.value = prev
  forceDetail.value = false
  const scale = Math.min(2, 16000 / Math.max(w, h)) // stay under canvas limits
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  const b64 = canvas.toDataURL('image/png').split(',')[1]
  const file = await bridge.saveFile({ defaultName: `${fileBase()}.png`, content: b64, encoding: 'base64', filters: [{ name: 'PNG', extensions: ['png'] }] })
  if (file) toast(t('Diagrama exportado'), 'success', 5000, { label: t('Mostrar na pasta'), run: () => bridge.showItem(file) })
}

watch([() => model.value.tables.length, relations, () => props.active, () => i18n.locale], () => {
  if (!props.active) return
  tab.status = [
    t('{n} tabela|{n} tabelas', { n: model.value.tables.length }),
    t('{n} FK|{n} FKs', { n: declared.value.length }),
    ...(inferOn.value ? [t('{n} inferida|{n} inferidas', { n: inferred.value.length })] : []),
  ]
})

</script>

<template>
  <div class="er">
    <div class="toolbar">
      <div class="search">
        <Icon name="search" :size="13" />
        <input v-model="search" :placeholder="t('Localizar tabela (Enter centraliza)')" spellcheck="false" @keydown="onSearchKey" />
        <span v-if="search" class="n">{{ matches.length }}</span>
      </div>
      <label class="tog" :title="t('Mostrar só colunas de chave primária / estrangeira')">
        <input v-model="keysOnly" type="checkbox" /> {{ t('Só chaves') }}
      </label>
      <label class="tog" :title="t('Relações por nome de coluna (*_id → tabela). {n} encontrada|Relações por nome de coluna (*_id → tabela). {n} encontradas', { n: inferred.length })">
        <input v-model="inferOn" type="checkbox" :disabled="!inferred.length" /> {{ t('Inferir relações') }} <span class="n">{{ inferred.length }}</span>
      </label>
      <span class="grow" />
      <button class="btn ghost icon sm" :title="t('Reorganizar')" @click="layout(); fit()"><Icon name="layout" :size="14" /></button>
      <button class="btn ghost icon sm" :title="t('Ajustar à tela')" @click="fit"><Icon name="fit" :size="14" /></button>
      <button class="btn ghost icon sm" :title="t('Diminuir zoom')" @click="zoomBy(1 / 1.25)"><Icon name="zoomOut" :size="14" /></button>
      <button class="zoom" title="100%" @click="zoomBy(1 / view.k)">{{ Math.round(view.k * 100) }}%</button>
      <button class="btn ghost icon sm" :title="t('Aumentar zoom')" @click="zoomBy(1.25)"><Icon name="zoomIn" :size="14" /></button>
      <span class="sep" />
      <button class="btn ghost sm" :title="t('Exportar SVG')" :disabled="!nodes.length" @click="exportSvg"><Icon name="download" :size="13" /> SVG</button>
      <button class="btn ghost sm" :title="t('Exportar PNG')" :disabled="!nodes.length" @click="exportPng"><Icon name="image" :size="13" /> PNG</button>
      <button class="btn ghost icon sm" :title="t('Recarregar do banco')" @click="load"><Icon name="refresh" :size="14" /></button>
    </div>

    <div class="canvas">
      <div v-if="loading" class="state"><span class="spinner" /> {{ t('Lendo estrutura…') }}</div>
      <div v-else-if="error" class="state err"><Icon name="alert" :size="18" /> {{ error }}</div>
      <div v-else-if="!nodes.length" class="state">{{ store.connection.dialect === 'postgres' ? t('Nenhuma tabela neste schema') : t('Nenhuma tabela neste banco') }}</div>
      <div v-if="!loading && nodes.length && !declared.length" class="banner">
        <Icon name="info" :size="13" />
        {{ t('Nenhuma chave estrangeira declarada.') }}<template v-if="inferred.length"> {{ t('Linhas tracejadas são relações inferidas pelo nome das colunas.') }}</template>
      </div>

      <svg ref="svg" class="svg" :font-family="FONT" font-size="12"
           @pointerdown="onPointerDown($event)" @pointermove="onPointerMove" @pointerup="onPointerUp" @wheel="onWheel">
        <defs>
          <pattern id="er-dots" width="24" height="24" patternUnits="userSpaceOnUse"
                   :patternTransform="`translate(${view.x},${view.y}) scale(${view.k})`">
            <circle cx="1" cy="1" r="1" :fill="C.grid" />
          </pattern>
        </defs>
        <rect class="bg-grid" width="100%" height="100%" fill="url(#er-dots)" />
        <g class="viewport" :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
          <g v-for="e in edges" :key="e.id" :opacity="edgeOpacity(e)">
            <title>{{ e.r.from.table }}.{{ e.r.from.columns.join(', ') }} → {{ e.r.to.table }}.{{ e.r.to.columns.join(', ') }}{{ e.r.inferred ? ` (${t('inferida')})` : ` (${e.r.name})` }}</title>
            <path :d="e.d" fill="none" :stroke="edgeHot(e) ? C.edgeHi : C.edge" :stroke-width="edgeHot(e) ? 1.8 : 1.2"
                  :vector-effect="detail ? null : 'non-scaling-stroke'"
                  :stroke-dasharray="e.r.inferred ? '5 4' : null" />
            <path :d="e.marks" fill="none" :stroke="edgeHot(e) ? C.edgeHi : C.edge" :stroke-width="1.3" />
          </g>

          <ErNode v-for="n in nodes" :key="n.name" :n="n" :x="pos[n.name]?.x ?? 0" :y="pos[n.name]?.y ?? 0"
                  :selected="selected === n.name" :opacity="nodeOpacity(n.name)" :detail="detail"
                  @grab="onPointerDown($event, n.name)" @open="openTable(n)" />
        </g>
      </svg>

      <div class="legend">
        <span><b>PK</b> {{ t('chave primária') }}</span><span><b>FK</b> {{ t('chave estrangeira') }}</span><span><b>*</b> NOT NULL</span>
        <span>{{ t('clique destaca · duplo clique abre · arraste move · roda do mouse dá zoom') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.er { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toolbar { display: flex; align-items: center; gap: 8px; height: 44px; flex: none; padding: 0 10px; background: var(--surface-2); border-bottom: 1px solid var(--line-2); }
.search { display: flex; align-items: center; gap: 7px; width: 300px; height: 28px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--surface-1); color: var(--fg-4); }
.search:focus-within { border-color: var(--fg-4); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font-size: 12px; }
.n { color: var(--fg-4); font: 11px var(--mono); }
.tog { display: flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 12px; cursor: pointer; white-space: nowrap; }
.grow { flex: 1; }
.sep { width: 1px; height: 18px; background: var(--line-3); }
.zoom { min-width: 48px; height: 24px; border: 1px solid var(--line-2); border-radius: 5px; background: var(--surface-1); color: var(--fg-2); font: 11px var(--mono); cursor: pointer; }
.canvas { position: relative; flex: 1; min-height: 0; background: #0f0f0f; }
.svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; user-select: none; }
.svg:active { cursor: grabbing; }
.node { cursor: pointer; }
.state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--fg-3); pointer-events: none; }
.state.err { color: var(--fg); }
.spinner { width: 16px; height: 16px; border: 2px solid var(--fg-4); border-top-color: var(--fg); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.banner { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--line-3); border-radius: 16px; background: var(--surface-3); color: var(--fg-2); font-size: 12px; pointer-events: none; }
.legend { position: absolute; left: 12px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 14px; padding: 5px 10px; border-radius: 6px; background: rgba(15, 15, 15, 0.85); color: var(--fg-4); font-size: 11px; pointer-events: none; }
.legend b { color: var(--fg-2); font-family: var(--mono); }
</style>
