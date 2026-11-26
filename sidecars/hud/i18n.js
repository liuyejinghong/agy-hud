(() => {
  const STORAGE_KEY = 'agyHud.lang';

  const DICT = {
    zh: {
      // Header & tabs
      'tab.overview': '总览',
      'tab.trend': '趋势',
      'tab.usage': '用量',
      'tabs.aria': '视图切换',
      'lang.toggle': 'EN',
      'lang.toggleTitle': 'Switch to English',
      'version.title': '当前插件运行版本',
      'live.connecting': '连接中',
      'live.waiting': '等待中',
      'live.waitingTitle': '等待会话数据',
      'live.paused': '已暂停',
      'live.pausedTitle': '后台已暂停',
      'live.live': '实时同步中',
      'live.error': '异常',

      // Quota
      'quota.title': '配额',
      'quota.note': '5h / 周',
      'quota.modeAria': '配额展示方式',
      'quota.remaining': '剩余',
      'quota.used': '已用',
      'quota.refreshTitle': '手动刷新配额',
      'quota.loading': '读取中…',
      'quota.empty': '暂无配额数据',
      'quota.cardTitle': '点击切换 剩余 / 已用',
      'quota.win5h': '5h 窗口',
      'quota.winWeekly': '周限额',
      'quota.win5hShort': '5h',
      'quota.winWeeklyShort': '周',
      'quota.noData': '暂无数据',
      'quota.resetAt': '重置 {time}',
      'quota.usedPrefix': '已用 {pct}%',
      'quota.remPrefix': '剩余 {pct}%',

      // Speed
      'speed.title': '速度',
      'speed.titleTip': '按模型统计本会话纯生成速度（已扣 TTFT）',
      'speed.all': '全部',
      'speed.focusedOnly': '仅当前',
      'speed.scopeTip': '切换统计全部会话或仅当前选中的代理',
      'speed.colModel': '模型',
      'speed.empty': '暂无调用记录',
      'speed.activeBadge': '当前活跃',
      'speed.activeNow': '当前实时运行中',
      'speed.activeNowOne': '当前实时运行中：{agent}',
      'speed.activeNowMany': '当前实时运行中（{count} 个）：{agents}',
      'speed.lastTip': '上一轮：{tokens} tok · {sec}s{ttft}{agent}',
      'speed.lastNoTiming': '暂无耗时记录',
      'speed.avgTip': '近 {samples} 次加权均值，共 {total} 次（总输出 / 总生成时长）{avgTtft}',
      'speed.avgCallsOnly': '共 {total} 次调用',
      'speed.ttftPart': ' · 首字 {ttft}s',
      'speed.avgTtftPart': ' · 均首字 {ttft}s',
      'speed.variantsTip': '（含 {variants}）',
      'speed.agentsTip': ' · {count} 个代理（{agents}）',

      // Context & subagents
      'ctx.title': '上下文',
      'ctx.main': '主会话',
      'ctx.mainCardTitle': '点击返回主会话',
      'ctx.cacheFresh': '缓存 {cached} · 新增 {fresh}',
      'ctx.thinkShare': '思考占输出 {pct}%',
      'ctx.thinkEmpty': '思考占输出 —',
      'ctx.thinkTip': '最近一次回复中，内部思维链占总输出 token 的比例（其余 {restPct}% 为正文与工具调用）',
      'ctx.thinkEmptyTip': '暂无输出记录',
      'ctx.remaining': '剩 {val}',
      'ctx.unknown': '未知',
      'ctx.uncalled': '未调用',
      'ctx.compacting': '正在压缩上下文…',
      'ctx.compactingTip': '正在生成会话摘要并压缩历史消息，完成后上下文占用将自动回落',
      'ctx.compactedSplit': '已压缩 · 下轮精确同步',
      'ctx.compactedSplitPre': '已压缩（原 {pre}）· 下轮精确同步',
      'ctx.compactedTip': '已执行 /compact 压缩，当前按摘要输出估算（约 {used}），下一轮对话将同步精确上下文占用与缓存状态',
      'ctx.compactedCache': '已压缩 · 下轮重建缓存',
      'ctx.compactedCacheTip': '手动 /compact 已清空旧对话前缀，旧前缀缓存已失效，下一轮对话将重新构建新缓存',
      'ctx.runningCache': '运行中 · 缓存保鲜',
      'ctx.runningCacheTip': '主会话正在运行，每次模型调用都会滚动续期前缀缓存；本轮结束进入闲置后再开始倒计时。',
      'ctx.subActiveCache': '会话活跃中 · 暂停计时',
      'ctx.subActiveCacheTip': '当前有 {count} 个子代理正在运行，会话处于活跃期，暂停闲置倒计时；待全部任务结束进入闲置后再开始计时（注：子代理使用独立上下文，若主会话等待超过 5 分钟，汇总首轮缓存仍有可能重建）。',
      'ctx.cacheNone': '缓存 —',
      'ctx.cacheNoneTip': '暂无调用时间戳',
      'ctx.cacheHot': '缓存热 · ~{rem}',
      'ctx.cacheWarn': '缓存临界 · ~{rem}',
      'ctx.cacheExpired': '缓存可能已失效（闲置 {min}m）',
      'ctx.cacheColdCompact': '缓存已冷 · 建议 /compact',
      'ctx.cacheColdCompactTip': '当前上下文已达 {pct}% 且已闲置 {min}m（前缀缓存大概率已失效），此时执行 /compact 压缩最划算、不会浪费热缓存。',
      'ctx.cacheTip': '距上次调用已过 {elapsed}（5 分钟参考窗口）。Gemini 4 为后端隐式缓存，无固定官方 TTL，实测通常 3~5 分钟；Claude 标准缓存为 5 分钟。失效后再手动 /compact 不浪费热缓存。',
      'ctx.splitTip': '缓存 {cached} + 新增 {fresh} + 预估余量 {est} = {total}',
      'ctx.summaryActiveIdle': '{active} 活跃 · {idle} 已完成',
      'ctx.summaryActive': '{active} 子代理活跃',
      'ctx.summaryIdle': '{idle} 已完成',
      'ctx.activeSubs': '活跃子代理',
      'ctx.completedSubs': '已完成 {count} 个子代理',
      'ctx.viewing': '查看：',
      'ctx.subagentDefault': '子代理',
      'ctx.viewTrend': '看趋势 →',
      'ctx.backToMain': '返回主会话',
      'ctx.lastCallTip': '{display}（最近调用：{last}）',

      // Statuses
      'status.running': '运行中',
      'status.waiting': '等待中',
      'status.idle': '空闲',
      'status.killed': '已终止',

      // Breakdown groups
      'group.chatMessages': '对话记录',
      'group.tools': '工具定义',
      'group.systemPrompt': '系统提示',
      'group.rules': '规则',
      'group.subagents': '子代理声明',
      'group.skills': '技能目录',
      'group.plugins': '插件列表',
      'group.mcpTools': 'MCP 工具',

      // Trend
      'trend.curveTitle': '上下文曲线',
      'trend.curveAria': '上下文增长曲线',
      'trend.warnLine': '75% 警戒线',
      'trend.noHistory': '暂无调用历史',
      'trend.readoutEmpty': '—',
      'trend.readout': '#{step} · {model} · 上下文 {ctx} ({delta}) · 输出 {out} · {speed} · 首字 {ttft}',
      'trend.compactMarker': '/compact',
      'trend.breakdownTitle': '占用构成',
      'trend.breakdownTotal': '总计 {total}',
      'trend.colModel': '模型',
      'trend.colContext': '上下文',
      'trend.colTtft': '首字',
      'trend.colSpeed': '速度',
      'trend.noRows': '暂无调用明细',
      'trend.spikeTip': '单步突增 {delta}',
      'trend.rowTip': '#{step} {model} · 上下文 {ctx} ({delta}) · 输出 {out} tok · 首字 {ttft} · 速度 {speed}',

      // Usage
      'usage.title': '用量',
      'usage.scopeAria': '统计范围',
      'usage.modeAria': '用量单位',
      'usage.rangeAria': '统计周期',
      'usage.scopeSession': '本会话',
      'usage.scopeAll': '全部',
      'usage.modeUsd': 'USD',
      'usage.modeAll': '含缓存',
      'usage.modeNet': '净消耗',
      'usage.rangeToday': '今日',
      'usage.range7d': '7天',
      'usage.range30d': '30天',
      'usage.apiEquiv': 'API 等值',
      'usage.cacheHit': '缓存命中 {pct}%',
      'usage.input': '输入',
      'usage.cache': '缓存',
      'usage.output': '输出',
      'usage.noData': '暂无统计数据',
      'usage.noModels': '该周期暂无模型记录',
      'usage.readout': '{label} · {tok} · {usd}（入 {inp} / 缓 {cache} / 出 {out}）',
      'usage.sessionScopeNote': '当前会话（主会话 + {count} 子代理）',
      'usage.sessionScopeMainOnly': '当前会话（仅主会话）',
      'usage.sessionSplitMain': '主会话 {tok} · {usd}',
      'usage.sessionSplitSubs': '子代理 {tok} · {usd}',
      'usage.pricingFooter': '费率表更新于 {date} · 本地估算仅供参考',
      'usage.pricingFooterNoDate': '本地 API 费率估算仅供参考',
      'usage.noSessionData': '当前会话暂无调用费用数据',

      // Banners
      'banner.noConv': '未检测到 conversationId，请在会话右侧辅助栏中打开。',
      'banner.fetchErr': '读取监控数据失败：{err}',
      'banner.waiting': '等待会话数据…',
    },

    en: {
      // Header & tabs
      'tab.overview': 'Overview',
      'tab.trend': 'Trend',
      'tab.usage': 'Usage',
      'tabs.aria': 'View tabs',
      'lang.toggle': '中',
      'lang.toggleTitle': '切换为中文',
      'version.title': 'Plugin version',
      'live.connecting': 'Connecting',
      'live.waiting': 'Waiting',
      'live.waitingTitle': 'Waiting for session data',
      'live.paused': 'Paused',
      'live.pausedTitle': 'Paused in background',
      'live.live': 'Live',
      'live.error': 'Error',

      // Quota
      'quota.title': 'Quota',
      'quota.note': '5h / Weekly',
      'quota.modeAria': 'Quota display mode',
      'quota.remaining': 'Left',
      'quota.used': 'Used',
      'quota.refreshTitle': 'Refresh quota',
      'quota.loading': 'Loading…',
      'quota.empty': 'No quota data',
      'quota.cardTitle': 'Click to toggle Left / Used',
      'quota.win5h': '5h Window',
      'quota.winWeekly': 'Weekly',
      'quota.win5hShort': '5h',
      'quota.winWeeklyShort': 'Wk',
      'quota.noData': 'No data',
      'quota.resetAt': 'Resets {time}',
      'quota.usedPrefix': 'Used {pct}%',
      'quota.remPrefix': 'Left {pct}%',

      // Speed
      'speed.title': 'Speed',
      'speed.titleTip': 'Generation speed per model in this session (excl. TTFT)',
      'speed.all': 'All',
      'speed.focusedOnly': 'Focused',
      'speed.scopeTip': 'Toggle between all agents or focused agent only',
      'speed.colModel': 'Model',
      'speed.empty': 'No calls yet',
      'speed.activeBadge': 'Active',
      'speed.activeNow': 'Generating now',
      'speed.activeNowOne': 'Generating now: {agent}',
      'speed.activeNowMany': 'Generating now ({count}): {agents}',
      'speed.lastTip': 'Last: {tokens} tok · {sec}s{ttft}{agent}',
      'speed.lastNoTiming': 'No timing data',
      'speed.avgTip': 'Weighted avg of last {samples} calls ({total} total){avgTtft}',
      'speed.avgCallsOnly': '{total} calls total',
      'speed.ttftPart': ' · TTFT {ttft}s',
      'speed.avgTtftPart': ' · Avg TTFT {ttft}s',
      'speed.variantsTip': ' ({variants})',
      'speed.agentsTip': ' · {count} agents ({agents})',

      // Context & subagents
      'ctx.title': 'Context',
      'ctx.main': 'Main',
      'ctx.mainCardTitle': 'Click to focus Main',
      'ctx.cacheFresh': 'Cache {cached} · New {fresh}',
      'ctx.thinkShare': 'Think {pct}%',
      'ctx.thinkEmpty': 'Think —',
      'ctx.thinkTip': 'Thinking tokens share of last response ({restPct}% text & tools)',
      'ctx.thinkEmptyTip': 'No output yet',
      'ctx.remaining': '{val} left',
      'ctx.unknown': 'Unknown',
      'ctx.uncalled': 'Idle',
      'ctx.compacting': 'Compacting context…',
      'ctx.compactingTip': 'Summarizing and compacting history; context usage will drop once finished',
      'ctx.compactedSplit': 'Compacted · syncs next turn',
      'ctx.compactedSplitPre': 'Compacted (was {pre}) · syncs next turn',
      'ctx.compactedTip': '/compact completed; estimated ~{used} from summary until next turn syncs exact context',
      'ctx.compactedCache': 'Compacted · cache rebuilds next turn',
      'ctx.compactedCacheTip': '/compact cleared the old prefix; cache will rebuild on the next turn',
      'ctx.runningCache': 'Running · cache active',
      'ctx.runningCacheTip': 'Main session is running; each model call keeps the prefix cache warm until idle.',
      'ctx.subActiveCache': 'Active · timer paused',
      'ctx.subActiveCacheTip': '{count} subagent(s) running; idle countdown paused. Note: if Main waits >5m, its prefix cache may still rebuild when summarizing.',
      'ctx.cacheNone': 'Cache —',
      'ctx.cacheNoneTip': 'No call timestamp yet',
      'ctx.cacheHot': 'Cache hot · ~{rem}',
      'ctx.cacheWarn': 'Cache expiring · ~{rem}',
      'ctx.cacheExpired': 'Cache likely expired ({min}m idle)',
      'ctx.cacheColdCompact': 'Cache cold · /compact safe',
      'ctx.cacheColdCompactTip': 'Context is at {pct}% and idle {min}m (cache likely cold) — safe to run /compact without wasting warm cache.',
      'ctx.cacheTip': '{elapsed} since last call (5m reference window). Gemini 4 implicit cache lasts ~3–5m; Claude standard cache is 5m. Compacting after expiry avoids wasting warm cache.',
      'ctx.splitTip': 'Cache {cached} + New {fresh} + Est. {est} = {total}',
      'ctx.summaryActiveIdle': '{active} active · {idle} done',
      'ctx.summaryActive': '{active} active',
      'ctx.summaryIdle': '{idle} done',
      'ctx.activeSubs': 'Active Subagents',
      'ctx.completedSubs': '{count} completed subagents',
      'ctx.viewing': 'Viewing: ',
      'ctx.subagentDefault': 'Subagent',
      'ctx.viewTrend': 'Trend →',
      'ctx.backToMain': 'Back to Main',
      'ctx.lastCallTip': '{display} (last: {last})',

      // Statuses
      'status.running': 'Running',
      'status.waiting': 'Waiting',
      'status.idle': 'Idle',
      'status.killed': 'Stopped',

      // Breakdown groups
      'group.chatMessages': 'Chat Messages',
      'group.tools': 'Tools',
      'group.systemPrompt': 'System Prompt',
      'group.rules': 'Rules',
      'group.subagents': 'Subagents',
      'group.skills': 'Skills',
      'group.plugins': 'Plugins',
      'group.mcpTools': 'MCP Tools',

      // Trend
      'trend.curveTitle': 'Context Curve',
      'trend.curveAria': 'Context growth curve',
      'trend.warnLine': '75% alert',
      'trend.noHistory': 'No call history',
      'trend.readoutEmpty': '—',
      'trend.readout': '#{step} · {model} · Ctx {ctx} ({delta}) · Out {out} · {speed} · TTFT {ttft}',
      'trend.compactMarker': '/compact',
      'trend.breakdownTitle': 'Breakdown',
      'trend.breakdownTotal': 'Total {total}',
      'trend.colModel': 'Model',
      'trend.colContext': 'Context',
      'trend.colTtft': 'TTFT',
      'trend.colSpeed': 'Speed',
      'trend.noRows': 'No calls yet',
      'trend.spikeTip': 'Spike {delta}',
      'trend.rowTip': '#{step} {model} · Ctx {ctx} ({delta}) · Out {out} tok · TTFT {ttft} · Speed {speed}',

      // Usage
      'usage.title': 'Usage',
      'usage.scopeAria': 'Usage scope',
      'usage.modeAria': 'Usage unit',
      'usage.rangeAria': 'Usage range',
      'usage.scopeSession': 'Session',
      'usage.scopeAll': 'All',
      'usage.modeUsd': 'USD',
      'usage.modeAll': 'Total',
      'usage.modeNet': 'Net',
      'usage.rangeToday': 'Today',
      'usage.range7d': '7d',
      'usage.range30d': '30d',
      'usage.apiEquiv': 'API equiv.',
      'usage.cacheHit': 'Cache hit {pct}%',
      'usage.input': 'Input',
      'usage.cache': 'Cache',
      'usage.output': 'Output',
      'usage.noData': 'No usage data',
      'usage.noModels': 'No model usage in range',
      'usage.readout': '{label} · {tok} · {usd} (In {inp} / Cache {cache} / Out {out})',
      'usage.sessionScopeNote': 'This session (Main + {count} subagents)',
      'usage.sessionScopeMainOnly': 'This session (Main only)',
      'usage.sessionSplitMain': 'Main {tok} · {usd}',
      'usage.sessionSplitSubs': 'Subagents {tok} · {usd}',
      'usage.pricingFooter': 'Rates updated {date} · local estimate',
      'usage.pricingFooterNoDate': 'Local API rate estimate',
      'usage.noSessionData': 'No calls in this session yet',

      // Banners
      'banner.noConv': 'No conversationId detected. Open Agy HUD in a session auxiliary pane.',
      'banner.fetchErr': 'Failed to load metrics: {err}',
      'banner.waiting': 'Waiting for session data…',
    },
  };

  function normalizeLang(lang) {
    return String(lang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function detectInitialLang() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch {
      // Ignore storage restrictions
    }
    try {
      const nav = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : '';
      return normalizeLang(nav);
    } catch {
      return 'en';
    }
  }

  let currentLang = detectInitialLang();

  function syncHtmlLang(lang) {
    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      }
    } catch {
      // Ignore DOM restrictions
    }
  }
  syncHtmlLang(currentLang);

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    currentLang = normalizeLang(lang);
    try {
      localStorage.setItem(STORAGE_KEY, currentLang);
    } catch {
      // Ignore storage restrictions
    }
    syncHtmlLang(currentLang);
    return currentLang;
  }

  function t(key, vars = {}) {
    const dict = DICT[currentLang] || DICT.zh;
    const template = dict[key] ?? DICT.zh[key] ?? key;
    if (!vars || typeof template !== 'string') return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
        ? String(vars[name])
        : match
    ));
  }

  function applyDomI18n(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        const val = t(key);
        el.setAttribute('title', val);
        el.title = val;
      }
    });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) el.setAttribute('aria-label', t(key));
    });
  }

  const api = { getLang, setLang, t, applyDomI18n };
  if (typeof window !== 'undefined') {
    window.AgyI18n = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.AgyI18n = api;
  }
})();
