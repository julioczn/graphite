// Platform-aware labels for keyboard hints. The handlers themselves accept
// Ctrl or Cmd everywhere; this only changes what the UI shows.
export const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)

const LABELS = isMac
  ? { mod: '⌘', shift: '⇧', enter: '↩', del: '⌫', alt: '⌥', ctrl: '⌃' }
  : { mod: 'Ctrl', shift: 'Shift', enter: 'Enter', del: 'Del', alt: 'Alt', ctrl: 'Ctrl' }

export const key = (k) => LABELS[k] ?? (k.length === 1 ? k.toUpperCase() : k)

// shortcut('mod', 'shift', 'enter') → "⌘⇧↩" on macOS, "Ctrl+Shift+Enter" elsewhere.
export const shortcut = (...keys) => keys.map(key).join(isMac ? '' : '+')

// The Mac "delete" key sends Backspace; forward-delete needs fn.
export const isDeleteKey = (e) => e.key === 'Delete' || (isMac && e.key === 'Backspace')
