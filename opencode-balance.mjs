/**
 * OpenCode 额度挂件 — Hermes TUI 常驻面板（ambient · 停靠在状态栏上方）
 *
 * v3 变更：Go 订阅已改为「按模型计量月度额度」（官网 2026-10 起，
 * 每个模型的月度额度不同，5h = 月限 20%、周 = 月限 50%、月 = 100%）。
 * console/api/go/status 里的 meters 美元仍是旧的 $60 账户池口径，
 * 直接显示会低估实际可用额度，所以：
 *   · 百分比一律以 zen/go/v1/usage（服务端权威）为准，不再由 meters 现算；
 *   · 美元剩余/上限按「当前模型月限」换算：月限来自 opencode.ai/go 表格
 *     （6h 缓存到 ~/.hermes/cache/ocbal-go-limits.json，抓不到用内置兜底表）。
 *
 * v2 视觉：圆角卡片 + 边框内嵌标题、细线进度条（━/┄ + 半步收尾）、
 * 分段配色（statusGood → statusWarn → statusBad → statusCritical）、
 * 会话内 5h 用量走势图（放在分隔线上）、右上角新鲜度指示灯。
 * 全部颜色取自 theme tone，随 /skin 与明暗主题自动适配。
 *
 * 数据源（OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY 的 Bearer key）:
 *   GET https://opencode.ai/console/api/billing/status  → Zen 预付钱包余额
 *   GET https://opencode.ai/console/api/go/status       → Go 订阅窗口起止（百分比备用）
 *   GET https://opencode.ai/zen/go/v1/usage             → 三窗口百分比（权威）
 *   GET https://opencode.ai/go                          → 各模型 Go/Plus 月度额度表
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
  const BAR_W = 11
  const REMAIN_W = 14
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

  /** 额度美元（已是美元单位）：$10 以上取整、小额两位 —— 最长 $0.00（5 列），配合 REMAIN_W=14 不溢出 */
  const money = (v) => {
    const n = Number(v)

    if (!Number.isFinite(n)) return '—'

    return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
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
    if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`

    return `${Math.floor(m / 1440)}天`
  }

  function ago(ts) {
    if (!ts) return ''

    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))

    if (s < 10) return '刚刚'
    if (s < 90) return `${s} 秒前`

    return `${Math.round(s / 60)} 分钟前`
  }

  // ── Go 模型额度表（按模型计量的月度美元额度） ─────────────────────
  const LIMIT_URL = 'https://opencode.ai/go'
  const LIMIT_TTL = 6 * 3600_000 // 抓一次管 6 小时
  const LIMIT_RETRY_MS = 10 * 60_000 // 抓失败 10 分钟后再试
  const LIMIT_FILE = 'ocbal-go-limits.json'
  const CAP_RATIO = { rolling: 0.2, weekly: 0.5, monthly: 1 }

  /** 2026-10-31 官网 Go 档兜底值 —— 抓页面失败且无缓存时用，键为规范化模型名 */
  const LIMIT_FALLBACK = {
    deepseekv41flash: 100,
    deepseekv4pro: 15,
    glm53flash: 60,
    glm53: 15,
    glm52: 60,
    kimik31pro: 15,
    kimik3: 15,
    kimik27code: 60,
    minimaxm3: 60,
    minimaxm31flash: 20,
    qwen38max: 15,
    qwen38flash: 30,
    qwen37plus: 60,
    mimov26flash: 60,
    gpt6luna: 15,
    claudehaiku55: 15,
    gemini4argon: 30,
    longcat20: 60
  }

  /** 规范化：'DeepSeek V4.1 Flash' 与 'deepseek-v4.1-flash' 落到同一个键 */
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  /**
   * 从 opencode.ai/go 的额度表解析 { 规范化模型名: {name, go, plus} }。
   * 每行有两个 data-slot="number" 单元格：第一个是估算请求数（无 $），
   * 第二个是月度额度（$100 / $200）。只认带 $ 的数字。
   */
  function parseGoLimits(html) {
    const out = {}
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
    let m

    while ((m = rowRe.exec(html))) {
      const row = m[1]
      const name = /<bdi>([^<]{1,60})<\/bdi>/.exec(row)

      if (!name) continue

      const nums = [...row.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]))

      if (!nums.length) continue // Unlimited / 免费行没有美元额度

      out[norm(name[1])] = { name: name[1].trim(), go: nums[0], plus: nums[1] }
    }

    return out
  }

  /**
   * 当前模型 → 月限（美元）：精确匹配表 → 兜底表 → 唯一包含匹配（防 glm53 误命中 glm53flash）。
   * 匹配不到就返回 null，由调用方回落到服务端池口径。
   */
  function capOf(limits, modelId) {
    const key = norm(modelId)

    if (!key) return null
    if (limits && limits[key] && limits[key].go) return limits[key].go
    if (LIMIT_FALLBACK[key]) return LIMIT_FALLBACK[key]

    const cands = Object.keys(limits || {}).filter((k) => k.includes(key) || key.includes(k))

    if (cands.length === 1 && key.length >= 8) return limits[cands[0]].go

    return null
  }

  /** node 环境才有 fs：拿 ~/.hermes 目录句柄 */
  async function nodeEnv() {
    if (typeof process === 'undefined' || !process.versions || !process.versions.node) return null

    try {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')

      return {
        fs,
        path,
        home: (process.env && process.env.HERMES_HOME) || path.join(os.homedir(), '.hermes')
      }
    } catch {
      return null
    }
  }

  let limitsMem = null

  async function getLimits() {
    if (limitsMem && Date.now() - limitsMem.at < (limitsMem.ok ? LIMIT_TTL : LIMIT_RETRY_MS)) {
      return limitsMem.data
    }

    const env = await nodeEnv()

    if (env) {
      try {
        const raw = JSON.parse(env.fs.readFileSync(env.path.join(env.home, 'cache', LIMIT_FILE), 'utf8'))

        if (raw && raw.at && raw.data && Date.now() - raw.at < LIMIT_TTL) {
          limitsMem = { at: raw.at, data: raw.data, ok: true }

          return raw.data
        }
      } catch {
        /* 没有缓存就现场抓 */
      }
    }

    try {
      const html = await getText(LIMIT_URL)
      const data = parseGoLimits(html)

      if (Object.keys(data).length >= 5) {
        limitsMem = { at: Date.now(), data, ok: true }

        if (env) {
          try {
            const dir = env.path.join(env.home, 'cache')

            env.fs.mkdirSync(dir, { recursive: true })
            env.fs.writeFileSync(env.path.join(dir, LIMIT_FILE), JSON.stringify({ at: Date.now(), data }))
          } catch {
            /* 只读环境也能跑 */
          }
        }

        return data
      }
    } catch {
      /* 抓不到 → 退回兜底表 */
    }

    limitsMem = { at: Date.now(), data: limitsMem ? limitsMem.data : {}, ok: false }

    return limitsMem.data
  }

  let modelMem = null

  /**
   * 当前会话模型：TUI 里 `/model` 切换是会话级的，只写 state.db、不碰 config.yaml，
   * 也不写 process env（tui_gateway/model_switch.py 里明确不写 HERMES_MODEL）。
   * 所以顺序是：env 覆盖 → state.db 最近活跃会话 → config.yaml 的 model 段。
   */
  async function liveSessionModel(env) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(env.path.join(env.home, 'state.db'), { readOnly: true })

      try {
        const row = db
          .prepare(
            'select model, billing_provider from sessions where ended_at is null and model is not null order by last_activity_at desc limit 1'
          )
          .get()

        if (!row || !row.model) return null

        return { model: String(row.model), provider: String(row.billing_provider || '') }
      } finally {
        db.close()
      }
    } catch {
      return null // node < 22 / 非 node 运行时 / 库被锁：交给 config.yaml
    }
  }

  async function readModel() {
    if (modelMem && Date.now() - modelMem.at < REFRESH_MS) return modelMem

    const env = typeof process !== 'undefined' && process.env ? process.env : {}
    let model = String(env.HERMES_INFERENCE_MODEL || env.HERMES_MODEL || '').trim()
    let provider = ''

    const io = await nodeEnv()

    if (io && !model) {
      const live = await liveSessionModel(io)

      if (live) {
        model = live.model
        provider = live.provider
      }
    }

    if (io && !model) {
      try {
        const raw = io.fs.readFileSync(io.path.join(io.home, 'config.yaml'), 'utf8')
        const block = /^model:[ \t]*\n((?:[ \t]+\S.*\n?)+)/m.exec(raw)

        if (block) {
          const d = /^[ \t]+default:[ \t]*['"]?([^'"\n#]+)['"]?/m.exec(block[1])

          if (d) model = d[1].trim()

          const p = /^[ \t]+provider:[ \t]*['"]?([^'"\n#]+)['"]?/m.exec(block[1])

          if (p) provider = p[1].trim()
        }
      } catch {
        /* 读不到就当未知模型：回落到服务端池口径 */
      }
    }

    modelMem = { at: Date.now(), model, provider }

    return modelMem
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

  /** 一行一个窗口：标签 · 进度条 · 百分比 · 剩余/上限 · 重置倒计时 */
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
        h(Text, null, ' '),
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
  function Card({ border, children, t, title = TITLE }) {
    return h(
      Box,
      {
        borderColor: border,
        borderStyle: 'round',
        borderText: { align: 'center', content: title, position: 'top' },
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
          const [go, zen, usage, limits, mine] = await Promise.all([
            getJson('https://opencode.ai/console/api/go/status', authKey).catch(() => null),
            getJson('https://opencode.ai/console/api/billing/status', zenKey || authKey).catch(() => null),
            getJson('https://opencode.ai/zen/go/v1/usage', authKey).catch(() => null),
            getLimits(),
            readModel()
          ])

          if (!alive) return

          // 额度接口全挂才算“读不到”——只挂一个仍按有数据渲染。
          if (go || usage || zen) {
            setSnap({ at: Date.now(), go, limits, mine, usage, zen })
            setErr(null)

            const pct = usage && usage.usage && usage.usage.rolling ? Number(usage.usage.rolling.percent) : null

            if (Number.isFinite(pct)) setHist((prev) => [...prev, pct].slice(-HIST_MAX))
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

    const { go, limits, mine, usage, zen, at } = snap
    const meters = go && go.access && go.access.meters ? go.access.meters : null
    const u = usage && usage.usage ? usage.usage : null

    // Go 现在是「按模型计量」：provider 是 opencode-go 时用当前模型的月限换算美元
    const onGo = !mine.provider || mine.provider.startsWith('opencode-go')
    const modelCap = onGo && mine.model ? capOf(limits, mine.model) : null
    const rows = []

    for (const [label, id, m, fb] of [
      ['5h', 'rolling', meters && meters.fiveHour, u && u.rolling],
      ['周', 'weekly', meters && meters.week, u && u.weekly],
      ['月', 'monthly', meters && meters.month, u && u.monthly]
    ]) {
      if (!m && !fb) continue

      // 百分比以 usage 接口为准：它才是服务端按当前额度算出的真实占用
      const pct = fb ? Number(fb.percent) || 0 : pctOf(m.usedMicroCents, m.limitMicroCents)
      const cap = modelCap ? modelCap * (CAP_RATIO[id] || 1) : null
      const reset = eta((m && m.resetsAt) || (fb && fb.resetsAt))
      const idle = id === 'rolling' && m && !m.startsAt && !Number(m.usedMicroCents)
      let remain

      if (idle) {
        remain = '空闲'
      } else if (cap) {
        remain = `剩 ${money(cap * (1 - pct / 100))}/${money(cap)}`
      } else if (m) {
        const left = Number(m.limitMicroCents) - Number(m.usedMicroCents)

        remain = Number.isFinite(left) && Number(m.limitMicroCents) > 0 ? `剩 ${usdShort(left)}` : '—'
      } else {
        remain = '剩 —'
      }

      rows.push(h(Meter, { key: id, label, pct, remain, reset: reset ? `${reset} 后` : '', t }))
    }

    if (!rows.length) {
      rows.push(h(Text, { key: 'na', color: t.color.muted }, 'Go 订阅额度不可用（非订阅账号或接口异常）'))
    }

    const stale = Boolean(err)
    const dotColor = stale ? t.color.error : Date.now() - at > 180_000 ? t.color.statusWarn : t.color.statusGood

    // 标题带模型名：额度是按「这个模型的月限」换算的，必须让用户看见是哪个模型
    const title = modelCap ? ` ⚡ Go · ${clip(mine.model, 30)} ` : TITLE
    const mode = stale
      ? `上次成功 ${ago(at)}`
      : zen
        ? zen.billingMode === 'prepaid'
          ? '预付 · <$5 自动充 $20'
          : '按量计费'
        : ''

    return h(
      Card,
      { border: t.color.border, t, title },
      rows[0],
      rows[1] || null,
      rows[2] || null,
      h(Divider, { series: hist, t }),
      h(Wallet, {
        bal: zen && zen.balanceMicroCents != null ? zen.balanceMicroCents : null,
        dotColor,
        dotText: stale ? '读取失败' : ago(at),
        mode,
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

  async function getText(url) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        headers: {
          accept: 'text/html',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) opencode-balance-widget/3.0'
        },
        signal: ctl.signal
      })

      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/^https:\/\//, '')}`)

      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  const app = defineWidgetApp({
    help: 'OpenCode Go 额度（按模型月限换算）+ Zen 钱包余额（60s 自动刷新）',
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
