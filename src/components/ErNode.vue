<script setup>
// One table of the ER diagram. Kept as its own component so dragging one
// table re-renders only that table, not every column of every table.
import { C, HEAD, ROW, trunc } from '../lib/erTheme'

// detail = false (zoomed out): name + column count only, ~20x fewer SVG nodes to paint.
defineProps({ n: Object, x: Number, y: Number, selected: Boolean, opacity: Number, detail: { type: Boolean, default: true } })
defineEmits(['grab', 'open'])
</script>

<template>
  <g :transform="`translate(${x},${y})`" :opacity="opacity" class="node"
     @pointerdown.stop="$emit('grab', $event)" @dblclick.stop="$emit('open')">
    <title>{{ n.name }} — duplo clique abre a tabela</title>
    <rect :width="n.width" :height="n.height" rx="7" :fill="C.node" :stroke="selected ? C.lineSel : C.line" :stroke-width="selected ? 1.6 : 1" />
    <path :d="`M0,7 a7,7 0 0 1 7,-7 h${n.width - 14} a7,7 0 0 1 7,7 v${HEAD - 7} h-${n.width} z`" :fill="selected ? C.headSel : C.head" />
    <text x="12" :y="HEAD / 2 + 4" :fill="C.text" font-weight="700" font-size="12.5">{{ trunc(n.name, 40) }}</text>
    <text v-if="n.type === 'view'" :x="n.width - 12" :y="HEAD / 2 + 4" text-anchor="end" :fill="C.text3" font-size="10.5">view</text>
    <text v-if="!detail" x="12" :y="HEAD + 24" :fill="C.text3" font-size="13">{{ n.columns.length }} colunas</text>
    <g v-for="(c, i) in detail ? n.cols : []" :key="c.name" :transform="`translate(0,${HEAD + i * ROW})`">
      <line v-if="i" x1="8" :x2="n.width - 8" y1="0" y2="0" :stroke="C.grid" />
      <text x="10" :y="ROW / 2 + 4" :fill="c.primary ? C.key : C.text4" font-size="10" font-weight="700">{{ c.primary ? 'PK' : c.fk ? 'FK' : '' }}</text>
      <text x="34" :y="ROW / 2 + 4" :fill="c.primary || c.fk ? C.text : C.text2" :font-weight="c.primary ? 700 : 400">{{ trunc(c.name, 28) }}</text>
      <text :x="n.width - 10" :y="ROW / 2 + 4" text-anchor="end" :fill="C.text3" font-size="11">{{ trunc(c.type, 22) }}{{ c.nullable ? '' : ' *' }}</text>
    </g>
    <text v-if="detail && n.hidden" x="34" :y="HEAD + n.cols.length * ROW + ROW / 2 + 4" :fill="C.text4" font-size="11" font-style="italic">
      + {{ n.hidden }} coluna{{ n.hidden === 1 ? '' : 's' }}
    </text>
  </g>
</template>
