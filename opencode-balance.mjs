/**
 * OpenCode 额度挂件 — Hermes TUI 常驻面板（ambient · 停靠在状态栏上方）
 *
 * v2 视觉：圆角卡片 + 边框内嵌标题、细线进度条（━/┄ + 半步收尾）、
 * 分段配色（statusGood → statusWarn → statusBad → statusCritical）、
 * 会话内 5h 用量走势图（放在分隔线上）、右上角新鲜度指示灯。
 * 全部颜色取自 theme tone，随 /skin 与明暗主题自动适配。
 *
 * 数据源（OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY 的 Bearer key）:
 *   GET https://opencode.ai/console/api/billing/status  → Zen 预付钱包余额
 *   GET https://opencode.ai/console/api/go/status       → Go 订阅 5h / 周 / 月 三窗口
 *   GET https://opencode.ai/zen/go/v1/usage             → 备用：三窗口百分比
 *
 * 安装: 保存为 ~/.hermes/tui-widgets/opencode-balance.mjs → /widgets-reload
 * 开关: /ocbal （同一命令再按一次收起）
 */

export default function register(sdk) {
  const { Box, React, ShimmerRows, Text, defineWidgetApp, h, sparkline } = sdk

  const REFRESH_MS = 60_000
  const TICK_MS = 15_000
  const TIMEOUT_MS = 10_000
  const HIST_MAX = 40

  const WIDTH = 52 // 卡片总宽（含边框与内边距）
  const INNER = WIDTH - 6 // 可用内容宽 = 宽度 - 边框(1+1) - paddingX(2+2)
  const BAR_W = 13
  const REMAIN_W = 10
  const ETA_W = 8
  const TITLE = ' ⚡ OpenCode 额度 '

  // ── 文本工具：单元格宽度（CJK/emoji 记 2 列，与 TUI 的测量一致） ──
  const wide = (cp) =>
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2e80 && cp <= 0x9fff)

  const dwidth = (s) => {
    let n = 0

    for (const ch of String(s)) n += wide(ch.codePointAt(0)) ? 2 : 1

    return n
  }

  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dwidth(s)))
  const lpad = (s, n) => ' '.repeat(Math.max(0, n - dwidth(s))) + String(s)

  const clip = (s, n) => {
    let out = ''
    let w = 0

    for (const ch of String(s)) {
      const cw = wide(ch.codePointAt(0)) ? 2 : 1

      if (w + cw > n) break

      out += ch
      w += cw
    }

    return out
  }

  /** 先裁到 n 列再补空格 —— 任何动态字符串都不能把行撑宽（行宽恒定是硬约束）。 */
  const fit = (s, n) => pad(clip(s, n), n)

  // ── 数值格式 ────────────────────────────────────────────────────
  const usd = (microCents) => {
    const n = Number(microCents)

    return Number.isFinite(n) ? `$${(n / 1e8).toFixed(2)}` : '—'
  }

  /** 大额省略小数：$2.85 / $320 */
  const usdShort = (microCents) => {
    const n = Number(microCents)

    if (!Number.isFinite(n)) return '—'

    const v = n / 1e8

    return `$${Math.abs(v) < 100 ? v.toFixed(2) : Math.round(v)}`
  }

  const pctOf = (used, limit) => {
    const u = Number(used)
    const l = Number(limit)

    return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? Math.min(100, Math.round((u / l) * 100)) : 0
  }

  /** 紧凑倒计时：2h14m / 3天 / 即将重置 */
  function eta(iso) {
    if (!iso) return ''

    const ms = new Date(iso).getTime() - Date.now()

    if (!Number.isFinite(ms)) return ''
    if (ms <= 0) return '即将重置'

    const m = Math.floor(ms / 60_000)

    if (m < 1) return '<1m'
    if (m < 60) return `${m}m`
    if (m < 1440) return `${Math.floor(m / 60)}h${lpad(m % 60, 2)}m`

    return `${Math.floor(m / 1440)}天`
  }

  function ago(ts) {
    if (!ts) return ''

    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))

    if (s < 10) return '刚刚'
    if (s < 90) return `${s} 秒前`

    return `${Math.round(s / 60)} 分钟前`
  }

  // ── 组件 ────────────────────────────────────────────────────────
  /** 用量占比 → 主题状态色（用得多 = 更紧张） */
  const tone = (t, pct) =>
    pct >= 95
      ? t.color.statusCritical
      : pct >= 80
        ? t.color.statusBad
        : pct >= 50
          ? t.color.statusWarn
          : t.color.statusGood

  /** 细线进度条：实心 ━ + 半步收尾 ╸ + 虚轨 ┄，总宽恒定。 */
  function Bar({ pct, t }) {
    const exact = (Math.min(100, Math.max(0, pct)) / 100) * BAR_W
    const full = Math.floor(exact)
    const frac = exact - full
    const tip = frac >= 0.34 ? '╸' : ''
    const used = full + (tip ? 1 : 0)
    const c = tone(t, pct)

    return h(
      Box,
      { flexDirection: 'row' },
      full > 0 ? h(Text, { color: c }, '━'.repeat(full)) : null,
      tip ? h(Text, { color: c }, tip) : null,
      h(Text, { color: t.color.muted, dimColor: true }, '┄'.repeat(Math.max(0, BAR_W - used)))
    )
  }

  /** 一行一个窗口：标签 · 进度条 · 百分比 · 剩余额度 · 重置倒计时 */
  function Meter({ label, pct, remain, reset, t }) {
    return h(
      Box,
      { flexDirection: 'row' },
      h(Text, { color: t.color.muted }, fit(label, 3)),
      h(Text, null, ' '),
      h(Bar, { pct, t }),
      h(Text, null, '  '),
      h(Text, { bold: true, color: tone(t, pct) }, lpad(`${pct}%`, 4)),
      h(Text, null, '  '),
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { color: t.color.text }, fit(remain, REMAIN_W)),
        h(Text, { color: t.color.border, dimColor: true }, ' · '),
        h(Text, { color: t.color.muted }, lpad(clip(reset, ETA_W), ETA_W))
      )
    )
  }

  /** 分隔线：有足够样本时嵌一条金色走势（会话内 5h 用量）。 */
  function Divider({ series, t }) {
    const side = 6
    const cells = INNER - side - 8
    const dash = (n) => h(Text, { color: t.color.border, dimColor: true }, '┄'.repeat(n))

    if (series.length < 4) {
      return h(Box, { flexDirection: 'row' }, dash(INNER))
    }

    return h(
      Box,
      { flexDirection: 'row' },
      dash(side),
      h(Text, { color: t.color.label }, sparkline(series, cells)),
      h(Text, { color: t.color.muted, dimColor: true }, lpad('5h', 8))
    )
  }

  /** 底部：钱包余额 + 计费方式 | 数据新鲜度指示灯（宽度自适应，绝不撑破行） */
  function Wallet({ bal, mode, modeColor, dotColor, dotText, t }) {
    const amount = bal == null ? '—' : usd(bal)
    const amountW = dwidth(amount)
    const balColor =
      bal == null ? t.color.muted : Number(bal) / 1e8 <= 5 ? t.color.statusBad : t.color.text
    // 右侧预留 10 列给“● 读取失败”，其余留给计费说明/上次成功时间
    const maxModeW = Math.max(0, INNER - 5 - amountW - 3 - 10)
    const modeText = mode ? clip(mode, maxModeW) : ''
    const rightW = Math.max(4, INNER - 5 - amountW - (modeText ? 3 + dwidth(modeText) : 0) - 1)
    const dot = clip(dotText, Math.max(2, rightW - 2))
    const modeProps = modeColor ? { color: modeColor } : { color: t.color.border, dimColor: true }

    return h(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between', width: INNER },
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { color: t.color.muted }, '余额 '),
        h(Text, { bold: true, color: balColor }, amount),
        modeText ? h(Text, modeProps, ` · ${modeText}`) : null
      ),
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { color: dotColor }, '● '),
        h(Text, { color: t.color.muted }, dot)
      )
    )
  }

  /** 圆角卡片：标题嵌在顶边上，边框色随状态变化。 */
  function Card({ border, children, t }) {
    return h(
      Box,
      {
        borderColor: border,
        borderStyle: 'round',
        borderText: { align: 'center', content: TITLE, position: 'top' },
        flexDirection: 'column',
        opaque: true,
        paddingX: 2,
        width: WIDTH
      },
      children
    )
  }

  // ── 主面板 ──────────────────────────────────────────────────────
  function Panel({ t }) {
    const [snap, setSnap] = React.useState(null)
    const [hist, setHist] = React.useState([])
    const [err, setErr] = React.useState(null)
    const [, forceTick] = React.useState(0)

    React.useEffect(() => {
      let alive = true

      const load = async () => {
        try {
          const { zenKey, goKey } = await readKeys()

          if (!zenKey && !goKey) throw new Error('未找到 OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY')

          const authKey = goKey || zenKey
          const [go, zen] = await Promise.all([
            getJson('https://opencode.ai/console/api/go/status', authKey).catch(() => null),
            getJson('https://opencode.ai/console/api/billing/status', zenKey || authKey).catch(() => null)
          ])

          let usage = null

          if (!go) usage = await getJson('https://opencode.ai/zen/go/v1/usage', authKey).catch(() => null)

          if (!alive) return

          // 两个接口全挂才算“读不到”——只挂一个仍按有数据渲染。
          if (go || usage || zen) {
            setSnap({ at: Date.now(), go, usage, zen })
            setErr(null)

            const meters = go && go.access && go.access.meters ? go.access.meters : null
            const rolling = meters && meters.fiveHour

            if (rolling) {
              const pct = pctOf(rolling.usedMicroCents, rolling.limitMicroCents)

              setHist((prev) => [...prev, pct].slice(-HIST_MAX))
            }
          } else {
            setErr('OpenCode 接口无响应')
          }
        } catch (e) {
          if (alive) setErr(String(e && e.message ? e.message : e))
        }
      }

      load()
      const poll = setInterval(load, REFRESH_MS)
      const tick = setInterval(() => forceTick((x) => x + 1), TICK_MS)

      return () => {
        alive = false
        clearInterval(poll)
        clearInterval(tick)
      }
    }, [])

    // ── 读取中 ──
    if (!snap && !err) {
      return h(
        Card,
        { border: t.color.border, t },
        h(ShimmerRows, {
          // 骨架行必须 ≤ INNER，否则会换行把卡片撑高（[label, value] 数值 + 1 空格）
          rows: [
            [3, BAR_W + 4],
            [3, BAR_W + 4],
            [3, BAR_W + 4],
            [INNER - 1, 0],
            [4, INNER - 6]
          ],
          t
        })
      )
    }

    // ── 首次即失败 ──
    if (!snap && err) {
      return h(
        Card,
        { border: t.color.statusCritical, t },
        h(Text, { color: t.color.error }, '额度读取失败'),
        h(Text, { color: t.color.muted }, clip(err, INNER)),
        h(Text, { color: t.color.border, dimColor: true }, '检查 ~/.hermes/.env 的 OPENCODE_*_API_KEY')
      )
    }

    const { go, usage, zen, at } = snap
    const meters = go && go.access && go.access.meters ? go.access.meters : null
    const u = usage && usage.usage ? usage.usage : null
    const rows = []

    for (const [label, id, m, fallback] of [
      ['5h', 'rolling', meters && meters.fiveHour, u && u.rolling],
      ['周', 'weekly', meters && meters.week, u && u.weekly],
      ['月', 'monthly', meters && meters.month, u && u.monthly]
    ]) {
      if (m) {
        const pct = pctOf(m.usedMicroCents, m.limitMicroCents) || (fallback ? Number(fallback.percent) || 0 : 0)
        const left = Number(m.limitMicroCents) - Number(m.usedMicroCents)
        const idle = id === 'rolling' && !m.startsAt && !m.usedMicroCents
        const remain = idle ? '空闲' : Number.isFinite(left) && Number(m.limitMicroCents) > 0 ? `剩 ${usdShort(left)}` : '—'
        const reset = eta(m.resetsAt)

        rows.push(h(Meter, { key: id, label, pct, remain, reset: reset ? `${reset} 后` : '', t }))
      } else if (fallback) {
        const reset = eta(fallback.resetsAt)

        rows.push(
          h(Meter, {
            key: id,
            label,
            pct: Number(fallback.percent) || 0,
            remain: '—',
            reset: reset ? `${reset} 后` : '',
            t
          })
        )
      }
    }

    if (!rows.length) {
      rows.push(h(Text, { key: 'na', color: t.color.muted }, 'Go 订阅额度不可用（非订阅账号或接口异常）'))
    }

    const stale = Boolean(err)
    const dotColor = stale ? t.color.error : Date.now() - at > 180_000 ? t.color.statusWarn : t.color.statusGood

    return h(
      Card,
      { border: t.color.border, t },
      rows[0],
      rows[1] || null,
      rows[2] || null,
      h(Divider, { series: hist, t }),
      h(Wallet, {
        bal: zen && zen.balanceMicroCents != null ? zen.balanceMicroCents : null,
        dotColor,
        dotText: stale ? '读取失败' : ago(at),
        mode: stale
          ? `上次成功 ${ago(at)}`
          : zen
            ? zen.billingMode === 'prepaid'
              ? '预付 · <$5 自动充 $20'
              : '按量计费'
            : '',
        modeColor: stale ? t.color.statusWarn : undefined,
        t
      })
    )
  }

  // ── 凭据：环境变量优先，回落 ~/.hermes/.env ─────────────────────
  let cachedKeys = null

  async function readKeys() {
    if (cachedKeys && Date.now() - cachedKeys.at < 5 * 60_000) return cachedKeys

    const env = typeof process !== 'undefined' && process.env ? process.env : {}
    let zenKey = env.OPENCODE_ZEN_API_KEY || ''
    let goKey = env.OPENCODE_GO_API_KEY || ''

    if ((!zenKey || !goKey) && typeof process !== 'undefined' && process.versions && process.versions.node) {
      try {
        const fs = await import('node:fs')
        const os = await import('node:os')
        const path = await import('node:path')
        const home = env.HERMES_HOME || path.join(os.homedir(), '.hermes')
        const raw = fs.readFileSync(path.join(home, '.env'), 'utf8')

        for (const line of raw.split('\n')) {
          const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)

          if (!m) continue

          const val = m[2].replace(/^['"]|['"]$/g, '').trim()

          if (!val) continue
          if (m[1] === 'OPENCODE_ZEN_API_KEY' && !zenKey) zenKey = val
          if (m[1] === 'OPENCODE_GO_API_KEY' && !goKey) goKey = val
        }
      } catch {
        /* .env 不可读就用环境变量 */
      }
    }

    cachedKeys = { at: Date.now(), goKey, zenKey }

    return cachedKeys
  }

  async function getJson(url, key) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: ctl.signal
      })

      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/^https:\/\//, '')}`)

      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  const app = defineWidgetApp({
    help: 'OpenCode Go 额度 + Zen 钱包余额（60s 自动刷新）',
    id: 'ocbal',
    mode: 'ambient',

    init() {
      return { ok: true }
    },

    reduce(state, { ch, key }) {
      return key.escape || ch === 'q' ? null : state
    },

    render({ t }) {
      return h(Panel, { t })
    }
  })

  // 常驻：TUI 启动即挂上（再次 /ocbal 可收起）
  sdk.openWidget(app, app.init(''))
}
