window.__ModuleLoader__.load({
  id: 'dsh-plugin-quota-watch',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const OVERVIEW_URL = '/api/quota-watch/overview'
    const REFRESH_URL = '/api/quota-watch/refresh'
    const POLL_MS = 45000

    /* ---------- formatting ---------- */
    function fmtCountdown(sec) {
      if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—'
      const d = Math.floor(sec / 86400)
      const hh = Math.floor((sec % 86400) / 3600)
      const mm = Math.floor((sec % 3600) / 60)
      if (d > 0) return `${d}天${hh}时`
      if (hh > 0) return `${hh}时${mm}分`
      return `${mm}分`
    }
    function fmtRemain(pct) {
      if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—'
      const remain = 100 - pct
      return `${remain.toFixed(1).replace(/\.0$/, '')}%`
    }
    function fmtMoney(n) {
      return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—'
    }
    function fmtTime(epochSeconds) {
      if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '—'
      const d = new Date(epochSeconds * 1000)
      const p = (x) => String(x).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function fmtClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const d = new Date(ms)
      const p = (x) => String(x).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    const COLORS = { green: '#2ea043', amber: '#d97706', red: '#e5484d', gray: '#7a828c' }

    const CSS = `
.qw-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; border:0; border-radius:999px; padding:1px 10px; margin:0; background:transparent; font-family:inherit; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary,#8b949e); cursor:pointer; white-space:nowrap; }
.qw-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)); }
.qw-chip:disabled { cursor:default; }
.qw-dot { width:7px; height:7px; border-radius:50%; flex:none; }
.qw-num { color:var(--dsw-alias-label-primary,#d7dde4); font-variant-numeric:tabular-nums; }
.qw-sub { color:var(--dsw-alias-label-tertiary,#8b949e); font-variant-numeric:tabular-nums; }
.qw-age { opacity:.55; font-variant-numeric:tabular-nums; }
.qw-pop { position:fixed; z-index:9999; width:340px; max-width:calc(100vw - 24px); max-height:min(60vh, 480px); overflow:auto; box-sizing:border-box; background:var(--dsw-alias-bg-layer-2,#1f242b); border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12)); border-radius:10px; padding:10px 12px; box-shadow:0 10px 28px rgba(0,0,0,.35); font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary,#9aa3ad); }
.qw-pop-title { font-weight:600; color:var(--dsw-alias-label-primary,#e6edf3); margin-bottom:4px; }
.qw-pop-sec { margin-top:8px; }
.qw-pop-sec-title { color:var(--dsw-alias-label-primary,#d7dde4); font-weight:600; }
.qw-pop-row { display:flex; justify-content:space-between; gap:12px; }
.qw-pop-row > span:last-child { color:var(--dsw-alias-label-primary,#d7dde4); font-variant-numeric:tabular-nums; text-align:right; }
.qw-pop-foot { margin-top:8px; padding-top:6px; border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08)); color:var(--dsw-alias-label-tertiary,#8b949e); font-size:11px; }
`

    function QuotaWatch() {
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState(false)
      const [hover, setHover] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const retryAfter = useRef(0)
      const chipRef = useRef(null)
      const closeTimer = useRef(0)

      const openHover = () => {
        clearTimeout(closeTimer.current)
        const el = chipRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          setAnchor({ left: rect.left, top: rect.top })
        }
        setHover(true)
      }
      const scheduleClose = () => {
        clearTimeout(closeTimer.current)
        closeTimer.current = setTimeout(() => setHover(false), 250)
      }
      const cancelClose = () => clearTimeout(closeTimer.current)

      const load = async (manual) => {
        if (manual) setBusy(true)
        try {
          const res = await fetch(manual ? REFRESH_URL : OVERVIEW_URL,
            manual ? { method: 'POST', cache: 'no-store' } : { cache: 'no-store' })
          const data = await res.json()
          setView(data && typeof data === 'object' ? data : { ok: false, error: '响应异常', now: Date.now() })
          const codexBad = !data || data.ok === false || (data.codex && (data.codex.ok === false || data.codex.stale))
          const dsBad = !data || data.ok === false || (data.deepseek && (data.deepseek.ok === false || data.deepseek.stale))
          // 任一路失败时自动补一次强制刷新（限频 30 秒），不用等下一次轮询或手动点击
          if (!manual && (codexBad || dsBad) && Date.now() > retryAfter.current) {
            retryAfter.current = Date.now() + 30000
            setTimeout(() => { load(true) }, 4000)
          }
        } catch {
          setView((prev) => (prev ? { ...prev, now: Date.now() } : { ok: false, error: '无法连接本地额度服务', now: Date.now() }))
        } finally {
          if (manual) setBusy(false)
        }
      }

      useEffect(() => {
        load(false)
        const timer = setInterval(() => load(false), POLL_MS)
        const onVisible = () => { if (document.visibilityState === 'visible') load(false) }
        const onFocus = () => load(false)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          clearTimeout(closeTimer.current)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', onFocus)
        }
      }, [])

      const codex = view ? view.codex : null
      const deepseek = view ? view.deepseek : null

      /* ---- Codex ---- */
      let cxDot = COLORS.gray
      let cxSeg = '获取中…'
      let cxTooltip = 'Codex 额度：正在获取…'
      if (codex && codex.ok) {
        const w = codex.window
        const k = codex.week
        const wPct = w && typeof w.usedPercent === 'number' ? w.usedPercent : null
        const kPct = k && typeof k.usedPercent === 'number' ? k.usedPercent : null
        const stopped = Boolean(codex.limitReached) || (wPct !== null && wPct >= 97) || (kPct !== null && kPct >= 98)
        const caution = (wPct !== null && wPct >= 85) || (kPct !== null && kPct >= 90)
        cxDot = stopped ? COLORS.red : caution ? COLORS.amber : COLORS.green
        cxSeg = `5h 剩 ${fmtRemain(wPct)} · 周剩 ${fmtRemain(kPct)}`
        const verdict = stopped ? '已到自动停止线' : caution ? '接近警告线' : '额度充足'
        cxTooltip = `Codex 额度（${verdict}）\n5 小时窗口：已用 ${wPct === null ? '—' : wPct}%，重置 ${fmtCountdown(w && w.resetAfterSeconds)} 后（${fmtTime(w && w.resetAt)}）\n周窗口：已用 ${kPct === null ? '—' : kPct}%，重置 ${fmtCountdown(k && k.resetAfterSeconds)} 后（${fmtTime(k && k.resetAt)}）`
        if (codex.stale) {
          cxDot = COLORS.amber
          cxTooltip += `\n⚠️ 最近一次刷新失败：${codex.error || '未知错误'}。显示的是 ${fmtTime(codex.updatedAt / 1000)} 的数据，稍后自动重试。`
        }
      } else if (codex) {
        cxDot = COLORS.red
        cxSeg = codex.error || '获取失败'
        cxTooltip = `Codex 额度获取失败：${codex.error || '未知错误'}`
      }

      /* ---- DeepSeek ---- */
      let dsDot = COLORS.gray
      let dsSeg = '获取中…'
      let dsSub = null
      let dsTooltip = 'DeepSeek API 余额：正在获取…'
      if (deepseek && deepseek.ok) {
        const total = deepseek.totalBalance
        const symbol = deepseek.currency === 'USD' ? '$' : '¥'
        dsDot = total !== null && total > 0 ? COLORS.green : COLORS.amber
        dsSeg = `${symbol}${fmtMoney(total)}`
        const spendToday = typeof deepseek.spendToday === 'number' && Number.isFinite(deepseek.spendToday) ? deepseek.spendToday : null
        dsSub = spendToday !== null ? `今日 ${fmtMoney(spendToday)}` : null
        dsTooltip = `DeepSeek API 余额\n总额：${symbol}${fmtMoney(total)}（充值 ${symbol}${fmtMoney(deepseek.toppedUpBalance)} · 赠送 ${symbol}${fmtMoney(deepseek.grantedBalance)}）${spendToday !== null ? `\n今日已花：${symbol}${fmtMoney(spendToday)}（本机观测累计：今天首次观测余额为基线，充值后自动重算基线）` : ''}${deepseek.isAvailable ? '' : '\n⚠️ 官方标记余额不可用（is_available=false）'}`
        if (deepseek.stale) {
          dsDot = COLORS.amber
          dsTooltip += `\n⚠️ 最近一次刷新失败：${deepseek.error || '未知错误'}。显示的是 ${fmtTime(deepseek.updatedAt / 1000)} 的数据，稍后自动重试。`
        }
      } else if (deepseek) {
        dsDot = COLORS.red
        dsSeg = deepseek.error || '获取失败'
        dsTooltip = `DeepSeek 余额获取失败：${deepseek.error || '未知错误'}`
      }

      /* ---- data age ---- */
      const newest = Math.max(
        (codex && typeof codex.updatedAt === 'number' ? codex.updatedAt : 0),
        (deepseek && typeof deepseek.updatedAt === 'number' ? deepseek.updatedAt : 0),
      )
      let ageText = ''
      if (newest > 0) {
        const ageSec = Math.max(0, Math.round((Date.now() - newest) / 1000))
        ageText = ageSec < 60 ? '刚刚' : `${Math.floor(ageSec / 60)}分钟前`
      }

      /* ---- 悬停详情卡 ---- */
      const sym = deepseek && deepseek.ok && deepseek.currency === 'USD' ? '$' : '¥'
      const popSections = []
      if (codex && codex.ok) {
        const w = codex.window
        const k = codex.week
        const wPct = w && typeof w.usedPercent === 'number' ? w.usedPercent : null
        const kPct = k && typeof k.usedPercent === 'number' ? k.usedPercent : null
        popSections.push(h('div', { className: 'qw-pop-sec' },
          h('div', { className: 'qw-pop-sec-title' }, 'Codex 额度'),
          h('div', { className: 'qw-pop-row' }, h('span', null, '5 小时窗口'), h('span', null, `已用 ${wPct === null ? '—' : wPct}% · 剩 ${fmtRemain(wPct)}`)),
          h('div', { className: 'qw-pop-row' }, h('span', null, '重置时间'), h('span', null, `${fmtTime(w && w.resetAt)}（${fmtCountdown(w && w.resetAfterSeconds)}后）`)),
          h('div', { className: 'qw-pop-row' }, h('span', null, '周窗口'), h('span', null, `已用 ${kPct === null ? '—' : kPct}% · 剩 ${fmtRemain(kPct)}`)),
          h('div', { className: 'qw-pop-row' }, h('span', null, '重置时间'), h('span', null, `${fmtTime(k && k.resetAt)}（${fmtCountdown(k && k.resetAfterSeconds)}后）`)),
        ))
      } else if (codex) {
        popSections.push(h('div', { className: 'qw-pop-sec' },
          h('div', { className: 'qw-pop-sec-title' }, 'Codex 额度'),
          h('div', { className: 'qw-pop-row' }, h('span', null, codex.error || '获取失败'))))
      }
      if (deepseek && deepseek.ok) {
        const spendToday = typeof deepseek.spendToday === 'number' ? deepseek.spendToday : null
        popSections.push(h('div', { className: 'qw-pop-sec' },
          h('div', { className: 'qw-pop-sec-title' }, 'DeepSeek API 余额'),
          h('div', { className: 'qw-pop-row' }, h('span', null, '总额'), h('span', null, `${sym}${fmtMoney(deepseek.totalBalance)}`)),
          h('div', { className: 'qw-pop-row' }, h('span', null, '充值 / 赠送'), h('span', null, `${sym}${fmtMoney(deepseek.toppedUpBalance)} / ${sym}${fmtMoney(deepseek.grantedBalance)}`)),
          spendToday !== null ? h('div', { className: 'qw-pop-row' }, h('span', null, '今日已花'), h('span', null, `${sym}${fmtMoney(spendToday)}（本机观测）`)) : null,
        ))
      } else if (deepseek) {
        popSections.push(h('div', { className: 'qw-pop-sec' },
          h('div', { className: 'qw-pop-sec-title' }, 'DeepSeek API 余额'),
          h('div', { className: 'qw-pop-row' }, h('span', null, deepseek.error || '获取失败'))))
      }
      const history = deepseek && deepseek.ok && Array.isArray(deepseek.spendDays) ? deepseek.spendDays : []
      if (history.length > 0) {
        popSections.push(h('div', { className: 'qw-pop-sec' },
          h('div', { className: 'qw-pop-sec-title' }, '近 7 日花费'),
          history.map((day) => h('div', { className: 'qw-pop-row', key: day.date },
            h('span', null, day.date),
            h('span', null, `${sym}${fmtMoney(day.spent)}`)))))
      }

      let popover = null
      if (hover && anchor && typeof document !== 'undefined') {
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
        const left = Math.max(12, Math.min(anchor.left, viewportWidth - 352))
        const above = anchor.top > 360
        const node = h('div', {
            className: 'qw-pop',
            style: {
              left,
              top: above ? anchor.top - 8 : anchor.top + 30,
              transform: above ? 'translateY(-100%)' : 'none',
            },
            onMouseEnter: cancelClose,
            onMouseLeave: scheduleClose,
          },
            h('div', { className: 'qw-pop-title' }, '额度详情'),
            popSections,
            h('div', { className: 'qw-pop-foot' }, `更新于 ${fmtClock(newest)} · 点击胶囊立即刷新`))
        popover = ReactDOM.createPortal(node, document.body)
      }

      return h('div', { className: 'qw-root' },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'qw-chip',
          ref: chipRef,
          disabled: busy,
          'aria-label': '额度看板：Codex 额度与 DeepSeek 余额，点击立即刷新',
          onMouseEnter: openHover,
          onMouseLeave: scheduleClose,
          onClick: () => { load(true); openHover() },
        },
          h('span', { className: 'qw-dot', style: { background: cxDot } }),
          h('span', null, 'Codex ', h('span', { className: 'qw-num' }, cxSeg)),
          h('span', { className: 'qw-dot', style: { background: dsDot } }),
          h('span', null, 'DeepSeek ', h('span', { className: 'qw-num' }, dsSeg)),
          dsSub ? h('span', { className: 'qw-sub' }, dsSub) : null,
          busy
            ? h('span', { className: 'qw-age' }, '· 刷新中…')
            : ageText ? h('span', { className: 'qw-age' }, `· ${ageText}`) : null,
        ),
        popover)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'quota-watch', order: 10,
        }, QuotaWatch))
      },
    }
  },
})
