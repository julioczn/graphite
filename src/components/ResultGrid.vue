<script setup>
// Virtualised result grid: only the visible rows are in the DOM, so a few
// thousand rows scroll smoothly. Supports keyboard navigation, copy, column
// resize, header sorting, (optionally) staged cell edits / row deletes and a
// right-click menu for cells, headers and row numbers.
import { ref, reactive, computed, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import ContextMenu from './ContextMenu.vue'
import { isDeleteKey, key, shortcut } from '../lib/keys'
import { toast } from '../lib/store'
import { insertSql } from '../lib/sqlText'
import { t } from '../lib/i18n'

const props = defineProps({
  fields: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
  offset: { type: Number, default: 0 },
  sortable: Boolean,
  sort: Object, // { col, dir }
  editable: Boolean,
  edits: { type: Object, default: () => ({}) }, // 'r:c' -> value
  deleted: { type: Object, default: () => ({}) }, // r -> true
  pk: { type: Array, default: () => [] },
  // Finer-grained control for query results: which columns map back to a
  // table, whether a given cell can be written and whether rows can be deleted.
  colEditable: { type: Array, default: null },
  canEdit: { type: Function, default: null },
  canDelete: { type: Boolean, default: true },
  // Table views: offer "filter by this value" (emits `filter`) and
  // "copy as INSERT" into this already-quoted table name.
  filterable: Boolean,
  insertTarget: { type: String, default: null },
  binary: { type: Array, default: () => [] }, // indexes of byte columns (preview text only)
})
// sort(field, dir?) — dir is 'asc' | 'desc' | null when picked from the menu,
// omitted when the header was clicked (the parent cycles the direction).
const emit = defineEmits(['sort', 'edit', 'toggleDelete', 'filter'])

const RH = 28
const OVERSCAN = 12
const scroller = ref(null)
const scrollTop = ref(0)
const viewH = ref(600)
const sel = reactive({ r: -1, c: -1, row: false })
const editing = ref(null) // { r, c, value }
let editInput = null
const widths = ref([])

const numW = computed(() => Math.max(44, String(props.offset + props.rows.length).length * 8 + 22))

watch(() => props.fields, () => {
  // Estimate column widths from the header and a sample of rows.
  const sample = props.rows.slice(0, 200)
  widths.value = props.fields.map((f, c) => {
    let max = String(f).length + 2
    for (const r of sample) {
      const v = r[c]
      const len = v === null ? 4 : String(v).length
      if (len > max) max = len
    }
    return Math.min(380, Math.max(72, max * 7.4 + 26))
  })
  sel.r = sel.c = -1
  editing.value = null
  if (scroller.value) scroller.value.scrollTop = 0
}, { immediate: true })

const range = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / RH) - OVERSCAN)
  const end = Math.min(props.rows.length, Math.ceil((scrollTop.value + viewH.value) / RH) + OVERSCAN)
  return { start, end }
})
const visible = computed(() => props.rows.slice(range.value.start, range.value.end))
const totalW = computed(() => numW.value + widths.value.reduce((a, b) => a + b, 0))

function onScroll(e) {
  scrollTop.value = e.target.scrollTop
  viewH.value = e.target.clientHeight
}

function value(r, c) {
  const k = `${r}:${c}`
  return k in props.edits ? props.edits[k] : props.rows[r][c]
}

function display(v) {
  if (v === null || v === undefined) return 'NULL'
  const s = String(v)
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

function select(r, c, row = false) {
  sel.r = r
  sel.c = c
  sel.row = row
  scroller.value?.focus({ preventScroll: true })
}

function ensureVisible() {
  const el = scroller.value
  if (!el || sel.r < 0) return
  const top = sel.r * RH
  const headerH = RH
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + RH > el.scrollTop + el.clientHeight - headerH) el.scrollTop = top + RH * 2 - el.clientHeight
}

function cellEditable(r, c) {
  if (!props.editable || props.deleted[r]) return false
  if (props.colEditable && !props.colEditable[c]) return false
  return props.canEdit ? props.canEdit(r, c) : true
}

function startEdit(r, c) {
  if (!cellEditable(r, c)) return
  const v = value(r, c)
  editing.value = { r, c, value: v === null ? '' : String(v), wasNull: v === null }
  nextTick(() => { editInput?.focus(); editInput?.select() })
}

function commitEdit() {
  const e = editing.value
  if (!e) return
  editing.value = null
  const original = props.rows[e.r][e.c]
  const unchanged = (e.wasNull && e.value === '') || String(original ?? '') === e.value && original !== null
  if (!unchanged) emit('edit', e.r, e.c, e.value)
  scroller.value?.focus({ preventScroll: true })
}

function cancelEdit() {
  editing.value = null
  scroller.value?.focus({ preventScroll: true })
}

// done: confirmation toast text (none for the plain Ctrl+C copy).
async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    if (done) toast(done, 'info', 1600)
  } catch (e) {
    toast(t('Não foi possível copiar: {error}', { error: e.message }), 'error')
  }
}

// --- right-click menu -------------------------------------------------------
const menu = ref(null)
const isBinary = (c) => props.binary.includes(c)
const rowTsv = (r) => props.fields.map((_, c) => value(r, c) ?? '').join('\t')
const rowJson = (r) => JSON.stringify(Object.fromEntries(props.fields.map((f, c) => [f, value(r, c)])), null, 2)
function rowInsert(r) {
  const cols = props.fields.map((_, c) => c).filter((c) => !isBinary(c))
  return insertSql(props.insertTarget, cols.map((c) => props.fields[c]), cols.map((c) => value(r, c)))
}

function closeMenu() {
  menu.value = null
  scroller.value?.focus({ preventScroll: true })
}

function rowItems(r) {
  return [
    { label: t('Copiar linha'), icon: 'copy', hint: sel.row ? shortcut('mod', 'c') : '', run: () => copy(rowTsv(r), t('Linha copiada')) },
    { label: t('Copiar linha como JSON'), icon: 'code', run: () => copy(rowJson(r), t('JSON copiado')) },
    props.insertTarget && { label: t('Copiar linha como INSERT'), icon: 'code', run: () => copy(rowInsert(r), t('INSERT copiado')) },
  ]
}

function deleteItem(r) {
  if (!props.editable || !props.canDelete) return null
  return props.deleted[r]
    ? { label: t('Desmarcar exclusão da linha'), icon: 'undo', run: () => emit('toggleDelete', r) }
    : { label: t('Marcar linha para exclusão'), icon: 'trash', danger: true, hint: sel.row ? key('del') : '', run: () => emit('toggleDelete', r) }
}

function openCellMenu(e, r, c) {
  if (editing.value?.r === r && editing.value?.c === c) return // native menu inside the editor
  e.preventDefault()
  select(r, c)
  const v = value(r, c)
  const orig = props.rows[r][c]
  const edited = `${r}:${c}` in props.edits
  const canWrite = cellEditable(r, c)
  const filterOk = props.filterable && !isBinary(c)
  const f = props.fields[c]
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: t('Copiar valor'), icon: 'copy', hint: shortcut('mod', 'c'), run: () => copy(String(v ?? ''), t('Valor copiado')) },
      ...rowItems(r),
      { sep: true },
      props.editable && { label: t('Editar célula'), icon: 'structure', hint: key('enter'), disabled: !canWrite, run: () => startEdit(r, c) },
      props.editable && { label: t('Definir como NULL'), icon: 'close', hint: key('del'), disabled: !canWrite || v === null, run: () => emit('edit', r, c, null) },
      props.editable && { label: t("Definir como texto vazio ('')"), icon: 'close', disabled: !canWrite || v === '', run: () => emit('edit', r, c, '') },
      props.editable && edited && { label: t('Restaurar valor original'), icon: 'undo', run: () => emit('edit', r, c, orig) },
      { sep: true },
      filterOk && { label: orig === null ? t('Filtrar: {column} é NULL', { column: f }) : t('Filtrar por este valor'), icon: 'filter', run: () => emit('filter', f, orig, false) },
      filterOk && { label: orig === null ? t('Filtrar: {column} não é NULL', { column: f }) : t('Filtrar excluindo este valor'), icon: 'filter', run: () => emit('filter', f, orig, true) },
      { sep: true },
      deleteItem(r),
    ],
  }
}

function openRowMenu(e, r) {
  e.preventDefault()
  select(r, -1, true)
  menu.value = { x: e.clientX, y: e.clientY, items: [...rowItems(r), { sep: true }, deleteItem(r)] }
}

function fitColumn(c) {
  let max = String(props.fields[c]).length + 2
  const n = Math.min(props.rows.length, 5000)
  for (let r = 0; r < n; r++) {
    const len = display(value(r, c)).length
    if (len > max) max = len
  }
  widths.value[c] = Math.min(900, Math.max(72, max * 7.4 + 26))
}

function openHeaderMenu(e, c) {
  e.preventDefault()
  const f = props.fields[c]
  const sorted = props.sort?.col === f
  const filterOk = props.filterable && !isBinary(c)
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      props.sortable && { label: t('Ordenar crescente'), icon: 'arrowUp', disabled: sorted && props.sort.dir === 'asc', run: () => emit('sort', f, 'asc') },
      props.sortable && { label: t('Ordenar decrescente'), icon: 'arrowDown', disabled: sorted && props.sort.dir === 'desc', run: () => emit('sort', f, 'desc') },
      props.sortable && sorted && { label: t('Remover ordenação'), icon: 'close', run: () => emit('sort', f, null) },
      { sep: true },
      filterOk && { label: t('Filtrar: {column} é NULL', { column: f }), icon: 'filter', run: () => emit('filter', f, null, false) },
      filterOk && { label: t('Filtrar: {column} não é NULL', { column: f }), icon: 'filter', run: () => emit('filter', f, null, true) },
      { sep: true },
      { label: t('Copiar nome da coluna'), icon: 'copy', run: () => copy(f, t('Nome copiado')) },
      { label: t('Copiar valores da coluna'), icon: 'copy', disabled: !props.rows.length,
        run: () => copy(props.rows.map((_, r) => value(r, c) ?? '').join('\n'), t('{n} valor copiado|{n} valores copiados', { n: props.rows.length })) },
      { sep: true },
      { label: t('Ajustar largura ao conteúdo'), icon: 'fit', run: () => fitColumn(c) },
    ],
  }
}

function onKey(e) {
  // Keys typed in the cell editor bubble up here; the Enter that commits an
  // edit must not reopen the editor.
  if (editing.value || e.target !== scroller.value) return
  const rows = props.rows.length
  const cols = props.fields.length
  if (!rows) return
  const mod = e.ctrlKey || e.metaKey
  const move = (dr, dc) => {
    e.preventDefault()
    sel.row = false
    sel.r = Math.min(rows - 1, Math.max(0, (sel.r < 0 ? 0 : sel.r) + dr))
    sel.c = Math.min(cols - 1, Math.max(0, (sel.c < 0 ? 0 : sel.c) + dc))
    ensureVisible()
  }
  switch (isDeleteKey(e) ? 'Delete' : e.key) {
    case 'ArrowDown': return move(1, 0)
    case 'ArrowUp': return move(-1, 0)
    case 'ArrowLeft': return move(0, -1)
    case 'ArrowRight': return move(0, 1)
    case 'Tab': return move(0, e.shiftKey ? -1 : 1)
    case 'PageDown': return move(Math.floor(viewH.value / RH) - 1, 0)
    case 'PageUp': return move(-Math.floor(viewH.value / RH) + 1, 0)
    case 'Home': return mod ? move(-rows, 0) : move(0, -cols)
    case 'End': return mod ? move(rows, 0) : move(0, cols)
    case 'Enter':
    case 'F2':
      if (sel.r >= 0 && sel.c >= 0 && !sel.row) { e.preventDefault(); startEdit(sel.r, sel.c) }
      return
    case 'Delete':
      if (!props.editable || sel.r < 0) return
      e.preventDefault()
      if (sel.row) props.canDelete && emit('toggleDelete', sel.r)
      else if (cellEditable(sel.r, sel.c)) emit('edit', sel.r, sel.c, null)
      return
    case 'Escape':
      sel.r = sel.c = -1
      return
  }
  if (mod && e.key.toLowerCase() === 'c' && sel.r >= 0) {
    e.preventDefault()
    if (sel.row || sel.c < 0) copy(rowTsv(sel.r))
    else copy(String(value(sel.r, sel.c) ?? ''))
  }
}

function startResize(e, c) {
  const x0 = e.clientX
  const w0 = widths.value[c]
  const move = (ev) => { widths.value[c] = Math.max(48, w0 + ev.clientX - x0) }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function cellClass(r, c, v) {
  return {
    sel: !sel.row && sel.r === r && sel.c === c,
    null: v === null,
    n: typeof v === 'number',
    edited: `${r}:${c}` in props.edits,
  }
}

defineExpose({ focus: () => scroller.value?.focus() })
</script>

<template>
  <div ref="scroller" class="grid" tabindex="0" @scroll="onScroll" @keydown="onKey">
    <table :style="{ width: totalW + 'px' }">
      <colgroup>
        <col :style="{ width: numW + 'px' }" />
        <col v-for="(w, c) in widths" :key="c" :style="{ width: w + 'px' }" />
      </colgroup>
      <thead>
        <tr>
          <th class="num-h" />
          <th v-for="(f, c) in fields" :key="c"
              :class="{ sortable, sorted: sort?.col === f, ro: editable && colEditable && !colEditable[c] }"
              :title="editable && colEditable && !colEditable[c] ? t('{column} — somente leitura', { column: f }) : f" @click="sortable && emit('sort', f)"
              @contextmenu="openHeaderMenu($event, c)">
            <span class="th-in">
              <Icon v-if="pk.includes(f)" name="key" :size="11" class="pk" />
              <span class="th-name">{{ f }}</span>
              <Icon v-if="sort?.col === f" :name="sort.dir === 'desc' ? 'arrowDown' : 'arrowUp'" :size="12" />
            </span>
            <span class="rz" @mousedown.stop.prevent="startResize($event, c)" @click.stop />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="range.start" :style="{ height: range.start * RH + 'px' }" class="spacer"><td :colspan="fields.length + 1" /></tr>
        <tr v-for="(row, i) in visible" :key="range.start + i" :class="{ deleted: deleted[range.start + i], selrow: sel.row && sel.r === range.start + i }">
          <td class="num" @click="select(range.start + i, -1, true)" @contextmenu="openRowMenu($event, range.start + i)">{{ offset + range.start + i + 1 }}</td>
          <td v-for="(_, c) in fields" :key="c" :class="cellClass(range.start + i, c, value(range.start + i, c))"
              @mousedown="select(range.start + i, c)" @dblclick="startEdit(range.start + i, c)"
              @contextmenu="openCellMenu($event, range.start + i, c)">
            <input v-if="editing && editing.r === range.start + i && editing.c === c" :ref="(el) => el && (editInput = el)"
                   v-model="editing.value" class="cell-input" spellcheck="false"
                   @keydown.enter.prevent="commitEdit" @keydown.esc.prevent="cancelEdit" @keydown.tab.prevent="commitEdit"
                   @blur="commitEdit" />
            <template v-else>{{ display(value(range.start + i, c)) }}</template>
          </td>
        </tr>
        <tr v-if="range.end < rows.length" :style="{ height: (rows.length - range.end) * RH + 'px' }" class="spacer"><td :colspan="fields.length + 1" /></tr>
      </tbody>
    </table>
    <div v-if="!rows.length" class="no-rows">{{ t('Nenhuma linha') }}</div>
    <ContextMenu :menu="menu" @close="closeMenu" />
  </div>
</template>

<style scoped>
.grid {
  position: relative;
  height: 100%;
  overflow: auto;
  outline: none;
  background: var(--surface-1);
  font-size: 12.5px;
}
table { table-layout: fixed; border-collapse: separate; border-spacing: 0; }
th, td {
  height: 28px;
  padding: 0 10px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}
thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--surface-3);
  border-bottom-color: var(--line-3);
  color: var(--fg-2);
  font-weight: 600;
  font-size: 12px;
}
th.sortable { cursor: pointer; }
th.sortable:hover { background: var(--surface-4); color: var(--fg); }
th.sorted { color: var(--fg); background: var(--surface-4); }
th.ro { color: var(--fg-4); font-weight: 500; font-style: italic; }
.th-in { display: flex; align-items: center; gap: 5px; min-width: 0; }
.th-name { overflow: hidden; text-overflow: ellipsis; }
.pk { color: var(--fg); }
.rz { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 3; }
.rz:hover { background: var(--sel-3); }
.num-h, .num {
  position: sticky; left: 0; z-index: 1;
  text-align: right;
  color: var(--fg-4);
  background: var(--surface-2);
  font: 11px var(--mono);
  cursor: pointer;
}
.num-h { z-index: 3; background: var(--surface-3); }
td { color: var(--fg); font-family: var(--mono); font-size: 12px; cursor: default; }
td.num:hover { color: var(--fg-2); }
td.null { color: var(--fg-4); font-style: italic; }
td.n { text-align: right; }
tr:hover td:not(.num) { background: rgba(255, 255, 255, 0.025); }
tr.selrow td { background: var(--sel-2) !important; }
tr.selrow td.num { color: var(--fg); box-shadow: inset 2px 0 0 var(--fg-2); }
td.sel { background: var(--sel-2) !important; box-shadow: inset 0 0 0 1px var(--fg-3); }
td.edited { background: var(--surface-5); color: #fff; font-weight: 600; }
tr.deleted td:not(.num) { color: var(--fg-4); text-decoration: line-through; background: repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,0.03) 6px 12px); }
.spacer td { padding: 0; border: 0; }
.cell-input {
  width: 100%; height: 22px; padding: 0 4px;
  border: 1px solid var(--fg-2); border-radius: 3px;
  background: var(--bg); color: #fff; outline: 0;
  font: 12px var(--mono);
}
.no-rows { position: absolute; top: 60px; left: 0; right: 0; text-align: center; color: var(--fg-4); }
</style>
