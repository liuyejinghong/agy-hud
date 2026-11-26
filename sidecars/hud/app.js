(() => {
  const ACTIVE_POLL_MS = 2500;
  const IDLE_POLL_MS = 5000;
  const USAGE_FALLBACK_MS = 30_000;
  const CACHE_REF_TTL_SEC = 300;
  const SPIKE_DELTA_TOKENS = 30_000;
  const $ = (id) => document.getElementById(id);

  const i18n = () => window.AgyI18n || {
    getLang: () => 'zh',
    setLang: (lang) => lang,
    t: (key) => key,
    applyDomI18n: () => {},
  };
  const t = (key, vars) => i18n().t(key, vars);

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
    showIdleSubs: false,
    quotaMode: loadPref('agyHud.quotaMode', 'remaining', 'pulse.quotaMode'), // 'remaining' | 'used'
    usageScope: loadPref('agyHud.usageScope', 'all'),                        // 'session' | 'all'
    usageMode: loadPref('agyHud.usageMode', 'all', 'pulse.usageMode'),       // 'usd' | 'all' | 'net'
    usageRange: loadPref('agyHud.usageRange', 'today', 'pulse.usageRange'),   // 'today' | '7d' | '30d'
    usageHoverIdx: null,
    trendHoverIdx: null,
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
    if (!n || !Number.isFinite(Number(n))) return t('ctx.unknown');
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

  function fmtDelta(d) {
    const n = Number(d);
    if (!Number.isFinite(n)) return '—';
    return n >= 0 ? `+${fmtTok(n)}` : `-${fmtTok(Math.abs(n))}`;
  }

  function fmtTtft(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    return `${Number(v).toFixed(1)}s`;
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

  function fmtLocalResetTime(isoStr) {
    if (!isoStr) return '';
    const targetMs = Date.parse(isoStr);
    if (!Number.isFinite(targetMs)) return '';
    const d = new Date(targetMs);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
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

  const STATUS_KEY_MAP = {
    running: 'status.running',
    waiting: 'status.waiting',
    idle: 'status.idle',
    killed: 'status.killed',
  };

  function statusText(status) {
    const key = STATUS_KEY_MAP[status];
    return key ? t(key) : (status || t('status.idle'));
  }

  const GROUP_KEY_MAP = {
    'Chat Messages': 'group.chatMessages',
    'Tools': 'group.tools',
    'System Prompt': 'group.systemPrompt',
    'Rules': 'group.rules',
    'Subagents': 'group.subagents',
    'Skills': 'group.skills',
    'Plugins': 'group.plugins',
    'Mcp Tools': 'group.mcpTools',
  };

  function groupLabel(name) {
    const key = GROUP_KEY_MAP[name];
    return key ? t(key) : name;
  }

  function shortModel(name) {
    if (!name) return '—';
    return String(name)
      .replace(/^Gemini\s+/i, '')
      .replace(/^Claude\s+/i, '')
      .replace(/\s*\(Orchestrator\)$/i, ' (Orch)');
  }

  const listJoiner = () => (i18n().getLang() === 'en' ? ', ' : '、');

  function localizeAgentLabel(label) {
    if (!label) return '';
    const first = String(label).split(' · ')[0];
    return first === '主会话' ? t('ctx.main') : first;
  }

  function localizeModelName(name) {
    if (!name || name === '未调用') return t('ctx.uncalled');
    return name;
  }

  function getFocusedAgent() {
    const d = state.data;
    if (!d || !d.main) return null;
    if (!state.focusAgentId || state.focusAgentId === d.main.id) {
      return d.main;
    }
    const found = (d.subagents || []).find((s) => s.id === state.focusAgentId && s.status !== 'killed');
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
    dot.classList.remove('hot', 'warn', 'expired', 'compacting', 'pulsing');

    if (m?.compaction?.state === 'running') {
      dot.classList.add('compacting');
      txt.textContent = t('ctx.compacting');
      row.title = t('ctx.compactingTip');
      return;
    }

    if (m?.status === 'running') {
      dot.classList.add('hot', 'pulsing');
      txt.textContent = t('ctx.runningCache');
      row.title = t('ctx.runningCacheTip');
      return;
    }

    const runningSubs = (state.data?.subagents || []).filter((s) => s.status === 'running').length;
    if (runningSubs > 0) {
      dot.classList.add('hot', 'pulsing');
      txt.textContent = t('ctx.subActiveCache');
      row.title = t('ctx.subActiveCacheTip', { count: runningSubs });
      return;
    }

    if (m?.compaction?.state === 'compacted') {
      txt.textContent = t('ctx.compactedCache');
      row.title = t('ctx.compactedCacheTip');
      return;
    }

    if (!m || !m.lastCallTimestampMs) {
      txt.textContent = t('ctx.cacheNone');
      row.title = t('ctx.cacheNoneTip');
      return;
    }

    const elapsedSec = Math.max(0, (Date.now() - m.lastCallTimestampMs) / 1000);
    const remSec = CACHE_REF_TTL_SEC - elapsedSec;

    if (elapsedSec < 180) {
      dot.classList.add('hot');
      txt.textContent = t('ctx.cacheHot', { rem: fmtMinSec(remSec) });
      row.title = t('ctx.cacheTip', { elapsed: fmtMinSec(elapsedSec) });
      return;
    }

    if (elapsedSec < CACHE_REF_TTL_SEC) {
      dot.classList.add('warn');
      txt.textContent = t('ctx.cacheWarn', { rem: fmtMinSec(remSec) });
      row.title = t('ctx.cacheTip', { elapsed: fmtMinSec(elapsedSec) });
      return;
    }

    const idleMin = Math.floor(elapsedSec / 60);
    if (m.pct !== null && m.pct !== undefined && m.pct >= 75) {
      dot.classList.add('warn');
      txt.textContent = t('ctx.cacheColdCompact');
      row.title = t('ctx.cacheColdCompactTip', { pct: m.pct.toFixed(0), min: idleMin });
      return;
    }

    dot.classList.add('expired');
    txt.textContent = t('ctx.cacheExpired', { min: idleMin });
    row.title = t('ctx.cacheTip', { elapsed: fmtMinSec(elapsedSec) });
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
    if (!pill || !label) return;
    pill.classList.remove('is-live', 'is-err');
    if (state.error) {
      pill.classList.add('is-err');
      pill.title = state.error;
      label.textContent = t('live.error');
      label.classList.remove('hidden');
    } else if (document.hidden) {
      pill.title = t('live.pausedTitle');
      label.textContent = t('live.paused');
      label.classList.remove('hidden');
    } else if (state.data?.ready) {
      pill.classList.add('is-live');
      pill.title = t('live.live');
      label.textContent = '';
      label.classList.add('hidden');
    } else {
      pill.title = t('live.waitingTitle');
      label.textContent = t('live.waiting');
      label.classList.remove('hidden');
    }
  }

  function renderTabs() {
    const tabs = [
      ['overview', 'tab-overview', 'view-overview'],
      ['trend', 'tab-trend', 'view-trend'],
      ['usage', 'tab-usage', 'view-usage'],
    ];
    for (const [key, btnId, viewId] of tabs) {
      const active = state.tab === key;
      $(btnId)?.classList.toggle('active', active);
      $(btnId)?.setAttribute('aria-selected', String(active));
      $(viewId)?.classList.toggle('hidden', !active);
    }
  }

  function renderModels(focus) {
    const d = state.data;
    const scopeBtn = $('scope-toggle');
    const isSubFocused = Boolean(focus && !focus.isMain);
    scopeBtn.classList.toggle('hidden', !isSubFocused);
    if (isSubFocused) {
      scopeBtn.classList.toggle('is-active', state.onlyFocusedModels);
      scopeBtn.textContent = state.onlyFocusedModels ? t('speed.focusedOnly') : t('speed.all');
    } else {
      state.onlyFocusedModels = false;
    }

    const list = (isSubFocused && state.onlyFocusedModels)
      ? (focus.models || [])
      : (d?.models || []);

    const container = $('model-list');
    if (!list.length) {
      container.innerHTML = `<div class="empty-card">${esc(t('speed.empty'))}</div>`;
      return;
    }

    const hasSubagents = (d?.subagents || []).length > 0;

    const rowsHtml = list.map((m) => {
      const active = Boolean(m.isActive);

      const lastSpeed = m.last ? m.last.speed.toFixed(1) : '—';
      const lastTtftPart = (m.last?.ttftSec !== null && m.last?.ttftSec !== undefined)
        ? t('speed.ttftPart', { ttft: Number(m.last.ttftSec).toFixed(1) })
        : '';
      const lastAgentSuffix = hasSubagents && !state.onlyFocusedModels && m.last?.agentLabel
        ? ` · ${localizeAgentLabel(m.last.agentLabel)}`
        : '';
      const lastTitle = m.last
        ? t('speed.lastTip', {
            tokens: m.last.outputTokens.toLocaleString(),
            sec: m.last.streamingSec.toFixed(1),
            ttft: lastTtftPart,
            agent: lastAgentSuffix,
          })
        : t('speed.lastNoTiming');

      const avgSpeed = m.avg20 ? m.avg20.speed.toFixed(1) : '—';
      const avgTtftPart = (m.avg20?.avgTtftSec !== null && m.avg20?.avgTtftSec !== undefined)
        ? t('speed.avgTtftPart', { ttft: Number(m.avg20.avgTtftSec).toFixed(1) })
        : '';
      const avgTitle = m.avg20
        ? t('speed.avgTip', {
            samples: m.avg20.sampleCount,
            total: m.totalCalls,
            avgTtft: avgTtftPart,
          })
        : t('speed.avgCallsOnly', { total: m.totalCalls });

      const variantSuffix = Array.isArray(m.variants) && m.variants.length > 1
        ? t('speed.variantsTip', { variants: m.variants.join(' / ') })
        : '';
      const agentLabels = Array.isArray(m.agentLabels) ? m.agentLabels.map(localizeAgentLabel) : [];
      const agentSuffix = hasSubagents && agentLabels.length > 1
        ? t('speed.agentsTip', { count: agentLabels.length, agents: agentLabels.join(listJoiner()) })
        : '';
      const modelTitle = `${m.model}${variantSuffix}${agentSuffix}`;

      const activeAgentsList = Array.isArray(m.activeAgents) ? m.activeAgents.map(localizeAgentLabel) : [];
      const activeTitle = activeAgentsList.length > 1
        ? t('speed.activeNowMany', { count: activeAgentsList.length, agents: activeAgentsList.join(listJoiner()) })
        : (activeAgentsList.length === 1
            ? t('speed.activeNowOne', { agent: activeAgentsList[0] })
            : t('speed.activeNow'));

      return `
        <div class="speed-row ${active ? 'is-active-model' : ''}">
          <div class="speed-model-cell">
            <span class="speed-model-name" title="${esc(modelTitle)}">${esc(m.model)}</span>
            ${active ? `<span class="badge-active" title="${esc(activeTitle)}"><span class="badge-active-dot"></span>${esc(t('speed.activeBadge'))}</span>` : ''}
          </div>
          <span class="speed-num-last tabular-nums" title="${esc(lastTitle)}">${esc(lastSpeed)}</span>
          <span class="speed-num-avg tabular-nums" title="${esc(avgTitle)}">${esc(avgSpeed)}</span>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="speed-card">
        <div class="speed-head-row">
          <span>${esc(t('speed.colModel'))}</span>
          <span class="text-right">Last</span>
          <span class="text-right">Avg 20</span>
        </div>
        ${rowsHtml}
      </div>
    `;
  }

  function renderSubRow(s) {
    const selected = state.focusAgentId === s.id;
    const pct = s.pct;
    const barWidth = pct !== null ? Math.min(100, pct).toFixed(1) : '0';
    const hasMax = Boolean(s.maxTokens && s.maxTokens > 0);
    const rightText = hasMax
      ? `${fmtTok(s.usedTokens)} · ${pct.toFixed(1)}%`
      : fmtTok(s.usedTokens);
    const rightTitle = hasMax
      ? `${fmtTok(s.usedTokens)} / ${fmtMax(s.maxTokens)} (${pct.toFixed(1)}%)`
      : `${fmtTok(s.usedTokens)} / ${t('ctx.unknown')}`;
    const stText = statusText(s.status);
    const modelName = localizeModelName(s.latestModel);
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
  }

  function bindSubRowEvents(container) {
    container.querySelectorAll('.sub-row').forEach((row) => {
      const activate = () => {
        const id = row.getAttribute('data-sub-id');
        state.focusAgentId = state.focusAgentId === id ? null : id;
        if (!state.focusAgentId) state.onlyFocusedModels = false;
        state.trendHoverIdx = null;
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

  function renderContexts(focus) {
    const d = state.data;
    const m = d.main;
    const subs = d.subagents || [];
    const activeSubs = subs.filter((s) => s.status === 'running' || s.status === 'waiting');
    const idleSubs = subs.filter((s) => s.status === 'idle');

    let summaryText = '';
    if (activeSubs.length && idleSubs.length) {
      summaryText = t('ctx.summaryActiveIdle', { active: activeSubs.length, idle: idleSubs.length });
    } else if (activeSubs.length) {
      summaryText = t('ctx.summaryActive', { active: activeSubs.length });
    } else if (idleSubs.length) {
      summaryText = t('ctx.summaryIdle', { idle: idleSubs.length });
    }
    $('session-summary').textContent = summaryText;

    const displayModel = m.sessionModel || m.latestModel;
    $('main-model').textContent = shortModel(displayModel);
    $('main-model').title = (m.lastCallModel && m.lastCallModel !== displayModel)
      ? t('ctx.lastCallTip', { display: displayModel, last: m.lastCallModel })
      : (displayModel || '');

    const mPct = m.pct;
    const hasMax = m.maxTokens && m.maxTokens > 0;
    const isCompacted = m.compaction?.state === 'compacted';
    const ratioPrefix = isCompacted ? '≈ ' : '';
    const ratioStr = hasMax
      ? `${ratioPrefix}${fmtTok(m.usedTokens)} / ${fmtMax(m.maxTokens)} (${mPct.toFixed(1)}%)`
      : `${ratioPrefix}${fmtTok(m.usedTokens)} / ${t('ctx.unknown')}`;
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
        ? t('ctx.compactedSplitPre', { pre: fmtTok(preTok) })
        : t('ctx.compactedSplit');
      const splitTip = t('ctx.compactedTip', { used: fmtTok(m.usedTokens) });
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
      const splitTitle = t('ctx.splitTip', {
        cached: fmtTok(m.cachedTokens),
        fresh: fmtTok(m.freshTokens),
        est: fmtTok(estDelta),
        total: fmtTok(m.usedTokens),
      });
      $('main-progress-track').title = splitTitle;
      $('main-split').title = splitTitle;
      $('main-split').textContent = t('ctx.cacheFresh', {
        cached: fmtTok(m.cachedTokens),
        fresh: fmtTok(m.freshTokens),
      });
    }

    const thinkEl = $('main-think');
    if (m.thinkPct !== null && m.thinkPct !== undefined) {
      thinkEl.textContent = t('ctx.thinkShare', { pct: m.thinkPct });
      thinkEl.title = t('ctx.thinkTip', { restPct: m.responsePct });
    } else {
      thinkEl.textContent = t('ctx.thinkEmpty');
      thinkEl.title = t('ctx.thinkEmptyTip');
    }

    $('main-remaining').textContent = t('ctx.remaining', {
      val: m.remainingTokens !== null ? fmtTok(m.remainingTokens) : '—',
    });
    updateCacheCountdown();

    const visibleCount = activeSubs.length + idleSubs.length;
    $('main-card').classList.toggle('is-selected', Boolean(visibleCount > 0 && (!state.focusAgentId || state.focusAgentId === m.id)));

    // Subagents (active expanded, idle collapsed by default, killed hidden)
    $('sub-section').classList.toggle('hidden', visibleCount === 0);

    const activeWrap = $('sub-active-wrap');
    const subList = $('sub-list');
    if (!activeSubs.length) {
      activeWrap.classList.add('hidden');
      subList.innerHTML = '';
    } else {
      activeWrap.classList.remove('hidden');
      $('sub-count').textContent = String(activeSubs.length);
      subList.innerHTML = activeSubs.map(renderSubRow).join('');
      bindSubRowEvents(subList);
    }

    const idleWrap = $('sub-idle-wrap');
    const idleList = $('sub-idle-list');
    if (!idleSubs.length) {
      state.showIdleSubs = false;
      idleWrap.classList.add('hidden');
      idleList.classList.add('hidden');
      idleList.innerHTML = '';
    } else {
      idleWrap.classList.remove('hidden');
      $('sub-idle-label').textContent = t('ctx.completedSubs', { count: idleSubs.length });
      $('sub-idle-caret').textContent = state.showIdleSubs ? '▾' : '▸';
      $('sub-idle-toggle').setAttribute('aria-expanded', String(state.showIdleSubs));
      idleList.classList.toggle('hidden', !state.showIdleSubs);
      if (state.showIdleSubs) {
        idleList.innerHTML = idleSubs.map(renderSubRow).join('');
        bindSubRowEvents(idleList);
      } else {
        idleList.innerHTML = '';
      }
    }

    $('focus-bar').classList.toggle('hidden', Boolean(!focus || focus.isMain));
    if (focus && !focus.isMain) {
      $('focus-name').textContent = focus.label || t('ctx.subagentDefault');
      $('focus-name').title = focus.label || t('ctx.subagentDefault');
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
      card.innerHTML = `<div class="section-note">${esc(t('quota.empty'))}</div>`;
      return;
    }

    card.innerHTML = pools.map((p) => {
      const buckets = Array.isArray(p.buckets) && p.buckets.length
        ? p.buckets
        : [{ window: '5h', label: '5h', remainingFraction: p.remainingFraction, resetTime: p.resetTime, description: '' }];

      const bucketsHtml = buckets.map((b) => {
        const hasFrac = b.remainingFraction !== null && b.remainingFraction !== undefined;
        const remPct = hasFrac ? b.remainingFraction * 100 : null;
        const usedPct = hasFrac ? Math.max(0, 100 - remPct) : null;
        const displayPct = isUsed ? usedPct : remPct;
        const valText = displayPct === null
          ? '—'
          : (isUsed ? t('quota.usedPrefix', { pct: displayPct.toFixed(1) }) : `${displayPct.toFixed(1)}%`);
        const cd = fmtResetCountdown(b.resetTime);
        const barWidth = displayPct !== null ? Math.min(100, Math.max(0, displayPct)).toFixed(1) : '0';
        const barColor = quotaBarColor(b.remainingFraction, isUsed);

        const winName = b.window === '5h'
          ? t('quota.win5h')
          : (b.window === 'weekly' ? t('quota.winWeekly') : (b.label || ''));
        const winShort = b.window === '5h'
          ? t('quota.win5hShort')
          : (b.window === 'weekly' ? t('quota.winWeeklyShort') : (b.label || winName));
        const pctDetail = displayPct === null
          ? t('quota.noData')
          : (isUsed ? t('quota.usedPrefix', { pct: displayPct.toFixed(1) }) : t('quota.remPrefix', { pct: displayPct.toFixed(1) }));
        const localReset = fmtLocalResetTime(b.resetTime);
        const resetDetail = localReset ? ` · ${t('quota.resetAt', { time: localReset })}` : '';
        const descDetail = b.description ? `\n${b.description}` : '';
        const rowTitle = `${winName}: ${pctDetail}${resetDetail}${descDetail}`;

        return `
          <div class="quota-bucket-row" title="${esc(rowTitle)}">
            <span class="quota-bucket-win">${esc(winShort)}</span>
            <div class="progress-track slim">
              <div class="progress-seg" style="width: ${barWidth}%; background: ${barColor};"></div>
            </div>
            <span class="quota-bucket-val tabular-nums">${esc(valText)}${cd ? ` <span class="quota-reset">· ${esc(cd)}</span>` : ''}</span>
          </div>
        `;
      }).join('');

      return `
        <div class="quota-pool">
          <div class="quota-row-top" title="${esc(p.description || '')}">
            <div class="quota-pool-left">
              <span class="agent-name">${esc(p.name)}</span>
              <span class="quota-pool-models">${esc(p.modelsSummary || '')}</span>
            </div>
          </div>
          <div class="quota-buckets">
            ${bucketsHtml}
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
      el.textContent = t('usage.noData');
      return;
    }
    const idx = state.usageHoverIdx;
    const b = (idx !== null && bars[idx]) ? bars[idx] : bars[bars.length - 1];
    const bm = barMetrics(b, rates);
    el.textContent = t('usage.readout', {
      label: b.label,
      tok: fmtTok(bm.totalTok),
      usd: fmtUsd(bm.totalUsd),
      inp: fmtTok(b.inp),
      cache: fmtTok(b.cache),
      out: fmtTok(b.out),
    });
  }

  function renderUsageSummary(ds) {
    const hitText = t('usage.cacheHit', { pct: (ds.cacheHitPct ?? 0).toFixed(1) });
    if (state.usageMode === 'usd') {
      $('usage-hero-primary').textContent = fmtUsd(ds.totalUsd);
      $('usage-hero-unit').textContent = t('usage.apiEquiv');
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
  }

  function resetUsageSummary() {
    $('usage-hero-primary').textContent = '—';
    $('usage-hero-unit').textContent = state.usageMode === 'usd' ? t('usage.apiEquiv') : 'tokens';
    $('usage-hero-meta').textContent = '—';
    $('usage-main-in').textContent = '—';
    $('usage-sub-in').textContent = '—';
    $('usage-main-cache').textContent = '—';
    $('usage-sub-cache').textContent = '—';
    $('usage-main-out').textContent = '—';
    $('usage-sub-out').textContent = '—';
  }

  function renderUsageModels(modelsList, emptyKey) {
    const modelsWrap = $('usage-models');
    const models = [...(modelsList || [])].sort((a, b) => modelValue(b) - modelValue(a)).slice(0, 8);
    if (!models.length) {
      modelsWrap.innerHTML = `<div class="section-note">${esc(t(emptyKey))}</div>`;
      return;
    }
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

  function renderUsageFooter(dateStr) {
    const footer = $('usage-footer');
    if (!footer) return;
    footer.classList.remove('hidden');
    footer.textContent = dateStr
      ? t('usage.pricingFooter', { date: dateStr })
      : t('usage.pricingFooterNoDate');
  }

  function renderUsage() {
    document.querySelectorAll('.uscope-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.uscope === state.usageScope);
    });
    document.querySelectorAll('.umode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.umode === state.usageMode);
    });
    document.querySelectorAll('.urange-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.urange === state.usageRange);
    });

    const isSession = state.usageScope === 'session';
    $('usage-range-group')?.classList.toggle('hidden', isSession);
    $('usage-session-note')?.classList.toggle('hidden', !isSession);
    $('usage-chart-wrap')?.classList.toggle('hidden', isSession);

    const sc = state.data?.sessionCost || null;
    const u = state.usageData;

    if (isSession) {
      const noteEl = $('usage-session-note');
      if (noteEl) {
        noteEl.textContent = sc && sc.subagentCount > 0
          ? t('usage.sessionScopeNote', { count: sc.subagentCount })
          : t('usage.sessionScopeMainOnly');
      }

      if (!sc || !sc.calls) {
        resetUsageSummary();
        $('session-split')?.classList.add('hidden');
        $('usage-models').innerHTML = `<div class="section-note">${esc(t('usage.noSessionData'))}</div>`;
        renderUsageFooter(sc?.pricingUpdatedAt || u?.pricingUpdatedAt || '');
        return;
      }

      renderUsageSummary(sc);

      const splitEl = $('session-split');
      if (splitEl) {
        if (sc.subagentCount > 0) {
          const isUsd = state.usageMode === 'usd';
          const mainVal = isUsd ? sc.mainUsd : sc.mainTok;
          const subsVal = isUsd ? sc.subagentsUsd : sc.subagentsTok;
          const totalSplit = mainVal + subsVal;
          const mainPct = totalSplit > 0 ? (mainVal / totalSplit) * 100 : 100;
          const subsPct = Math.max(0, 100 - mainPct);
          splitEl.classList.remove('hidden');
          $('session-split-main-bar').style.width = `${mainPct.toFixed(1)}%`;
          $('session-split-subs-bar').style.width = `${subsPct.toFixed(1)}%`;
          $('session-split-main-text').textContent = t('usage.sessionSplitMain', {
            tok: fmtTok(sc.mainTok),
            usd: fmtUsd(sc.mainUsd),
          });
          $('session-split-subs-text').textContent = t('usage.sessionSplitSubs', {
            tok: fmtTok(sc.subagentsTok),
            usd: fmtUsd(sc.subagentsUsd),
          });
        } else {
          splitEl.classList.add('hidden');
        }
      }

      renderUsageModels(sc.models, 'usage.noSessionData');
      renderUsageFooter(sc.pricingUpdatedAt || u?.pricingUpdatedAt || '');
      return;
    }

    $('session-split')?.classList.add('hidden');
    if (!u || !u.ready) {
      resetUsageSummary();
      $('usage-bars').innerHTML = '';
      $('usage-axis').innerHTML = '';
      $('usage-readout').textContent = t('usage.noData');
      $('usage-models').innerHTML = `<div class="section-note">${esc(t('usage.noData'))}</div>`;
      if (sc?.pricingUpdatedAt) {
        renderUsageFooter(sc.pricingUpdatedAt);
      } else {
        $('usage-footer')?.classList.add('hidden');
      }
      return;
    }

    const rangeKey = state.usageRange === '7d' ? 'd7' : (state.usageRange === '30d' ? 'd30' : 'today');
    const ds = u[rangeKey];
    if (!ds) return;

    const rates = {
      rIn: ds.inp > 0 ? ds.inUsd / (ds.inp / 1e6) : 0,
      rCache: ds.cache > 0 ? ds.cacheUsd / (ds.cache / 1e6) : 0,
      rOut: ds.out > 0 ? ds.outUsd / (ds.out / 1e6) : 0,
    };

    renderUsageSummary(ds);

    const bars = ds.bars || [];
    const metricsList = bars.map((b) => barMetrics(b, rates));
    const maxVal = Math.max(1e-9, ...metricsList.map((m) => m.val));
    const barsEl = $('usage-bars');
    barsEl.innerHTML = bars.map((b, i) => {
      const bm = metricsList[i];
      const totalH = bm.val > 0 ? Math.max(3, Math.round((bm.val / maxVal) * 58)) : 2;
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
    renderUsageModels(ds.models, 'usage.noModels');
    renderUsageFooter(u.pricingUpdatedAt || sc?.pricingUpdatedAt || '');
  }

  function renderTrendReadout(hist) {
    const el = $('trend-readout');
    if (!el) return;
    if (!hist || !hist.length) {
      el.textContent = t('trend.readoutEmpty');
      return;
    }
    const idx = (state.trendHoverIdx !== null && hist[state.trendHoverIdx])
      ? state.trendHoverIdx
      : hist.length - 1;
    const h = hist[idx];
    const deltaStr = fmtDelta(Number.isFinite(h.deltaTokens) ? h.deltaTokens : 0);
    const speedStr = (h.speed !== null && h.speed !== undefined)
      ? `${h.speed.toFixed(1)} tok/s`
      : '—';
    el.textContent = t('trend.readout', {
      step: h.stepIndex,
      model: h.model || '—',
      ctx: fmtTok(h.usedTokens),
      delta: deltaStr,
      out: fmtTok(h.outputTokens),
      speed: speedStr,
      ttft: fmtTtft(h.ttftSec),
    });
  }

  function renderTrend(focus) {
    if (!focus) return;
    $('trend-focus-bar').classList.toggle('hidden', Boolean(focus.isMain));
    $('trend-focus-label').textContent = focus.label || t('ctx.main');
    $('trend-focus-label').title = focus.label || t('ctx.main');

    const svg = $('trend-chart');
    const hist = focus.history || [];
    if (state.trendHoverIdx !== null && state.trendHoverIdx >= hist.length) {
      state.trendHoverIdx = null;
    }

    if (!hist.length) {
      svg.innerHTML = `<text x="190" y="60" text-anchor="middle" fill="var(--cm-fg-muted)" font-size="12">${esc(t('trend.noHistory'))}</text>`;
      svg.onmouseleave = null;
      renderTrendReadout([]);
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

      const compactMarkers = pts.map(([x], i) => {
        if (!hist[i]?.compactedBefore) return '';
        const lx = x.toFixed(1);
        const labelX = Math.min(350, Math.max(24, x));
        return `
          <line x1="${lx}" y1="10" x2="${lx}" y2="100" stroke="var(--cm-primary)" stroke-width="1" stroke-dasharray="2 2" opacity="0.7" />
          <text x="${labelX.toFixed(1)}" y="112" text-anchor="middle" fill="var(--cm-primary)" font-size="8">${esc(t('trend.compactMarker'))}</text>
        `;
      }).join('');

      const dots = pts.map(([x, y], i) => {
        const isSpike = Number(hist[i]?.deltaTokens) >= SPIKE_DELTA_TOKENS;
        const fill = isSpike ? 'var(--cm-warning)' : 'var(--cm-chart-1)';
        const r = isSpike ? '3.6' : '2.8';
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" />`;
      }).join('');

      const hits = pts.map(([x], i) => {
        const prevX = i === 0 ? 0 : (pts[i - 1][0] + x) / 2;
        const nextX = i === pts.length - 1 ? 380 : (x + pts[i + 1][0]) / 2;
        const w = Math.max(4, nextX - prevX);
        return `<rect class="trend-hit" data-idx="${i}" x="${prevX.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="116" fill="transparent" />`;
      }).join('');

      svg.innerHTML = `
        <line x1="12" y1="${warnY.toFixed(1)}" x2="368" y2="${warnY.toFixed(1)}" stroke="var(--cm-warning)" stroke-width="1" stroke-dasharray="4 3" opacity="0.75" />
        ${compactMarkers}
        ${area ? `<polygon points="${area}" fill="var(--cm-chart-1)" opacity="0.16" />` : ''}
        ${pts.length > 1 ? `<polyline points="${poly}" fill="none" stroke="var(--cm-chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ''}
        ${dots}
        ${hits}
      `;

      svg.querySelectorAll('.trend-hit').forEach((hit) => {
        hit.addEventListener('mouseenter', () => {
          state.trendHoverIdx = Number(hit.getAttribute('data-idx'));
          renderTrendReadout(hist);
        });
      });
      svg.onmouseleave = () => {
        state.trendHoverIdx = null;
        renderTrendReadout(hist);
      };
      renderTrendReadout(hist);
    }

    const bdCard = $('breakdown-card');
    const groups = focus.tokenBreakdown || [];
    if (!groups.length) {
      bdCard.classList.add('hidden');
    } else {
      bdCard.classList.remove('hidden');
      const denom = focus.usedTokens || groups.reduce((s, g) => s + g.numTokens, 0) || 1;
      $('breakdown-total').textContent = t('trend.breakdownTotal', { total: fmtTok(denom) });
      $('breakdown-list').innerHTML = groups.map((g) => {
        const pct = Math.min(100, (g.numTokens / denom) * 100);
        const name = groupLabel(g.name);
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
      tbody.innerHTML = `<div class="empty-card">${esc(t('trend.noRows'))}</div>`;
    } else {
      tbody.innerHTML = rows.map((r) => {
        const deltaVal = Number.isFinite(r.deltaTokens) ? r.deltaTokens : 0;
        const deltaStr = fmtDelta(deltaVal);
        const isSpike = deltaVal >= SPIKE_DELTA_TOKENS;
        const ttftStr = fmtTtft(r.ttftSec);
        const speedStr = (r.speed !== null && r.speed !== undefined) ? r.speed.toFixed(1) : '—';
        const speedUnit = (r.speed !== null && r.speed !== undefined) ? `${r.speed.toFixed(1)} tok/s` : '—';
        const rowTitle = t('trend.rowTip', {
          step: r.stepIndex,
          model: r.model || '—',
          ctx: fmtTok(r.usedTokens),
          delta: deltaStr,
          out: fmtTok(r.outputTokens),
          ttft: ttftStr,
          speed: speedUnit,
        });
        const ctxTitle = isSpike ? t('trend.spikeTip', { delta: deltaStr }) : rowTitle;
        return `
          <div class="table-row" title="${esc(rowTitle)}">
            <span>#${r.stepIndex}</span>
            <span class="table-model" title="${esc(r.model)}">${esc(shortModel(r.model))}</span>
            <span class="text-right ${isSpike ? 'delta-spike' : ''}" title="${esc(ctxTitle)}">${fmtTok(r.usedTokens)}</span>
            <span class="text-right">${ttftStr}</span>
            <span class="text-right">${speedStr}</span>
          </div>
        `;
      }).join('');
    }
  }

  function render() {
    renderLiveStatus();
    renderTabs();

    const verEl = $('app-version');
    if (verEl && state.data?.version) {
      verEl.textContent = `v${state.data.version}`;
    }

    const banner = $('state-banner');
    if (state.error) {
      banner.classList.remove('hidden');
      banner.classList.add('is-err');
      banner.textContent = t('banner.fetchErr', { err: state.error });
    } else if (state.data && !state.data.ready) {
      banner.classList.remove('hidden', 'is-err');
      banner.textContent = state.data.noConv ? t('banner.noConv') : (state.data.error || t('banner.waiting'));
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('is-err');
    }

    if (state.tab === 'usage') {
      renderUsage();
      return;
    }

    if (!state.data?.ready || !state.data.main) {
      if ($('main-split')) $('main-split').textContent = t('ctx.cacheFresh', { cached: '—', fresh: '—' });
      if ($('main-remaining')) $('main-remaining').textContent = t('ctx.remaining', { val: '—' });
      return;
    }
    const focus = getFocusedAgent();
    if (state.tab === 'overview') {
      renderQuota();
      renderModels(focus);
      renderContexts(focus);
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
        if (state.tab === 'usage') renderUsage();
      }
    } catch {
      // Non-fatal; retry on next trigger
    } finally {
      state.usageInFlight = false;
    }
  }

  async function fetchMetrics({ forceQuota = false } = {}) {
    if (!forceQuota && (state.inFlight || document.hidden)) return;
    const conv = currentConv();
    if (!conv) {
      state.data = { ready: false, noConv: true };
      render();
      return;
    }

    const wasInFlight = state.inFlight;
    state.inFlight = true;
    const hadError = Boolean(state.error);
    try {
      const q = new URLSearchParams({ conversationId: conv });
      if (!forceQuota && state.etag) q.set('etag', state.etag);
      if (forceQuota) q.set('refreshQuota', '1');
      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await fetcher(`/api/metrics?${q.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      state.error = '';

      if (payload.unchanged && !hadError && !forceQuota) {
        if (state.tab === 'overview' && Date.now() - state.lastQuotaResetRefreshAt > 30_000) {
          renderQuota();
        }
        if (state.tab === 'usage' && state.usageScope === 'all' && Date.now() - state.lastUsageFetchAt > USAGE_FALLBACK_MS) {
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
      if (callsChanged) {
        state.lastUsageCalls = curCalls;
      }
      if (state.tab === 'usage' && state.usageScope === 'all' && (callsChanged || Date.now() - state.lastUsageFetchAt > USAGE_FALLBACK_MS)) {
        void fetchUsage(callsChanged);
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      render();
    } finally {
      if (!wasInFlight) state.inFlight = false;
      scheduleNextPoll();
    }
  }

  // ---------- events ----------
  $('lang-toggle')?.addEventListener('click', () => {
    const next = i18n().getLang() === 'zh' ? 'en' : 'zh';
    i18n().setLang(next);
    i18n().applyDomI18n();
    render();
  });

  $('tab-overview').addEventListener('click', () => { state.tab = 'overview'; render(); });
  $('tab-trend').addEventListener('click', () => { state.tab = 'trend'; render(); });
  $('tab-usage').addEventListener('click', () => {
    state.tab = 'usage';
    render();
    void fetchUsage(false);
  });
  $('scope-toggle').addEventListener('click', () => {
    state.onlyFocusedModels = !state.onlyFocusedModels;
    render();
  });

  const resetFocus = () => {
    state.focusAgentId = null;
    state.onlyFocusedModels = false;
    state.trendHoverIdx = null;
    render();
  };
  $('main-card').addEventListener('click', resetFocus);
  $('main-card').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetFocus();
    }
  });
  $('focus-trend')?.addEventListener('click', () => {
    state.tab = 'trend';
    state.trendHoverIdx = null;
    render();
  });
  $('focus-reset').addEventListener('click', resetFocus);
  $('trend-reset-focus').addEventListener('click', resetFocus);
  $('sub-idle-toggle')?.addEventListener('click', () => {
    state.showIdleSubs = !state.showIdleSubs;
    render();
  });

  $('quota-refresh')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = $('quota-refresh');
    if (btn.classList.contains('is-spinning')) return;
    btn.classList.add('is-spinning');
    try {
      await fetchMetrics({ forceQuota: true });
    } finally {
      btn.classList.remove('is-spinning');
    }
  });

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

  document.querySelectorAll('.uscope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.usageScope = btn.dataset.uscope;
      savePref('agyHud.usageScope', state.usageScope);
      renderUsage();
    });
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
      if (state.tab === 'usage' || !state.usageData) {
        fetchUsage(false);
      }
    }
  });

  i18n().applyDomI18n();
  ensureCountdownTimer();
  render();
  fetchMetrics();
  fetchUsage(false);
})();
