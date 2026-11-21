(() => {
  const ACTIVE_POLL_MS = 2500;
  const IDLE_POLL_MS = 5000;
  const USAGE_FALLBACK_MS = 30_000;
  const CACHE_REF_TTL_SEC = 300;
  const $ = (id) => document.getElementById(id);

  function loadPref(key, fallback, legacyKey = '') {
    try {
      const v = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : '');
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  function savePref(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch {
      // Ignore storage restrictions
    }
  }

  const state = {
    tab: 'overview',
    focusAgentId: null, // null -> main
    onlyFocusedModels: false,
    quotaMode: loadPref('agyHud.quotaMode', 'remaining', 'pulse.quotaMode'), // 'remaining' | 'used'
    usageMode: loadPref('agyHud.usageMode', 'all', 'pulse.usageMode'),       // 'usd' | 'all' | 'net'
    usageRange: loadPref('agyHud.usageRange', 'today', 'pulse.usageRange'),   // 'today' | '7d' | '30d'
    usageHoverIdx: null,
    etag: '',
    data: null,
    usageEtag: '',
    usageData: null,
    lastUsageCalls: null,
    lastUsageFetchAt: 0,
    timer: null,
    ttlTimer: null,
    inFlight: false,
    usageInFlight: false,
    error: '',
    lastQuotaResetRefreshAt: 0,
  };

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  // ---------- theme sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  function fmtTok(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtMax(n) {
    if (!n || !Number.isFinite(Number(n))) return '未知';
    const v = Number(n);
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
    }
    return `${Math.round(v / 1000)}K`;
  }

  function fmtUsd(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    if (n >= 100) return `$${n.toFixed(1)}`;
    return `$${n.toFixed(2)}`;
  }

  function fmtResetCountdown(isoStr) {
    if (!isoStr) return '';
    const targetMs = Date.parse(isoStr);
    if (!Number.isFinite(targetMs)) return '';
    const diffMin = Math.max(0, Math.round((targetMs - Date.now()) / 60000));
    if (diffMin < 1) return '<1m';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffMin >= 1440) {
      const d = Math.floor(diffMin / 1440);
      const h = Math.floor((diffMin % 1440) / 60);
      return h > 0 ? `${d}d${h}h` : `${d}d`;
    }
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }

  function fmtMinSec(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) return `${rem}s`;
    return `${m}m${String(rem).padStart(2, '0')}s`;
  }

  function pctColor(pct) {
    if (pct === null || pct === undefined) return 'var(--cm-chart-1)';
    if (pct >= 85) return 'var(--cm-error)';
    if (pct >= 70) return 'var(--cm-warning)';
    return 'var(--cm-chart-1)';
  }

  function quotaBarColor(remFraction, isUsedMode) {
    if (remFraction === null || remFraction === undefined) return 'var(--cm-chart-1)';
    const remPct = remFraction * 100;
    if (isUsedMode) {
      const used = 100 - remPct;
      if (used >= 85) return 'var(--cm-error)';
      if (used >= 65) return 'var(--cm-warning)';
      return 'var(--cm-chart-1)';
    }
    if (remPct < 15) return 'var(--cm-error)';
    if (remPct < 35) return 'var(--cm-warning)';
    return 'var(--cm-success)';
  }

  const STATUS_TEXT = {
    running: '运行中',
    waiting: '等待中',
    idle: '空闲',
    killed: '已终止',
  };

  const GROUP_LABELS = {
    'Chat Messages': '对话记录',
    'Tools': '工具定义',
    'System Prompt': '系统提示',
    'Rules': '规则',
    'Subagents': '子代理声明',
    'Skills': '技能目录',
    'Plugins': '插件列表',
    'Mcp Tools': 'MCP 工具',
  };

  function shortModel(name) {
    if (!name) return '—';
    return String(name)
      .replace(/^Gemini\s+/i, '')
      .replace(/^Claude\s+/i, '')
      .replace(/\s*\(Orchestrator\)$/i, ' (Orch)');
  }

  function getFocusedAgent() {
    const d = state.data;
    if (!d || !d.main) return null;
    if (!state.focusAgentId || state.focusAgentId === d.main.id) {
      return d.main;
    }
    const found = (d.subagents || []).find((s) => s.id === state.focusAgentId);
    if (!found) {
      state.focusAgentId = null;
      state.onlyFocusedModels = false;
      return d.main;
    }
    return found;
  }

  // ---------- cache freshness 1s countdown ----------
  function updateCacheCountdown() {
    const dot = $('cache-ttl-dot');
    const txt = $('cache-ttl-text');
    const row = $('cache-ttl-row');
    if (!dot || !txt || !row) return;

    const m = state.data?.main;
    dot.classList.remove('hot', 'warn', 'expired', 'compacting');

    if (m?.compaction?.state === 'running') {
      dot.classList.add('compacting');
      txt.textContent = '正在压缩上下文…';
      row.title = '正在生成会话摘要并压缩历史消息，完成后上下文占用将自动回落';
      return;
    }

    if (m?.compaction?.state === 'compacted') {
      txt.textContent = '已压缩 · 下轮重建缓存';
      row.title = '手动 /compact 已清空旧对话前缀，旧前缀缓存已失效，下一轮对话将重新构建新缓存';
      return;
    }

    if (!m || !m.lastCallTimestampMs) {
      txt.textContent = '缓存 —';
      row.title = '暂无调用时间戳';
      return;
    }

    const elapsedSec = Math.max(0, (Date.now() - m.lastCallTimestampMs) / 1000);
    const remSec = CACHE_REF_TTL_SEC - elapsedSec;

    if (elapsedSec < 180) {
      dot.classList.add('hot');
      txt.textContent = `缓存热 · ~${fmtMinSec(remSec)}`;
    } else if (elapsedSec < CACHE_REF_TTL_SEC) {
      dot.classList.add('warn');
      txt.textContent = `缓存临界 · ~${fmtMinSec(remSec)}`;
    } else {
      dot.classList.add('expired');
      const idleMin = Math.floor(elapsedSec / 60);
      txt.textContent = `缓存可能已失效（闲置 ${idleMin}m）`;
    }

    row.title =
      `距上次调用已过 ${fmtMinSec(elapsedSec)}（5 分钟参考窗口）。` +
      'Gemini 4 为后端隐式缓存，无固定官方 TTL，实测通常 3~5 分钟；Claude 标准缓存为 5 分钟。失效后再手动 /compact 不浪费热缓存。';
  }

  function ensureCountdownTimer() {
    if (state.ttlTimer) return;
    state.ttlTimer = setInterval(() => {
      if (!document.hidden && state.tab === 'overview' && state.data?.main) {
        updateCacheCountdown();
      }
    }, 1000);
  }

  // ---------- renderers ----------
  function renderLiveStatus() {
    const pill = $('live-pill');
    const label = $('live-label');
    pill.classList.remove('is-live', 'is-err');
    if (state.error) {
      pill.classList.add('is-err');
      pill.title = state.error;
      label.textContent = '异常';
      label.classList.remove('hidden');
    } else if (document.hidden) {
      pill.title = '后台已暂停';
      label.textContent = '已暂停';
      label.classList.remove('hidden');
    } else if (state.data?.ready) {
      pill.classList.add('is-live');
      pill.title = '实时同步中';
      label.textContent = '';
      label.classList.add('hidden');
    } else {
      pill.title = '等待会话数据';
      label.textContent = '等待中';
      label.classList.remove('hidden');
    }
  }

  function renderTabs() {
    const isOv = state.tab === 'overview';
    $('tab-overview').classList.toggle('active', isOv);
    $('tab-overview').setAttribute('aria-selected', String(isOv));
    $('tab-trend').classList.toggle('active', !isOv);
    $('tab-trend').setAttribute('aria-selected', String(!isOv));
    $('view-overview').classList.toggle('hidden', !isOv);
    $('view-trend').classList.toggle('hidden', isOv);
  }

  function renderModels(focus) {
    const d = state.data;
    const scopeBtn = $('scope-toggle');
    const isSubFocused = Boolean(focus && !focus.isMain);
    scopeBtn.classList.toggle('hidden', !isSubFocused);
    if (isSubFocused) {
      scopeBtn.classList.toggle('is-active', state.onlyFocusedModels);
      scopeBtn.textContent = state.onlyFocusedModels ? '仅当前' : '全部';
    } else {
      state.onlyFocusedModels = false;
    }

    const list = (isSubFocused && state.onlyFocusedModels)
      ? (focus.models || [])
      : (d?.models || []);

    const container = $('model-list');
    if (!list.length) {
      container.innerHTML = '<div class="empty-card">暂无调用记录</div>';
      return;
    }

    const hasSubagents = (d?.subagents || []).length > 0;

    const rowsHtml = list.map((m) => {
      const active = Boolean(m.isActive);

      const lastSpeed = m.last ? m.last.speed.toFixed(1) : '—';
      const lastAgentSuffix = hasSubagents && !state.onlyFocusedModels && m.last?.agentLabel
        ? ` · ${m.last.agentLabel.split(' · ')[0]}`
        : '';
      const lastTitle = m.last
        ? `上一轮：${m.last.outputTokens.toLocaleString()} tok · ${m.last.streamingSec.toFixed(1)}s${lastAgentSuffix}`
        : '暂无耗时记录';

      const avgSpeed = m.avg20 ? m.avg20.speed.toFixed(1) : '—';
      const avgTitle = m.avg20
        ? `近 ${m.avg20.sampleCount} 次加权均值，共 ${m.totalCalls} 次（总输出 / 总生成时长）`
        : `共 ${m.totalCalls} 次调用`;

      const variantSuffix = Array.isArray(m.variants) && m.variants.length > 1
        ? `（含 ${m.variants.join(' / ')}）`
        : '';
      const agentLabels = Array.isArray(m.agentLabels) ? m.agentLabels.map((l) => l.split(' · ')[0]) : [];
      const agentSuffix = hasSubagents && agentLabels.length > 1
        ? ` · ${agentLabels.length} 个代理（${agentLabels.join('、')}）`
        : '';
      const modelTitle = `${m.model}${variantSuffix}${agentSuffix}`;

      const activeAgentsList = Array.isArray(m.activeAgents) ? m.activeAgents.map((lbl) => lbl.split(' · ')[0]) : [];
      const activeTitle = activeAgentsList.length > 1
        ? `当前实时运行中（${activeAgentsList.length} 个）：${activeAgentsList.join('、')}`
        : (activeAgentsList.length === 1 ? `当前实时运行中：${activeAgentsList[0]}` : '当前实时运行中');

      return `
        <div class="speed-row ${active ? 'is-active-model' : ''}">
          <div class="speed-model-cell">
            <span class="speed-model-name" title="${esc(modelTitle)}">${esc(m.model)}</span>
            ${active ? `<span class="badge-active" title="${esc(activeTitle)}"><span class="badge-active-dot"></span>当前活跃</span>` : ''}
          </div>
          <span class="speed-num-last tabular-nums" title="${esc(lastTitle)}">${esc(lastSpeed)}</span>
          <span class="speed-num-avg tabular-nums" title="${esc(avgTitle)}">${esc(avgSpeed)}</span>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="speed-card">
        <div class="speed-head-row">
          <span>模型</span>
          <span class="text-right">Last</span>
          <span class="text-right">Avg 20</span>
        </div>
        ${rowsHtml}
      </div>
    `;
  }

  function renderContexts(focus) {
    const d = state.data;
    const m = d.main;
    const subs = d.subagents || [];

    const activeCount = d.sessionTotals?.activeSubagents || 0;
    $('session-summary').textContent = subs.length
      ? `${subs.length} 子代理${activeCount ? ` · ${activeCount} 活跃` : ''}`
      : '';

    const displayModel = m.sessionModel || m.latestModel;
    $('main-model').textContent = shortModel(displayModel);
    $('main-model').title = (m.lastCallModel && m.lastCallModel !== displayModel)
      ? `${displayModel}（最近调用：${m.lastCallModel}）`
      : (displayModel || '');

    const mPct = m.pct;
    const hasMax = m.maxTokens && m.maxTokens > 0;
    const isCompacted = m.compaction?.state === 'compacted';
    const ratioPrefix = isCompacted ? '≈ ' : '';
    const ratioStr = hasMax
      ? `${ratioPrefix}${fmtTok(m.usedTokens)} / ${fmtMax(m.maxTokens)} (${mPct.toFixed(1)}%)`
      : `${ratioPrefix}${fmtTok(m.usedTokens)} / 未知`;
    $('main-ratio').textContent = ratioStr;

    const totalPct = hasMax && mPct !== null ? Math.min(100, mPct) : 0;
    const tone = pctColor(mPct);

    if (isCompacted) {
      $('main-bar-cache').style.width = '0%';
      $('main-bar-fresh').style.width = '0%';
      $('main-bar-est').style.width = `${totalPct.toFixed(1)}%`;
      $('main-bar-est').style.background = tone;

      const preTok = m.compaction?.preCompactTokens;
      const splitText = preTok
        ? `已压缩（原 ${fmtTok(preTok)}）· 下轮精确同步`
        : '已压缩 · 下轮精确同步';
      const splitTip = `已执行 /compact 压缩，当前按摘要输出估算（约 ${fmtTok(m.usedTokens)}），下一轮对话将同步精确上下文占用与缓存状态`;
      $('main-progress-track').title = splitTip;
      $('main-split').title = splitTip;
      $('main-split').textContent = splitText;
    } else {
      const cachePct = hasMax ? Math.min(100, (m.cachedTokens / m.maxTokens) * 100) : 0;
      const freshPct = hasMax ? Math.min(100 - cachePct, (m.freshTokens / m.maxTokens) * 100) : 0;
      const estPct = hasMax ? Math.max(0, totalPct - cachePct - freshPct) : 0;

      $('main-bar-cache').style.width = `${cachePct.toFixed(1)}%`;
      $('main-bar-cache').style.background = tone;
      $('main-bar-fresh').style.width = `${freshPct.toFixed(1)}%`;
      $('main-bar-est').style.width = `${estPct.toFixed(1)}%`;
      $('main-bar-est').style.background = tone;

      const estDelta = Math.max(0, m.usedTokens - (m.cachedTokens + m.freshTokens));
      const splitTitle = `缓存 ${fmtTok(m.cachedTokens)} + 新增 ${fmtTok(m.freshTokens)} + 预估余量 ${fmtTok(estDelta)} = ${fmtTok(m.usedTokens)}`;
      $('main-progress-track').title = splitTitle;
      $('main-split').title = splitTitle;
      $('main-split').textContent = `缓存 ${fmtTok(m.cachedTokens)} · 新增 ${fmtTok(m.freshTokens)}`;
    }

    const thinkEl = $('main-think');
    if (m.thinkPct !== null && m.thinkPct !== undefined) {
      thinkEl.textContent = `思考占输出 ${m.thinkPct}%`;
      thinkEl.title = `最近一次回复中，内部思维链占总输出 token 的比例（其余 ${m.responsePct}% 为正文与工具调用）`;
    } else {
      thinkEl.textContent = '思考占输出 —';
      thinkEl.title = '暂无输出记录';
    }

    $('main-remaining').textContent = m.remainingTokens !== null ? `剩 ${fmtTok(m.remainingTokens)}` : '剩 —';
    updateCacheCountdown();

    $('main-card').classList.toggle('is-selected', Boolean(subs.length > 0 && (!state.focusAgentId || state.focusAgentId === m.id)));

    // Subagents (hidden when empty)
    $('sub-section').classList.toggle('hidden', subs.length === 0);
    if (!subs.length) {
      $('sub-list').innerHTML = '';
    } else {
      $('sub-count').textContent = String(subs.length);
      const subList = $('sub-list');
      subList.innerHTML = subs.map((s) => {
        const selected = state.focusAgentId === s.id;
        const pct = s.pct;
        const barWidth = pct !== null ? Math.min(100, pct).toFixed(1) : '0';
        const hasMax = Boolean(s.maxTokens && s.maxTokens > 0);
        const rightText = hasMax
          ? `${fmtTok(s.usedTokens)} · ${pct.toFixed(1)}%`
          : fmtTok(s.usedTokens);
        const rightTitle = hasMax
          ? `${fmtTok(s.usedTokens)} / ${fmtMax(s.maxTokens)} (${pct.toFixed(1)}%)`
          : `${fmtTok(s.usedTokens)} / 未知`;
        const stText = STATUS_TEXT[s.status] || s.status || '空闲';
        const modelName = s.latestModel || '未调用';
        return `
          <div class="sub-row ${selected ? 'is-selected' : ''}" data-sub-id="${esc(s.id)}" role="button" tabindex="0">
            <div class="sub-row-top">
              <div class="sub-row-left">
                <span class="status-dot ${esc(s.status)}" title="${esc(stText)}"></span>
                <span class="sub-name" title="${esc(s.label)}">${esc(s.label)}</span>
              </div>
              <span class="sub-ratio tabular-nums" title="${esc(rightTitle)}">${esc(rightText)}</span>
            </div>
            <div class="sub-row-meta">
              <span class="sub-model" title="${esc(modelName)}">${esc(modelName)}</span>
              <span class="sub-state ${esc(s.status)}">${esc(stText)}</span>
            </div>
            <div class="progress-track slim">
              <div class="progress-seg" style="width: ${barWidth}%; background: ${pctColor(pct)};"></div>
            </div>
          </div>
        `;
      }).join('');

      subList.querySelectorAll('.sub-row').forEach((row) => {
        const activate = () => {
          const id = row.getAttribute('data-sub-id');
          state.focusAgentId = state.focusAgentId === id ? null : id;
          if (!state.focusAgentId) state.onlyFocusedModels = false;
          render();
        };
        row.addEventListener('click', activate);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        });
      });
    }

    $('focus-bar').classList.toggle('hidden', Boolean(!focus || focus.isMain));
    if (focus && !focus.isMain) {
      $('focus-name').textContent = focus.label || '子代理';
      $('focus-name').title = focus.label || '子代理';
    }
  }

  function renderQuota() {
    const isUsed = state.quotaMode === 'used';
    document.querySelectorAll('.qmode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.qmode === state.quotaMode);
    });

    const pools = state.data?.quotaPools || [];
    const card = $('quota-card');
    if (!pools.length) {
      card.innerHTML = '<div class="section-note">暂无配额数据</div>';
      return;
    }

    card.innerHTML = pools.map((p) => {
      const hasFrac = p.remainingFraction !== null && p.remainingFraction !== undefined;
      const remPct = hasFrac ? p.remainingFraction * 100 : null;
      const usedPct = hasFrac ? Math.max(0, 100 - remPct) : null;
      const displayPct = isUsed ? usedPct : remPct;
      const valText = displayPct === null
        ? '—'
        : (isUsed ? `已用 ${displayPct.toFixed(1)}%` : `${displayPct.toFixed(1)}%`);
      const cd = fmtResetCountdown(p.resetTime);
      const barWidth = displayPct !== null ? Math.min(100, Math.max(0, displayPct)).toFixed(1) : '0';
      const barColor = quotaBarColor(p.remainingFraction, isUsed);

      return `
        <div class="quota-pool">
          <div class="quota-row-top">
            <div class="quota-pool-left">
              <span class="agent-name">${esc(p.name)}</span>
              <span class="quota-pool-models">${esc(p.modelsSummary || '')}</span>
            </div>
            <span class="quota-pool-right tabular-nums">${esc(valText)}${cd ? ` <span class="quota-reset">· ${esc(cd)}</span>` : ''}</span>
          </div>
          <div class="progress-track slim">
            <div class="progress-seg" style="width: ${barWidth}%; background: ${barColor};"></div>
          </div>
        </div>
      `;
    }).join('');
    state.lastQuotaResetRefreshAt = Date.now();
  }

  function barMetrics(b, rates) {
    const inUsd = (b.inp / 1e6) * rates.rIn;
    const cacheUsd = (b.cache / 1e6) * rates.rCache;
    const outUsd = (b.out / 1e6) * rates.rOut;
    const totalUsd = inUsd + cacheUsd + outUsd;
    const totalTok = b.inp + b.cache + b.out;
    const netTok = b.inp + b.out;
    if (state.usageMode === 'usd') {
      return { val: b.totalUsd ?? totalUsd, netPart: inUsd + outUsd, totalTok, totalUsd: b.totalUsd ?? totalUsd };
    }
    if (state.usageMode === 'net') {
      return { val: netTok, netPart: netTok, totalTok: netTok, totalUsd: b.totalUsd ?? totalUsd };
    }
    return { val: totalTok, netPart: netTok, totalTok, totalUsd: b.totalUsd ?? totalUsd };
  }

  function modelValue(m) {
    if (state.usageMode === 'usd') return m.totalUsd;
    if (state.usageMode === 'net') return m.netTok;
    return m.totalTok;
  }

  function renderUsageReadout(ds, rates) {
    const bars = ds.bars || [];
    const el = $('usage-readout');
    if (!bars.length) {
      el.textContent = '暂无统计数据';
      return;
    }
    const idx = state.usageHoverIdx;
    const b = (idx !== null && bars[idx]) ? bars[idx] : bars[bars.length - 1];
    const bm = barMetrics(b, rates);
    el.textContent = `${b.label} · ${fmtTok(bm.totalTok)} · ${fmtUsd(bm.totalUsd)}（入 ${fmtTok(b.inp)} / 缓 ${fmtTok(b.cache)} / 出 ${fmtTok(b.out)}）`;
  }

  function renderUsage() {
    document.querySelectorAll('.umode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.umode === state.usageMode);
    });
    document.querySelectorAll('.urange-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.urange === state.usageRange);
    });

    const u = state.usageData;
    if (!u || !u.ready) return;

    const rangeKey = state.usageRange === '7d' ? 'd7' : (state.usageRange === '30d' ? 'd30' : 'today');
    const ds = u[rangeKey];
    if (!ds) return;

    const rates = {
      rIn: ds.inp > 0 ? ds.inUsd / (ds.inp / 1e6) : 0,
      rCache: ds.cache > 0 ? ds.cacheUsd / (ds.cache / 1e6) : 0,
      rOut: ds.out > 0 ? ds.outUsd / (ds.out / 1e6) : 0,
    };

    const hitText = `缓存命中 ${ds.cacheHitPct.toFixed(1)}%`;

    if (state.usageMode === 'usd') {
      $('usage-hero-primary').textContent = fmtUsd(ds.totalUsd);
      $('usage-hero-unit').textContent = 'API 等值';
      $('usage-hero-meta').textContent = `${fmtTok(ds.totalTok)} tok · ${hitText}`;
      $('usage-main-in').textContent = fmtUsd(ds.inUsd);
      $('usage-sub-in').textContent = fmtTok(ds.inp);
      $('usage-main-cache').textContent = fmtUsd(ds.cacheUsd);
      $('usage-sub-cache').textContent = fmtTok(ds.cache);
      $('usage-main-out').textContent = fmtUsd(ds.outUsd);
      $('usage-sub-out').textContent = fmtTok(ds.out);
    } else {
      const tokVal = state.usageMode === 'net' ? ds.netTok : ds.totalTok;
      $('usage-hero-primary').textContent = fmtTok(tokVal);
      $('usage-hero-unit').textContent = 'tokens';
      $('usage-hero-meta').textContent = `≈ ${fmtUsd(ds.totalUsd)} · ${hitText}`;
      $('usage-main-in').textContent = fmtTok(ds.inp);
      $('usage-sub-in').textContent = fmtUsd(ds.inUsd);
      $('usage-main-cache').textContent = fmtTok(ds.cache);
      $('usage-sub-cache').textContent = fmtUsd(ds.cacheUsd);
      $('usage-main-out').textContent = fmtTok(ds.out);
      $('usage-sub-out').textContent = fmtUsd(ds.outUsd);
    }

    const bars = ds.bars || [];
    const metricsList = bars.map((b) => barMetrics(b, rates));
    const maxVal = Math.max(1e-9, ...metricsList.map((m) => m.val));
    const barsEl = $('usage-bars');
    barsEl.innerHTML = bars.map((b, i) => {
      const bm = metricsList[i];
      const totalH = bm.val > 0 ? Math.max(3, Math.round((bm.val / maxVal) * 40)) : 2;
      const netH = state.usageMode === 'net'
        ? totalH
        : (bm.val > 0 ? Math.max(1, Math.round((bm.netPart / Math.max(1e-9, bm.val)) * totalH)) : 2);
      const cacheH = bm.val > 0 ? Math.max(0, totalH - netH) : 0;
      const isLast = i === bars.length - 1;
      const netOpacity = bm.val > 0 ? '' : 'opacity:0.25;';
      return `
        <div class="usage-bar-col" data-idx="${i}" title="${esc(b.label)}: ${fmtTok(bm.totalTok)} · ${fmtUsd(bm.totalUsd)}">
          ${cacheH > 0 ? `<div class="usage-bar-cache" style="height:${cacheH}px;"></div>` : ''}
          <div class="usage-bar-net ${cacheH === 0 ? 'no-top' : ''} ${isLast ? 'is-last' : ''}" style="height:${netH}px;${netOpacity}"></div>
        </div>
      `;
    }).join('');

    barsEl.querySelectorAll('.usage-bar-col').forEach((col) => {
      col.addEventListener('mouseenter', () => {
        state.usageHoverIdx = Number(col.dataset.idx);
        renderUsageReadout(ds, rates);
      });
    });
    barsEl.onmouseleave = () => {
      state.usageHoverIdx = null;
      renderUsageReadout(ds, rates);
    };

    $('usage-axis').innerHTML = (ds.axis || []).map((a) => `<span>${esc(a)}</span>`).join('');
    renderUsageReadout(ds, rates);

    const modelsWrap = $('usage-models');
    const models = [...(ds.models || [])].sort((a, b) => modelValue(b) - modelValue(a)).slice(0, 4);
    if (!models.length) {
      modelsWrap.innerHTML = '<div class="section-note">该周期暂无模型记录</div>';
    } else {
      const maxM = Math.max(1e-9, ...models.map(modelValue));
      modelsWrap.innerHTML = models.map((m) => {
        const val = modelValue(m);
        const w = Math.max(4, (val / maxM) * 100);
        const tok = state.usageMode === 'net' ? m.netTok : m.totalTok;
        const rightHtml = state.usageMode === 'usd'
          ? `${esc(fmtUsd(m.totalUsd))} <span class="usage-model-sub">${esc(fmtTok(tok))}</span>`
          : `${esc(fmtTok(tok))} <span class="usage-model-sub">${esc(fmtUsd(m.totalUsd))}</span>`;
        return `
          <div class="usage-model-row tabular-nums">
            <span class="usage-model-name" title="${esc(m.name)}">${esc(m.name)}</span>
            <div class="usage-model-track">
              <div class="usage-model-fill" style="width:${w.toFixed(1)}%;"></div>
            </div>
            <span class="usage-model-val">${rightHtml}</span>
          </div>
        `;
      }).join('');
    }
  }

  function renderTrend(focus) {
    if (!focus) return;
    $('trend-focus-bar').classList.toggle('hidden', Boolean(focus.isMain));
    $('trend-focus-label').textContent = focus.label || '主会话';
    $('trend-focus-label').title = focus.label || '主会话';

    const svg = $('trend-chart');
    const hist = focus.history || [];
    if (!hist.length) {
      svg.innerHTML = '<text x="190" y="60" text-anchor="middle" fill="var(--cm-fg-muted)" font-size="12">暂无调用历史</text>';
    } else {
      const maxY = focus.maxTokens || Math.max(1, ...hist.map((h) => h.usedTokens)) * 1.15;
      const warnY = 100 - 0.75 * 86;
      const pts = hist.map((h, i) => {
        const x = hist.length === 1 ? 190 : 12 + (i / (hist.length - 1)) * 356;
        const ratio = Math.min(1, h.usedTokens / maxY);
        const y = 100 - ratio * 86;
        return [x, y];
      });
      const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const area = pts.length > 1
        ? `12,100 ${poly} ${pts[pts.length - 1][0].toFixed(1)},100`
        : '';
      svg.innerHTML = `
        <line x1="12" y1="${warnY.toFixed(1)}" x2="368" y2="${warnY.toFixed(1)}" stroke="var(--cm-warning)" stroke-width="1" stroke-dasharray="4 3" opacity="0.75" />
        ${area ? `<polygon points="${area}" fill="var(--cm-chart-1)" opacity="0.16" />` : ''}
        ${pts.length > 1 ? `<polyline points="${poly}" fill="none" stroke="var(--cm-chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ''}
        ${pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="var(--cm-chart-1)" />`).join('')}
      `;
    }

    const bdCard = $('breakdown-card');
    const groups = focus.tokenBreakdown || [];
    if (!groups.length) {
      bdCard.classList.add('hidden');
    } else {
      bdCard.classList.remove('hidden');
      const denom = focus.usedTokens || groups.reduce((s, g) => s + g.numTokens, 0) || 1;
      $('breakdown-total').textContent = `总计 ${fmtTok(denom)}`;
      $('breakdown-list').innerHTML = groups.map((g) => {
        const pct = Math.min(100, (g.numTokens / denom) * 100);
        const name = GROUP_LABELS[g.name] || g.name;
        return `
          <div class="breakdown-item">
            <div class="breakdown-meta tabular-nums">
              <span>${esc(name)}</span>
              <span>${fmtTok(g.numTokens)} (${pct.toFixed(1)}%)</span>
            </div>
            <div class="breakdown-track">
              <div class="breakdown-fill" style="width: ${pct.toFixed(1)}%;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    const rows = [...hist].reverse().slice(0, 12);
    const tbody = $('trend-rows');
    if (!rows.length) {
      tbody.innerHTML = '<div class="empty-card">暂无调用明细</div>';
    } else {
      tbody.innerHTML = rows.map((r) => `
        <div class="table-row">
          <span>#${r.stepIndex}</span>
          <span class="table-model" title="${esc(r.model)}">${esc(shortModel(r.model))}</span>
          <span class="text-right">${fmtTok(r.usedTokens)}</span>
          <span class="text-right">${r.outputTokens}</span>
          <span class="text-right">${r.speed !== null ? `${r.speed.toFixed(1)} tok/s` : '—'}</span>
        </div>
      `).join('');
    }
  }

  function render() {
    renderLiveStatus();
    renderTabs();

    const banner = $('state-banner');
    if (state.error) {
      banner.classList.remove('hidden');
      banner.classList.add('is-err');
      banner.textContent = `读取监控数据失败：${state.error}`;
    } else if (state.data && !state.data.ready) {
      banner.classList.remove('hidden', 'is-err');
      banner.textContent = state.data.error || '等待会话数据…';
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('is-err');
    }

    if (!state.data?.ready || !state.data.main) return;
    const focus = getFocusedAgent();
    if (state.tab === 'overview') {
      renderModels(focus);
      renderContexts(focus);
      renderQuota();
      renderUsage();
    } else {
      renderTrend(focus);
    }
  }

  // ---------- polling ----------
  function isSessionActive() {
    if (state.data?.main?.status === 'running') return true;
    if (state.data?.main?.compaction?.state === 'running') return true;
    return (state.data?.subagents || []).some((s) => s.status === 'running');
  }

  function scheduleNextPoll() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (document.hidden) return;
    const delay = isSessionActive() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    state.timer = setTimeout(fetchMetrics, delay);
  }

  async function fetchUsage(force = false) {
    if (state.usageInFlight || document.hidden) return;
    state.usageInFlight = true;
    try {
      const q = new URLSearchParams();
      if (state.usageEtag) q.set('etag', state.usageEtag);
      if (force) q.set('force', '1');
      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await fetcher(`/api/usage?${q.toString()}`, { method: 'GET' });
      if (!res.ok) return;
      const payload = await res.json();
      state.lastUsageFetchAt = Date.now();
      if (!payload.unchanged && payload.ready) {
        state.usageData = payload;
        state.usageEtag = payload.etag || '';
        if (state.tab === 'overview') renderUsage();
      }
    } catch {
      // Non-fatal; retry on next trigger
    } finally {
      state.usageInFlight = false;
    }
  }

  async function fetchMetrics() {
    if (state.inFlight || document.hidden) return;
    const conv = currentConv();
    if (!conv) {
      state.data = { ready: false, error: '未检测到 conversationId，请在会话右侧辅助栏中打开。' };
      render();
      return;
    }

    state.inFlight = true;
    const hadError = Boolean(state.error);
    try {
      const q = new URLSearchParams({ conversationId: conv });
      if (state.etag) q.set('etag', state.etag);
      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await fetcher(`/api/metrics?${q.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      state.error = '';

      if (payload.unchanged && !hadError) {
        if (state.tab === 'overview' && Date.now() - state.lastQuotaResetRefreshAt > 30_000) {
          renderQuota();
        }
        if (Date.now() - state.lastUsageFetchAt > USAGE_FALLBACK_MS) {
          void fetchUsage(false);
        }
        return;
      }

      if (!payload.unchanged) {
        state.data = payload;
        state.etag = payload.etag || '';
      }
      render();

      const curCalls = payload.sessionTotals?.totalCalls ?? null;
      const callsChanged = curCalls !== null && curCalls !== state.lastUsageCalls;
      if (callsChanged || Date.now() - state.lastUsageFetchAt > USAGE_FALLBACK_MS) {
        state.lastUsageCalls = curCalls;
        void fetchUsage(callsChanged);
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      render();
    } finally {
      state.inFlight = false;
      scheduleNextPoll();
    }
  }

  // ---------- events ----------
  $('tab-overview').addEventListener('click', () => { state.tab = 'overview'; render(); });
  $('tab-trend').addEventListener('click', () => { state.tab = 'trend'; render(); });
  $('scope-toggle').addEventListener('click', () => {
    state.onlyFocusedModels = !state.onlyFocusedModels;
    render();
  });

  const resetFocus = () => {
    state.focusAgentId = null;
    state.onlyFocusedModels = false;
    render();
  };
  $('main-card').addEventListener('click', resetFocus);
  $('main-card').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetFocus();
    }
  });
  $('focus-reset').addEventListener('click', resetFocus);
  $('trend-reset-focus').addEventListener('click', resetFocus);

  const setQuotaMode = (mode) => {
    state.quotaMode = mode;
    savePref('agyHud.quotaMode', mode);
    renderQuota();
  };
  document.querySelectorAll('.qmode-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setQuotaMode(btn.dataset.qmode);
    });
  });
  $('quota-card').addEventListener('click', () => {
    setQuotaMode(state.quotaMode === 'remaining' ? 'used' : 'remaining');
  });

  document.querySelectorAll('.umode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.usageMode = btn.dataset.umode;
      savePref('agyHud.usageMode', state.usageMode);
      renderUsage();
    });
  });
  document.querySelectorAll('.urange-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.usageRange = btn.dataset.urange;
      state.usageHoverIdx = null;
      savePref('agyHud.usageRange', state.usageRange);
      renderUsage();
    });
  });

  document.addEventListener('visibilitychange', () => {
    renderLiveStatus();
    if (document.hidden) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    } else {
      updateCacheCountdown();
      fetchMetrics();
      fetchUsage(false);
    }
  });

  ensureCountdownTimer();
  render();
  fetchMetrics();
  fetchUsage(false);
})();
