// Long-running work (backup, restore, export) reported back as progress events.
// A job posts { event: 'job', job } on the renderer's port; the RPC call that
// started it returns right away with the job id.
const { t } = require('../../shared/i18n.mjs')
let nextJob = 1
const running = new Map() // id -> { cancel }

function startJob(port, { kind, title }, run) {
  const id = String(nextJob++)
  let cancelled = false
  let last = 0
  const state = { id, kind, title, state: 'running', startedAt: Date.now(), done: 0, total: 0, rows: 0, table: null, tablesDone: 0, tables: 0, detail: {} }

  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - last < 150) return
    last = now
    try {
      port.postMessage({ event: 'job', job: { ...state } })
    } catch {}
  }

  const job = {
    get totalRows() { return state.rows },
    get tableCount() { return state.tables },
    check() {
      if (cancelled) throw Object.assign(new Error(t('Cancelado pelo usuário')), { cancelled: true })
    },
    // Table-based jobs: expected rows are estimates, used only for the bar.
    plan(tables, counts) {
      state.tables = tables.length
      state.total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0)
      emit(true)
    },
    table(name) {
      if (state.table) state.tablesDone++
      state.table = name
      emit(true)
    },
    rows: (n) => {
      state.rows += n
      state.done = state.rows
      emit()
    },
    // Byte-based jobs (restore).
    progress({ done, total, ...detail }) {
      state.done = done
      state.total = total
      state.detail = detail
      emit()
    },
  }

  running.set(id, { cancel: () => { cancelled = true } })
  emit(true)
  Promise.resolve()
    .then(() => run(job))
    .then((result) => {
      if (state.table) state.tablesDone++
      Object.assign(state, { state: 'done', result, finishedAt: Date.now() })
    })
    .catch((e) => Object.assign(state, { state: cancelled ? 'cancelled' : 'error', error: e.message, finishedAt: Date.now() }))
    .finally(() => {
      running.delete(id)
      emit(true)
    })
  return { jobId: id }
}

function cancelJob(id) {
  running.get(id)?.cancel()
}

module.exports = { startJob, cancelJob }
