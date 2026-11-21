// Thin wrapper over the preload bridge.
export const bridge = window.graphite

export function call(name, args) {
  return bridge.call(name, args)
}
