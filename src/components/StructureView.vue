<script setup>
import { newQueryTab, toast, useSession } from '../lib/store'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'

const sess = useSession()

const props = defineProps({ table: String, columns: Array, indexes: Array, ddl: String })

async function copyDdl() {
  await navigator.clipboard.writeText(props.ddl)
  toast(t('DDL copiado'), 'success')
}
</script>

<template>
  <div class="sv">
    <section>
      <h3>{{ t('Colunas') }} <span>{{ columns.length }}</span></h3>
      <table>
        <thead>
          <tr><th class="w-ico" /><th>{{ t('Nome') }}</th><th>{{ t('Tipo') }}</th><th>{{ t('Nulo') }}</th><th>{{ t('Padrão') }}</th><th>{{ t('Referência') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in columns" :key="c.name">
            <td class="w-ico"><Icon v-if="c.primary" name="key" :size="13" /><Icon v-else-if="c.references" name="link" :size="13" class="dim" /></td>
            <td class="strong">{{ c.name }}</td>
            <td class="mono">{{ c.type }}</td>
            <td>{{ c.nullable ? t('sim') : t('não') }}</td>
            <td class="mono dim">{{ c.default ?? '—' }}</td>
            <td class="mono dim">{{ c.references || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3>{{ t('Índices') }} <span>{{ indexes.length }}</span></h3>
      <p v-if="!indexes.length" class="muted">{{ t('Nenhum índice.') }}</p>
      <table v-else>
        <thead><tr><th>{{ t('Nome') }}</th><th>{{ t('Colunas') }}</th><th>{{ t('Tipo') }}</th></tr></thead>
        <tbody>
          <tr v-for="ix in indexes" :key="ix.name">
            <td class="strong">{{ ix.name }}</td>
            <td class="mono">{{ ix.columns.join(', ') }}</td>
            <td>{{ ix.primary ? t('primária') : ix.unique ? t('única') : t('índice') }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="ddl">
      <h3>
        DDL
        <span class="grow" />
        <button class="btn ghost sm" @click="copyDdl"><Icon name="copy" :size="13" /> {{ t('Copiar') }}</button>
        <button class="btn ghost sm" @click="newQueryTab(sess, ddl, `DDL ${table}`)"><Icon name="code" :size="13" /> {{ t('Abrir') }}</button>
      </h3>
      <pre>{{ ddl }}</pre>
    </section>
  </div>
</template>

<style scoped>
.sv { flex: 1; overflow: auto; padding: 8px 20px 28px; background: var(--surface-2); }
section { max-width: 1100px; margin-top: 18px; }
h3 {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2);
}
h3 span { color: var(--fg-4); font-weight: 500; }
h3 .grow { flex: 1; }
table { width: 100%; border-collapse: collapse; border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden; }
th { text-align: left; height: 30px; padding: 0 12px; background: var(--surface-3); color: var(--fg-3); font-size: 11.5px; font-weight: 600; border-bottom: 1px solid var(--line-3); }
td { height: 30px; padding: 0 12px; border-bottom: 1px solid var(--line); color: var(--fg-2); }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: var(--sel); }
.w-ico { width: 34px; padding-right: 0; color: var(--fg); }
.strong { color: var(--fg); font-weight: 500; }
.mono { font-family: var(--mono); font-size: 12px; }
.dim { color: var(--fg-4); }
pre {
  margin: 0; padding: 14px 16px;
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--bg);
  color: var(--fg-2); font: 12.5px/1.6 var(--mono); white-space: pre-wrap; user-select: text;
}
</style>
