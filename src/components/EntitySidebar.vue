<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { call } from '../lib/api'
import { openTableTab, newQueryTab, refreshEntities, selectSql, tableKey, toast, openErTab, caps, useSession } from '../lib/store'
import Icon from './Icon.vue'
import SchemaPicker from './SchemaPicker.vue'
import ContextMenu from './ContextMenu.vue'
import { tableSnippets } from '../lib/snippets'
import { tableName } from '../lib/sqlText'
import { t } from '../lib/i18n'

const sess = useSession()

const filter = ref('')
const collapsed = reactive({ table: false, view: false })
const expanded = reactive({}) // key -> columns | 'loading'
const refreshing = ref(false)

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const match = (t) => !q || tableKey(t, sess).toLowerCase().includes(q)
  return [
    { type: 'table', label: t('Tabelas'), items: sess.tables.filter((t) => t.type === 'table' && match(t)) },
    { type: 'view', label: t('Views'), items: sess.tables.filter((t) => t.type === 'view' && match(t)) },
  ].filter((g) => g.items.length || !q)
})

// MySQL connected without a default database: nothing to list yet.
const needsDatabase = computed(() => sess.connection.dialect === 'mysql' && !sess.connection.schema)

// Column lists belong to the previous database / schema.
watch(() => sess.connection.schema, () => {
  for (const k of Object.keys(expanded)) delete expanded[k]
  filter.value = ''
})

async function toggle(t) {
  const k = tableKey(t, sess)
  if (expanded[k]) return delete expanded[k]
  expanded[k] = 'loading'
  try {
    expanded[k] = await call('conn/listColumns', { sId: sess.connection.sId, table: t.name, schema: t.schema })
  } catch (e) {
    delete expanded[k]
    toast(e.message, 'error')
  }
}

// --- right-click: open, generate SQL from the real columns, copy, export ----
const menu = ref(null)

async function columnsOf(t) {
  const cached = expanded[tableKey(t, sess)]
  if (Array.isArray(cached)) return cached
  return call('conn/listColumns', { sId: sess.connection.sId, table: t.name, schema: t.schema })
}

// New query tab whose SQL expands as a snippet (Tab walks the value fields).
function openGenerated(t, kind, body) {
  const tab = newQueryTab(sess, '', `${kind} ${t.name}`)
  tab.snippet = body
}

async function openMenu(e, tbl) {
  e.preventDefault()
  const { clientX: x, clientY: y } = e
  let gen = null
  // SQL generation only makes sense where the query language is SQL.
  if (caps(sess).sql !== false) {
    try {
      gen = tableSnippets(tbl, await columnsOf(tbl))
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const isTable = tbl.type !== 'view'
  const g = (kind, label, body, extra = {}) => body && { label, icon: 'code', run: () => openGenerated(tbl, kind, body), ...extra }
  menu.value = {
    x, y,
    items: [
      { label: t('Abrir dados'), icon: 'table', run: () => openTableTab(sess, tbl) },
      { label: t('Estrutura'), icon: 'structure', run: () => openTableTab(sess, tbl, 'structure') },
      { sep: true },
      gen && g('SELECT', t('Gerar SELECT'), gen.select),
      gen && g('JOIN', t('Gerar SELECT com JOINs (FKs)'), gen.join),
      gen && isTable && g('INSERT', t('Gerar INSERT'), gen.insert),
      gen && isTable && g('UPDATE', t('Gerar UPDATE'), gen.update),
      gen && isTable && g('DELETE', t('Gerar DELETE'), gen.delete, { danger: true }),
      { sep: true },
      { label: t('Copiar nome'), icon: 'copy', run: () => navigator.clipboard.writeText(tableName(tbl.name, tbl.schema)).then(() => toast(t('Nome copiado'), 'info', 1600)) },
      { label: t('Exportar dados…'), icon: 'export', run: () => (sess.dialog = { type: 'export', props: { tables: [tbl] } }) },
    ],
  }
}

async function refresh() {
  refreshing.value = true
  try {
    await refreshEntities(sess)
    for (const k of Object.keys(expanded)) delete expanded[k]
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div class="ents">
    <div class="head">
      <div class="title">
        <span class="label">{{ sess.connection.saved?.name || sess.connection.database || t('Banco') }}</span>
        <span class="n">{{ sess.tables.length }}</span>
      </div>
      <div class="tools">
        <button v-if="caps(sess).er" class="btn ghost icon sm" :title="t('Diagrama ER')" :disabled="needsDatabase" @click="openErTab(sess)"><Icon name="diagram" :size="14" /></button>
        <button class="btn ghost icon sm" :title="t('Exportar dados')" :disabled="needsDatabase" @click="sess.dialog = { type: 'export', props: {} }"><Icon name="export" :size="14" /></button>
        <button v-if="caps(sess).backup" class="btn ghost icon sm" :title="t('Backup')" :disabled="needsDatabase" @click="sess.dialog = { type: 'backup' }"><Icon name="archive" :size="14" /></button>
        <button v-if="caps(sess).restore" class="btn ghost icon sm" :title="t('Restaurar backup')" :disabled="needsDatabase" @click="sess.dialog = { type: 'restore' }"><Icon name="upload" :size="14" /></button>
        <button class="btn ghost icon sm" :title="t('Recarregar')" :disabled="refreshing" @click="refresh">
          <Icon name="refresh" :size="14" :class="{ spin: refreshing }" />
        </button>
      </div>
    </div>

    <SchemaPicker v-if="sess.connection.dialect !== 'sqlite'" />

    <div class="search">
      <Icon name="filter" :size="13" />
      <input v-model="filter" :placeholder="t('Filtrar entidades')" spellcheck="false" />
      <button v-if="filter" class="clear" @click="filter = ''"><Icon name="close" :size="12" /></button>
    </div>

    <div class="tree">
      <div v-if="needsDatabase" class="pick-hint">
        <Icon name="database" :size="20" />
        {{ t('Escolha um banco acima para ver as tabelas') }}
      </div>
      <div v-for="g in needsDatabase ? [] : groups" :key="g.type" class="group">
        <button class="group-head" @click="collapsed[g.type] = !collapsed[g.type]">
          <Icon name="chevron" :size="12" class="chev" :class="{ open: !collapsed[g.type] }" />
          {{ g.label }} <span class="n">{{ g.items.length }}</span>
        </button>
        <template v-if="!collapsed[g.type]">
          <div v-if="!g.items.length" class="none">{{ t('Nenhuma') }}</div>
          <div v-for="tbl in g.items" :key="tableKey(tbl, sess)">
            <div class="item" :title="tableKey(tbl, sess)" @click="openTableTab(sess, tbl)" @contextmenu="openMenu($event, tbl)">
              <button class="exp" @click.stop="toggle(tbl)">
                <Icon name="chevron" :size="12" class="chev" :class="{ open: expanded[tableKey(tbl, sess)] }" />
              </button>
              <Icon :name="tbl.type === 'view' ? 'view' : 'table'" :size="14" class="kind" />
              <span class="name">{{ tableKey(tbl, sess) }}</span>
              <span class="acts">
                <button :title="t('Nova consulta SELECT')" @click.stop="newQueryTab(sess, selectSql(sess, tbl), tbl.name)"><Icon name="code" :size="13" /></button>
                <button :title="t('Estrutura')" @click.stop="openTableTab(sess, tbl, 'structure')"><Icon name="structure" :size="13" /></button>
                <button :title="t('Exportar')" @click.stop="sess.dialog = { type: 'export', props: { tables: [tbl] } }"><Icon name="export" :size="13" /></button>
              </span>
            </div>
            <div v-if="expanded[tableKey(tbl, sess)] === 'loading'" class="col muted">{{ t('carregando…') }}</div>
            <div v-for="c in (Array.isArray(expanded[tableKey(tbl, sess)]) ? expanded[tableKey(tbl, sess)] : [])" :key="c.name" class="col"
                 :title="`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.references ? ' → ' + c.references : ''}`">
              <Icon :name="c.primary ? 'key' : c.references ? 'link' : 'column'" :size="12" class="col-ico" :class="{ pk: c.primary }" />
              <span class="col-name">{{ c.name }}</span>
              <span class="col-type">{{ c.type }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
    <ContextMenu :menu="menu" @close="menu = null" />
  </div>
</template>

<style scoped>
.ents { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 8px 0 14px; }
.tools { display: flex; gap: 0; flex: none; }
.tools .btn { width: 26px; padding: 0; }
.title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.n { font-size: 11px; color: var(--fg-4); font-weight: 500; letter-spacing: 0; text-transform: none; }

.search {
  display: flex; align-items: center; gap: 8px;
  margin: 0 10px 8px; padding: 0 8px; height: 28px;
  border: 1px solid var(--line-2); border-radius: var(--radius);
  background: var(--surface-2); color: var(--fg-4);
}
.search:focus-within { border-color: var(--fg-4); color: var(--fg-2); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); }
.search input::placeholder { color: var(--fg-4); }
.clear { border: 0; background: transparent; color: var(--fg-3); cursor: pointer; padding: 2px; display: grid; }

.tree { flex: 1; overflow: auto; padding: 0 6px 16px; }
.group-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 6px; border: 0; background: transparent;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--fg-3); cursor: pointer; text-align: left;
}
.group-head:hover { color: var(--fg-2); }
.chev { transition: transform 0.12s; color: var(--fg-4); }
.chev.open { transform: rotate(90deg); }
.pick-hint { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; color: var(--fg-4); text-align: center; }
.none { padding: 2px 30px 6px; color: var(--fg-4); }

.item {
  display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 4px 0 2px;
  border-radius: 5px; cursor: pointer; color: var(--fg-2);
}
.item:hover { background: var(--sel); color: var(--fg); }
.exp { display: grid; place-items: center; width: 18px; height: 18px; border: 0; border-radius: 4px; background: transparent; cursor: pointer; padding: 0; }
.exp:hover { background: var(--sel-2); }
.kind { color: var(--fg-3); }
.name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acts { display: none; gap: 2px; }
.item:hover .acts { display: flex; }
.acts button { display: grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 4px; background: transparent; color: var(--fg-3); cursor: pointer; }
.acts button:hover { background: var(--sel-2); color: var(--fg); }

.col { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px 0 30px; color: var(--fg-3); font-size: 12px; }
.col-ico { color: var(--fg-4); }
.col-ico.pk { color: var(--fg); }
.col-name { color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-type { margin-left: auto; padding-left: 8px; font: 11px var(--mono); color: var(--fg-4); white-space: nowrap; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
