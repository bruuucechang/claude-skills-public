export type Reading = { at: number; tokens: number; window: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'ctx-panel': { readings: Reading[]; cum: number; turns: number }
  }
}
