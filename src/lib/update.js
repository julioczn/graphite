// Update state mirrored from the main process (electron/updater.cjs).
import { reactive } from 'vue'
import { toast } from './store'
import { t } from './i18n'

export const update = reactive({
  status: 'idle', // idle | checking | none | available | downloading | ready | installing | error
  current: '',
  latest: null,
  progress: null,
  error: null,
  auto: true,
  canInstall: false,
  dialog: false,
})

const api = () => window.graphite?.update
const clean = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
let announced = null

function apply(s) {
  const was = update.status
  Object.assign(update, s)
  // Announce a new version once per version, when it first shows up.
  if (s.status === 'available' && was !== 'available' && announced !== s.latest?.version) {
    announced = s.latest?.version
    toast(t('Nova versão disponível: {version}', { version: s.latest.version }), 'info', 12000, {
      label: t('Ver'),
      run: () => (update.dialog = true),
    })
  }
}

export async function initUpdate() {
  if (!api()) return
  api().onState(apply)
  apply(await api().state())
}

export const checkUpdate = () => api().check()
export const setAutoUpdate = (on) => api().setAuto(on)
export const openReleasePage = () => api().openPage()

export async function downloadUpdate() {
  try {
    await api().download()
  } catch (e) {
    toast(clean(e), 'error', 8000)
  }
}

export async function installUpdate() {
  try {
    await api().install()
  } catch (e) {
    toast(clean(e), 'error', 8000)
  }
}

export const hasUpdate = () => ['available', 'downloading', 'ready', 'installing'].includes(update.status)
