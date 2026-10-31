// 无 TUI 预览器：用假 React + 纯文本渲染器跑通挂件真实代码路径，直接打印卡片。
// 用法: node scripts/preview.mjs [widget.mjs]
//   HERMES_MODEL=glm-5.3 node scripts/preview.mjs   # 预览别的模型额度
// 需要能读 ~/.hermes/.env 的 key（真实请求 OpenCode 接口）。
const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || new URL('../opencode-balance.mjs', import.meta.url).pathname

// ── 迷你 React ──
let slots = []
let idx = 0
let effs = []
const React = {
  useState(init) {
    const i = idx++

    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init

    return [
      slots[i],
      (v) => {
        slots[i] = typeof v === 'function' ? v(slots[i]) : v
      }
    ]
  },
  useEffect(fn) {
    effs.push(fn)
  }
}

// ── 元素 ──
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(9).filter((c) => c != null && c !== false) })

const ShimmerRows = ({ rows }) => ({ type: 'Shimmer', props: {}, children: [], rows })
const sparkline = (arr, n) => '▁▂▃▅▆▇'.slice(0, Math.max(1, Math.min(n, arr.length * 2))).padEnd(n, '▄')
const defineWidgetApp = (def) => def
let captured = null
const sdk = {
  Box: 'Box',
  Text: 'Text',
  ShimmerRows,
  sparkline,
  React,
  defineWidgetApp,
  h,
  openWidget: (app) => {
    captured = app
  }
}

// ── 文本渲染 ──
const wideCp = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f300 && cp <= 0x1faff)
const dw = (s) => [...String(s)].reduce((n, ch) => n + (wideCp(ch.codePointAt(0)) ? 2 : 1), 0)
const center = (s, n) => {
  const pad = Math.max(0, n - dw(s))
  const l = Math.floor(pad / 2)

  return ' '.repeat(l) + s + ' '.repeat(pad - l)
}

function lines(node) {
  if (node == null || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(lines)
  if (node.type === 'Shimmer') return node.rows.map(([a, b]) => '░'.repeat(a) + '▒'.repeat(b))
  if (typeof node.type === 'function') {
    const out = node.type({ ...node.props, children: node.children })

    return lines(out)
  }
  if (node.type === 'Text') return [node.children.map(lines).flat().join('')]

  // Box
  const p = node.props

  if (p.justifyContent === 'space-between') {
    const left = node.children[0] ? lines(node.children[0]).join('') : ''
    const right = node.children[1] ? lines(node.children[1]).join('') : ''
    const gap = Math.max(1, (p.width || 0) - dw(left) - dw(right))

    return [left + ' '.repeat(gap) + right]
  }

  const kids = node.children.flatMap(lines)
  const body = p.flexDirection === 'row' ? [kids.join('')] : kids

  if (!p.borderStyle) {
    const padX = p.paddingX || 0

    return body.map((r) => ' '.repeat(padX) + r + ' '.repeat(padX))
  }

  const padX = p.paddingX || 0
  const padded = body.map((r) => ' '.repeat(padX) + r)
  const width = p.width || Math.max(...padded.map(dw)) + 2 + padX * 2
  const inner = width - 2
  const title = p.borderText && p.borderText.content ? p.borderText.content : ''
  const top = '╭' + (title ? center(title, inner) : '─'.repeat(inner)) + '╮'
  const mid = padded.map((r) => '│' + r + ' '.repeat(Math.max(0, inner - dw(r))) + '│')

  return [top, ...mid, '╰' + '─'.repeat(inner) + '╯']
}

// ── 主题 ──
const THEME = {
  color: {
    text: 'white',
    muted: 'gray',
    border: 'gray',
    label: 'gold',
    statusGood: 'green',
    statusWarn: 'yellow',
    statusBad: 'orange',
    statusCritical: 'red',
    error: 'red'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --no-limits：模拟额度表抓取失败（验证内置兜底表与「额度表离线」标记）
if (process.argv.includes('--no-limits')) {
  const real = globalThis.fetch

  globalThis.fetch = (url, opts) =>
    String(url).endsWith('/go') ? Promise.resolve(new Response('', { status: 503 })) : real(url, opts)
}

const mod = await import(file)
mod.default(sdk)

if (!captured) {
  console.error('FAIL: openWidget 未被调用')
  process.exit(1)
}

// 可选：--model=<id> 预览手动锁定某个模型的额度
const arg = process.argv.find((a) => a.startsWith('--model=')) || ''
const state = typeof captured.init === 'function' ? captured.init(arg.replace('--model=', 'model=')) : undefined

const draw = () => {
  idx = 0

  return lines(captured.render({ state, t: THEME }))
}

let out = draw()

console.log('--- 首帧（骨架/错误） ---')
console.log(out.join('\n'))

effs.forEach((fn) => fn())
effs = []

for (let i = 0; i < 40; i++) {
  await sleep(250)
  out = draw()

  if (out.some((r) => /\$|额度读取失败|不可用/.test(r))) break
}

console.log('\n--- 数据帧 ---')
console.log(out.join('\n'))

const inner = out.slice(1, -1).map((r) => dw(r) - 2)
const cardW = dw(out[0])
console.log('\n行数:', out.length, '│ 卡片宽:', cardW, '│ 内宽各:', inner.join(','))
console.log(inner.every((w) => w === cardW - 2) ? 'WIDTH OK' : 'WIDTH MISMATCH')
process.exit(0)
