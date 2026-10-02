// ASCII-only status glyphs. Some terminal fonts (tmux) render the fancy code
// points as missing boxes, so every status surface — statusline, `barrito status`
// — draws from this one map. A future --unicode flag swaps these values, never
// the call sites.
export const glyphs = {
  sep: ' | ', // part separator
  warn: '!', // marks a non-max tier
  reroute: ' > ', // session's model vs what actually answers
  api: '(API)', // API credits, not Max plan
  resets: 'Max resets', // quota window reset prefix
  throttled: 'throttled, retry', // throttle probe reset prefix
  pin: 'pin', // identity pinned to a model
  pinMax: 'pin max', // identity pinned to max
}
