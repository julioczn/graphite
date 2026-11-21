import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { initI18n } from './lib/i18n'

// The language comes from main (preference or OS) before the first render.
initI18n()
  .catch((e) => console.error('i18n', e))
  .finally(() => createApp(App).mount('#app'))
