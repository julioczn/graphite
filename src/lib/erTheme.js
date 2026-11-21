// ER diagram palette and metrics. Colours are applied as SVG attributes (not
// CSS variables) so exported SVG / PNG files look the same as the screen.
export const C = {
  bg: '#0f0f0f', grid: '#1a1a1a', node: '#1b1b1b', head: '#2a2a2a', headSel: '#3a3a3a', line: '#333333', lineSel: '#8a8a8a',
  text: '#ececec', text2: '#b5b5b5', text3: '#7d7d7d', text4: '#5c5c5c', edge: '#5f5f5f', edgeHi: '#e0e0e0', key: '#ffffff',
}
export const FONT = "'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Ubuntu Mono', ui-monospace, monospace"
export const HEAD = 30
export const ROW = 21
export const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
