/**
 * Pure metrics extraction and model-grouped speed aggregation for Agy HUD.
 * Zero external dependencies.
 */

function capitalizeWord(w) {
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

function isPlaceholderEnum(val) {
  return /^MODEL_PLACEHOLDER_/i.test(String(val || '').trim());
}

export function normalizeSpeedGroup(modelDisplayName) {
  const raw = String(modelDisplayName || 'Unknown').trim() || 'Unknown';

  // Unwrap Orchestrator (...) into its underlying base model family
  const orchMatch = /^Orchestrator\s*\(([^)]+)\)\s*$/i.exec(raw);
  if (orchMatch) {
    const inner = orchMatch[1].trim();
    if (/^(neon|hydrogen|carbon|argon)$/i.test(inner)) {
      return `Gemini 4 ${capitalizeWord(inner)}`;
    }
    if (/^(opus|sonnet|haiku)\b/i.test(inner)) {
      return `Claude ${inner}`;
    }
    return inner;
  }

  // Normalize lowercase/hyphenated model slugs (e.g. responseModel, modelName, Swarm modelHint)
  if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(raw)) {
    const lower = raw.toLowerCase();
    if (/^gemini-pro-orchestrator-neon\b/.test(lower)) return 'Gemini 4 Neon';
    if (/^gemini-pro-orchestrator-argon\b/.test(lower)) return 'Gemini 4 Argon';
    if (/^gemini-pro-orchestrator(?:-carbon)?(?:\b|$)/.test(lower)) return 'Gemini 4 Carbon';
    if (/^gemini-flash-worker-agy\b/.test(lower)) return 'Gemini 4 Hydrogen';

    let m = /^gemini-4-(neon|hydrogen|carbon|argon)(?:-(?:tiered-)?(?:xhigh|high|medium|low|max))?$/.exec(lower);
    if (m) return `Gemini 4 ${capitalizeWord(m[1])}`;

    m = /^gemini-([\d.]+)-flash(?:-(?:xhigh|high|medium|low|max))?$/.exec(lower);
    if (m) return `Gemini ${m[1]} Flash`;

    m = /^claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)(?:-(?:xhigh|high|medium|low|max|thinking))?$/.exec(lower);
    if (m) return `Claude ${capitalizeWord(m[1])} ${m[2]}.${m[3]}`;

    m = /^gpt-oss-(\d+b)(?:-(?:xhigh|high|medium|low|max))?$/.exec(lower);
    if (m) return `GPT-OSS ${m[1].toUpperCase()}`;
  }

  return raw.replace(/\s*\((?:XHigh|High|Medium|Low|Max|Orchestrator|Orch|Thinking)\)\s*$/i, '').trim() || raw;
}

function toNonNegInt(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * Parses proto3 JSON duration strings (e.g. "4.997653125s", "520ms") or numeric seconds.
 * Returns positive seconds as a finite number, or null if invalid / <= 0.
 */
export function parseDurationSec(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  if (s.endsWith('ms')) {
    const n = Number(s.slice(0, -2));
    return Number.isFinite(n) && n > 0 ? n / 1000 : null;
  }
  if (s.endsWith('s') && !/[a-z]/i.test(s.slice(0, -1))) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Fallback for compound durations such as "1m2.5s"
  const compound = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/i.exec(s);
  if (compound && (compound[1] || compound[2] || compound[3])) {
    const total =
      (Number(compound[1] || 0) * 3600) +
      (Number(compound[2] || 0) * 60) +
      Number(compound[3] || 0);
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  return null;
}

/**
 * Builds lookup maps for model quotas from GetCascadeModelConfigData response.
 */
export function buildQuotaIndex(modelConfigData) {
  const byEnum = new Map();
  const byId = new Map();
  const byLabel = new Map();

  const configs = Array.isArray(modelConfigData?.clientModelConfigs)
    ? modelConfigData.clientModelConfigs
    : [];

  for (const cfg of configs) {
    const modelEnum = typeof cfg?.modelOrAlias?.model === 'string' ? cfg.modelOrAlias.model : '';
    const modelId = typeof cfg?.modelId === 'string' ? cfg.modelId : '';
    const label = typeof cfg?.label === 'string' ? cfg.label : '';
    const q = cfg?.quotaInfo;
    const entry = {
      label: label || modelId || modelEnum,
      modelEnum,
      modelId,
      remainingFraction: typeof q?.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)
        ? Math.max(0, Math.min(1, q.remainingFraction))
        : null,
      resetTime: typeof q?.resetTime === 'string' && q.resetTime ? q.resetTime : null,
    };
    if (modelEnum) byEnum.set(modelEnum, entry);
    if (modelId) {
      byId.set(modelId, entry);
      byId.set(modelId.toLowerCase(), entry);
    }
    if (label) {
      byLabel.set(label, entry);
      byLabel.set(label.toLowerCase(), entry);
    }
  }

  return { byEnum, byId, byLabel };
}

/**
 * Groups model configs into real API quota pools (e.g. Gemini vs Claude & GPT).
 */
export function buildQuotaPools(modelConfigData) {
  const configs = Array.isArray(modelConfigData?.clientModelConfigs)
    ? modelConfigData.clientModelConfigs
    : [];

  const buckets = new Map();
  const ensureBucket = (id, name, modelsSummary) => {
    let b = buckets.get(id);
    if (!b) {
      b = { id, name, modelsSummary, remainingFraction: null, resetTime: null };
      buckets.set(id, b);
    }
    return b;
  };

  for (const cfg of configs) {
    const label = String(cfg?.label || '');
    const modelId = String(cfg?.modelId || '').toLowerCase();
    const q = cfg?.quotaInfo;
    const rem = typeof q?.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)
      ? Math.max(0, Math.min(1, q.remainingFraction))
      : null;
    const reset = typeof q?.resetTime === 'string' && q.resetTime ? q.resetTime : null;
    if (rem === null && !reset) continue;

    let pool;
    if (modelId.startsWith('gemini-') || /gemini|orchestrator/i.test(label)) {
      pool = ensureBucket('gemini', 'Gemini', 'Neon · Hydrogen · Carbon · Flash');
    } else if (modelId.startsWith('claude-') || modelId.startsWith('gpt-') || /claude|gpt/i.test(label)) {
      pool = ensureBucket('claude_gpt', 'Claude & GPT', 'Opus 5.5 · Sonnet 5.5 · GPT');
    } else {
      pool = ensureBucket('other', 'Other', '其他模型');
    }

    if (rem !== null && (pool.remainingFraction === null || rem < pool.remainingFraction)) {
      pool.remainingFraction = rem;
    }
    if (reset) {
      if (!pool.resetTime) {
        pool.resetTime = reset;
      } else {
        const curMs = Date.parse(pool.resetTime);
        const nextMs = Date.parse(reset);
        if (Number.isFinite(nextMs) && (!Number.isFinite(curMs) || nextMs < curMs)) {
          pool.resetTime = reset;
        }
      }
    }
  }

  const order = { gemini: 0, claude_gpt: 1, other: 2 };
  return [...buckets.values()]
    .sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
    .map((p) => ({
      ...p,
      usedFraction: p.remainingFraction !== null ? Math.max(0, 1 - p.remainingFraction) : null,
    }));
}

/**
 * Looks up quota info in priority order: modelEnum -> responseModel -> modelDisplayName.
 */
export function lookupQuota(quotaIndex, { modelEnum = '', responseModel = '', modelDisplayName = '' } = {}) {
  if (!quotaIndex) return null;
  if (modelEnum && quotaIndex.byEnum.has(modelEnum)) {
    return quotaIndex.byEnum.get(modelEnum);
  }
  if (responseModel) {
    if (quotaIndex.byId.has(responseModel)) return quotaIndex.byId.get(responseModel);
    const lower = responseModel.toLowerCase();
    if (quotaIndex.byId.has(lower)) return quotaIndex.byId.get(lower);
  }
  if (modelDisplayName) {
    if (quotaIndex.byLabel.has(modelDisplayName)) return quotaIndex.byLabel.get(modelDisplayName);
    const lower = modelDisplayName.toLowerCase();
    if (quotaIndex.byLabel.has(lower)) return quotaIndex.byLabel.get(lower);
  }
  return null;
}

export function normalizeAgentStatus(trajectoryStatus, meta = {}) {
  if (meta?.killed) return 'killed';
  const swarmState = String(meta?.swarmStatus || '').toLowerCase();
  if (swarmState === 'killed') return 'killed';

  const st = String(trajectoryStatus || '').toUpperCase();
  if (st.includes('RUNNING')) return 'running';
  if (st.includes('WAITING')) return 'waiting';
  if (st.includes('IDLE')) return swarmState === 'working' ? 'running' : 'idle';

  if (swarmState === 'working') return 'running';
  if (swarmState === 'waiting') return 'waiting';
  if (swarmState === 'stopped') return 'idle';

  const dbStatus = String(meta?.dbStatus || '').toUpperCase();
  if (dbStatus.includes('RUNNING')) return 'running';
  if (dbStatus.includes('WAITING')) return 'waiting';
  return 'idle';
}

function resolveStepMeta(steps, stepIndices) {
  if (!Array.isArray(steps) || !Array.isArray(stepIndices) || stepIndices.length === 0) {
    return { stepIndex: null, plannerStep: null, latestStep: null };
  }
  let plannerStep = null;
  let latestStep = null;
  let chosenIdx = stepIndices[stepIndices.length - 1];

  for (const idx of stepIndices) {
    const step = steps[idx];
    if (!step) continue;
    latestStep = step;
    if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      plannerStep = step;
      chosenIdx = idx;
    }
  }
  return { stepIndex: chosenIdx, plannerStep, latestStep };
}

function parseTimestampMs(step) {
  const m = step?.metadata;
  if (!m) return null;
  for (const key of ['completedAt', 'finishedGeneratingAt', 'createdAt', 'startedAt']) {
    if (typeof m[key] === 'string' && m[key]) {
      const ms = Date.parse(m[key]);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function resolveUserSelectedModel(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type !== 'CORTEX_STEP_TYPE_USER_INPUT') continue;
    const ui = step.userInput;
    const pc = ui?.userConfig?.plannerConfig;
    const lpc = ui?.lastUserConfig?.plannerConfig;
    const raw = pc?.planModel || pc?.requestedModel || lpc?.planModel || '';
    const enumStr = typeof raw === 'string' ? raw.trim() : '';
    if (enumStr) {
      return enumStr;
    }
  }
  return '';
}

function resolveAgentQuota(calls, modelHint, quotaIndex, sessionModelEnum = '') {
  if (sessionModelEnum) {
    const q = lookupQuota(quotaIndex, { modelEnum: sessionModelEnum });
    if (q) return q;
  }
  if (Array.isArray(calls)) {
    for (let i = calls.length - 1; i >= 0; i--) {
      const q = lookupQuota(quotaIndex, calls[i]);
      if (q) return q;
    }
  }
  if (modelHint) {
    return lookupQuota(quotaIndex, {
      modelEnum: modelHint,
      responseModel: modelHint,
      modelDisplayName: modelHint,
    });
  }
  return null;
}

/**
 * Updates a cached agent snapshot's quota against fresh GetCascadeModelConfigData.
 */
export function refreshAgentQuota(agentSnapshot, quotaIndex, modelHint = '') {
  if (!agentSnapshot) return null;
  let quota = resolveAgentQuota(
    agentSnapshot.calls,
    modelHint,
    quotaIndex,
    agentSnapshot.sessionModelEnum || ''
  );
  if (!quota && agentSnapshot.latestModel && agentSnapshot.latestModel !== '未调用') {
    quota = lookupQuota(quotaIndex, {
      modelEnum: agentSnapshot.latestModelEnum || '',
      modelDisplayName: agentSnapshot.latestModel,
    });
  }
  agentSnapshot.quota = quota;
  return agentSnapshot;
}

/**
 * Extracts normalized context window, usage, breakdown, compaction, and per-call speed records.
 */
function resolveReadableModelName(
  enumStr,
  quotaIndex,
  calls,
  executorMetadatas,
  sessionModelEnum,
  sessionModel
) {
  if (!enumStr) return '';
  const qEntry = lookupQuota(quotaIndex, { modelEnum: enumStr });
  if (qEntry?.label && !isPlaceholderEnum(qEntry.label)) {
    return qEntry.label;
  }
  if (Array.isArray(calls)) {
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i];
      if (c.modelEnum === enumStr && c.modelDisplayName && !isPlaceholderEnum(c.modelDisplayName)) {
        return c.modelDisplayName;
      }
    }
  }
  if (Array.isArray(executorMetadatas)) {
    for (let i = executorMetadatas.length - 1; i >= 0; i--) {
      const pc = executorMetadatas[i]?.cascadeConfig?.plannerConfig;
      if (pc?.planModel === enumStr && typeof pc.modelName === 'string' && pc.modelName.trim()) {
        return normalizeSpeedGroup(pc.modelName);
      }
    }
  }
  if (
    enumStr === sessionModelEnum &&
    sessionModel &&
    sessionModel !== '未调用' &&
    !isPlaceholderEnum(sessionModel)
  ) {
    return sessionModel;
  }
  return '';
}

export function extractAgentSnapshot(convId, trajectoryResp, meta = {}, quotaIndex = null) {
  const trajectory = trajectoryResp?.trajectory || {};
  const gms = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const executorMetadatas = Array.isArray(trajectory.executorMetadatas) ? trajectory.executorMetadatas : [];

  const calls = [];
  let rawTokenBreakdownGroups = null;
  let latestCallMaxStepIdx = -1;
  let totalThinkTokens = 0;
  let totalRespTokens = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;

  for (let callIndex = 0; callIndex < gms.length; callIndex++) {
    const gm = gms[callIndex];
    const cm = gm?.chatModel;
    if (!cm) continue;

    const u = cm.usage || {};
    const modelEnum = typeof cm.model === 'string' ? cm.model : (typeof u.model === 'string' ? u.model : '');
    const responseModel = typeof cm.responseModel === 'string' ? cm.responseModel : '';
    const matchedQuota = lookupQuota(quotaIndex, {
      modelEnum,
      responseModel,
      modelDisplayName: cm.modelDisplayName || '',
    });
    const modelDisplayName =
      cm.modelDisplayName ||
      matchedQuota?.label ||
      responseModel ||
      modelEnum ||
      'Unknown';

    const inputTokens = toNonNegInt(u.inputTokens);
    const cacheReadTokens = toNonNegInt(u.cacheReadTokens);
    const outputTokens = toNonNegInt(u.outputTokens);
    const thinkingOutputTokens = toNonNegInt(u.thinkingOutputTokens);
    let responseOutputTokens = toNonNegInt(u.responseOutputTokens);
    if (responseOutputTokens === 0 && outputTokens > 0 && thinkingOutputTokens <= outputTokens) {
      responseOutputTokens = outputTokens - thinkingOutputTokens;
    }

    const { stepIndex, plannerStep, latestStep } = resolveStepMeta(steps, gm.stepIndices);
    const stepForTime = plannerStep || latestStep;
    const parsedTs = parseTimestampMs(stepForTime);
    const timestampMs = parsedTs !== null ? parsedTs : callIndex;
    if (Array.isArray(gm.stepIndices) && gm.stepIndices.length > 0) {
      const gmMax = Math.max(...gm.stepIndices);
      if (gmMax > latestCallMaxStepIdx) latestCallMaxStepIdx = gmMax;
    } else if (stepIndex !== null && stepIndex > latestCallMaxStepIdx) {
      latestCallMaxStepIdx = stepIndex;
    }

    let streamingSec = parseDurationSec(cm.streamingDuration);
    if (streamingSec === null && plannerStep?.metadata) {
      const fin = Date.parse(plannerStep.metadata.finishedGeneratingAt || '');
      const view = Date.parse(plannerStep.metadata.viewableAt || '');
      if (Number.isFinite(fin) && Number.isFinite(view) && fin > view) {
        streamingSec = (fin - view) / 1000;
      }
    }

    const speed =
      streamingSec !== null && streamingSec > 0 && outputTokens > 0
        ? outputTokens / streamingSec
        : null;

    const cwm = cm.chatStartMetadata?.contextWindowMetadata || {};
    const rawUsed = toNonNegInt(cwm.estimatedTokensUsed);
    const usedTokens = rawUsed > 0 ? rawUsed : inputTokens + cacheReadTokens;
    const maxTokens = toNonNegInt(cwm.maxContextTokens) || null;

    if (Array.isArray(cwm.tokenBreakdown?.groups) && cwm.tokenBreakdown.groups.length > 0) {
      rawTokenBreakdownGroups = cwm.tokenBreakdown.groups
        .map((g) => ({ name: String(g.name || 'Other'), numTokens: toNonNegInt(g.numTokens) }))
        .filter((g) => g.numTokens > 0);
    }

    totalThinkTokens += thinkingOutputTokens;
    totalRespTokens += responseOutputTokens;
    totalOutputTokens += outputTokens;
    totalInputTokens += inputTokens;
    totalCacheReadTokens += cacheReadTokens;

    calls.push({
      agentId: convId,
      agentLabel: meta.label || convId.slice(0, 8),
      callIndex,
      stepIndex: stepIndex !== null ? stepIndex : callIndex,
      timestampMs,
      modelEnum,
      responseModel,
      modelDisplayName,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingOutputTokens,
      responseOutputTokens,
      streamingSec,
      speed,
      usedTokens,
      maxTokens,
    });
  }

  const latestCall = calls.length > 0 ? calls[calls.length - 1] : null;
  const sessionModelEnum = resolveUserSelectedModel(steps);

  // Latest call with input+cache > 0 for cache hit rate
  let latestCacheCall = null;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].inputTokens + calls[i].cacheReadTokens > 0) {
      latestCacheCall = calls[i];
      break;
    }
  }
  const cacheHitPct = latestCacheCall
    ? (latestCacheCall.cacheReadTokens / (latestCacheCall.inputTokens + latestCacheCall.cacheReadTokens)) * 100
    : null;

  // Latest call with output > 0 for thinking/response split (fallback to session aggregate)
  let latestOutputCall = null;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].outputTokens > 0) {
      latestOutputCall = calls[i];
      break;
    }
  }
  let thinkPct = null;
  let responsePct = null;
  if (latestOutputCall) {
    thinkPct = (latestOutputCall.thinkingOutputTokens / latestOutputCall.outputTokens) * 100;
    responsePct = Math.max(0, 100 - thinkPct);
  } else if (totalOutputTokens > 0) {
    thinkPct = (totalThinkTokens / totalOutputTokens) * 100;
    responsePct = Math.max(0, 100 - thinkPct);
  }

  const quota = resolveAgentQuota(calls, meta.modelHint, quotaIndex, sessionModelEnum);

  let sessionModel = '';
  if (sessionModelEnum) {
    const qEntry = lookupQuota(quotaIndex, { modelEnum: sessionModelEnum });
    if (qEntry?.label && !/^MODEL_PLACEHOLDER_/i.test(qEntry.label)) {
      sessionModel = qEntry.label;
    }
    if (!sessionModel) {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if (
          c.modelEnum === sessionModelEnum &&
          c.modelDisplayName &&
          !/^MODEL_PLACEHOLDER_/i.test(c.modelDisplayName)
        ) {
          sessionModel = c.modelDisplayName;
          break;
        }
      }
    }
    if (!sessionModel) {
      sessionModel = qEntry?.label || meta.modelHint || sessionModelEnum;
    }
  } else {
    sessionModel = latestCall ? latestCall.modelDisplayName : (quota?.label || meta.modelHint || '未调用');
  }

  const lastCallModel = latestCall ? latestCall.modelDisplayName : '';
  const effectiveModelEnum = sessionModelEnum || (latestCall?.modelEnum || '');

  let usedTokens = latestCall ? latestCall.usedTokens : 0;
  const maxTokens = latestCall ? latestCall.maxTokens : null;
  let pct = maxTokens && maxTokens > 0 ? Number(((usedTokens / maxTokens) * 100).toFixed(1)) : null;
  let cachedTokens = latestCall ? latestCall.cacheReadTokens : 0;
  let freshTokens = latestCall ? latestCall.inputTokens : 0;
  let remainingTokens = maxTokens && maxTokens > 0 ? Math.max(0, maxTokens - usedTokens) : null;
  let lastCallTimestampMs =
    latestCall && Number.isFinite(latestCall.timestampMs) && latestCall.timestampMs > 1_000_000_000_000
      ? latestCall.timestampMs
      : null;

  let latestTokenBreakdown = rawTokenBreakdownGroups
    ? [...rawTokenBreakdownGroups].sort((a, b) => b.numTokens - a.numTokens).slice(0, 6)
    : null;

  // Detect in-progress or just-completed /compact checkpoint after the latest generator call
  let compaction = null;
  const searchAfterStepIdx = latestCall
    ? Math.max(latestCall.stepIndex, latestCallMaxStepIdx)
    : -1;
  for (let cpIdx = steps.length - 1; cpIdx > searchAfterStepIdx; cpIdx--) {
    const step = steps[cpIdx];
    if (step?.type !== 'CORTEX_STEP_TYPE_CHECKPOINT') continue;
    const cpStatus = String(step.status || '').toUpperCase();
    if (cpStatus === 'CORTEX_STEP_STATUS_DONE') {
      const systemTokens = rawTokenBreakdownGroups
        ? rawTokenBreakdownGroups
            .filter((g) => g.name !== 'Chat Messages')
            .reduce((sum, g) => sum + g.numTokens, 0)
        : 0;
      const usageOut = toNonNegInt(step.metadata?.modelUsage?.outputTokens);
      const summaryTokens = usageOut > 0
        ? usageOut
        : Math.round(String(step.checkpoint?.sessionSummary || '').length / 3.5);
      const estimatedTokens = systemTokens + summaryTokens;

      compaction = {
        state: 'compacted',
        stepIndex: cpIdx,
        completedAtMs: parseTimestampMs(step),
        preCompactTokens: latestCall ? latestCall.usedTokens : null,
        estimatedTokens,
        summaryTokens,
      };

      usedTokens = estimatedTokens;
      pct = maxTokens && maxTokens > 0 ? Number(((estimatedTokens / maxTokens) * 100).toFixed(1)) : null;
      cachedTokens = 0;
      freshTokens = estimatedTokens;
      remainingTokens = maxTokens && maxTokens > 0 ? Math.max(0, maxTokens - estimatedTokens) : null;
      lastCallTimestampMs = null;

      if (rawTokenBreakdownGroups) {
        const nextGroups = rawTokenBreakdownGroups.filter((g) => g.name !== 'Chat Messages');
        if (summaryTokens > 0) {
          nextGroups.push({ name: 'Chat Messages', numTokens: summaryTokens });
        }
        latestTokenBreakdown = nextGroups
          .sort((a, b) => b.numTokens - a.numTokens)
          .slice(0, 6);
      }
    } else if (!cpStatus.includes('ERROR') && !cpStatus.includes('CANCEL') && !cpStatus.includes('FAIL')) {
      compaction = {
        state: 'running',
        stepIndex: cpIdx,
        startedAtMs: parseTimestampMs(step),
        preCompactTokens: latestCall ? latestCall.usedTokens : null,
        estimatedTokens: null,
        summaryTokens: null,
      };
    }
    break;
  }

  const status = normalizeAgentStatus(trajectoryResp?.status, meta);
  const isRunning = status === 'running' || compaction?.state === 'running';
  let activeModel = '';
  let activeModelEnum = '';

  if (isRunning) {
    let latestUserInputIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        latestUserInputIdx = i;
        break;
      }
    }

    let foundStepEnum = '';
    let resolvedStepModel = '';
    for (let i = steps.length - 1; i > latestUserInputIdx; i--) {
      const step = steps[i];
      const stepEnum = String(step?.metadata?.generatorModel || step?.metadata?.modelUsage?.model || '').trim();
      if (stepEnum) {
        foundStepEnum = stepEnum;
        resolvedStepModel = resolveReadableModelName(
          stepEnum,
          quotaIndex,
          calls,
          executorMetadatas,
          sessionModelEnum,
          sessionModel
        );
        break;
      }
    }

    if (resolvedStepModel) {
      activeModel = resolvedStepModel;
      activeModelEnum = foundStepEnum;
    } else if (
      !foundStepEnum &&
      latestCall &&
      latestCallMaxStepIdx > latestUserInputIdx &&
      latestCall.modelDisplayName &&
      !isPlaceholderEnum(latestCall.modelDisplayName)
    ) {
      activeModel = latestCall.modelDisplayName;
      activeModelEnum = latestCall.modelEnum || '';
    } else if (
      !foundStepEnum &&
      sessionModel &&
      sessionModel !== '未调用' &&
      !isPlaceholderEnum(sessionModel)
    ) {
      activeModel = sessionModel;
      activeModelEnum = effectiveModelEnum;
    }
  }

  const history = calls.slice(-24).map((c) => ({
    callIndex: c.callIndex,
    stepIndex: c.stepIndex,
    usedTokens: c.usedTokens,
    maxTokens: c.maxTokens,
    outputTokens: c.outputTokens,
    streamingSec: c.streamingSec,
    speed: c.speed !== null ? Number(c.speed.toFixed(1)) : null,
    model: c.modelDisplayName,
  }));

  return {
    id: convId,
    label: meta.label || (meta.isMain ? '主会话' : `subagent-${convId.slice(0, 8)}`),
    role: meta.role || (meta.isMain ? 'coordinator' : 'subagent'),
    source: meta.source || (meta.isMain ? 'main' : 'subagent'),
    status,
    isMain: Boolean(meta.isMain),
    sessionModel,
    sessionModelEnum: effectiveModelEnum,
    activeModel,
    activeModelEnum,
    lastCallModel,
    latestModel: sessionModel,
    latestModelEnum: effectiveModelEnum,
    compaction,
    lastCallTimestampMs,
    usedTokens,
    maxTokens,
    pct,
    cachedTokens,
    freshTokens,
    remainingTokens,
    cacheHitPct: cacheHitPct !== null ? Number(cacheHitPct.toFixed(1)) : null,
    thinkPct: thinkPct !== null ? Math.round(thinkPct) : null,
    responsePct: responsePct !== null ? Math.round(responsePct) : null,
    quota,
    tokenBreakdown: latestTokenBreakdown,
    callCount: calls.length,
    totals: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      thinkingOutputTokens: totalThinkTokens,
      responseOutputTokens: totalRespTokens,
    },
    history,
    calls,
  };
}

/**
 * Aggregates call-level token speeds across a list of agents, grouped by normalized model name.
 */
export function aggregateModelSpeeds(agents, quotaIndex = null) {
  const groups = new Map();

  for (const agent of agents) {
    const agentCalls = Array.isArray(agent?.calls) ? agent.calls : [];
    for (const c of agentCalls) {
      const key = normalizeSpeedGroup(c.modelDisplayName);
      let grp = groups.get(key);
      if (!grp) {
        grp = {
          model: key,
          modelEnum: c.modelEnum || '',
          responseModel: c.responseModel || '',
          modelEnumSet: new Set(),
          variantSet: new Set(),
          allCalls: [],
          validCalls: [],
          totalOutputTokens: 0,
          agentIdSet: new Set(),
          agentLabelSet: new Set(),
          isActive: false,
          activeAgentLabelSet: new Set(),
        };
        groups.set(key, grp);
      }
      if (!grp.modelEnum && c.modelEnum) grp.modelEnum = c.modelEnum;
      if (!grp.responseModel && c.responseModel) grp.responseModel = c.responseModel;
      if (c.modelEnum) grp.modelEnumSet.add(c.modelEnum);
      if (c.modelDisplayName) grp.variantSet.add(c.modelDisplayName);
      grp.allCalls.push(c);
      grp.totalOutputTokens += c.outputTokens;
      grp.agentIdSet.add(c.agentId);
      grp.agentLabelSet.add(c.agentLabel);
      if (c.speed !== null && Number.isFinite(c.speed) && c.streamingSec > 0 && c.outputTokens > 0) {
        grp.validCalls.push(c);
      }
    }
  }

  for (const agent of agents) {
    const running = agent?.status === 'running' || agent?.compaction?.state === 'running';
    if (!running) continue;
    const rawActive = agent.activeModel || agent.sessionModel || agent.latestModel || '';
    if (!rawActive || rawActive === '未调用' || rawActive === 'Unknown' || isPlaceholderEnum(rawActive)) {
      continue;
    }
    const key = normalizeSpeedGroup(rawActive);
    let grp = groups.get(key);
    const activeEnum = agent.activeModelEnum || agent.sessionModelEnum || '';
    if (!grp) {
      grp = {
        model: key,
        modelEnum: activeEnum,
        responseModel: '',
        modelEnumSet: new Set(activeEnum ? [activeEnum] : []),
        variantSet: new Set([rawActive]),
        allCalls: [],
        validCalls: [],
        totalOutputTokens: 0,
        agentIdSet: new Set(agent.id ? [agent.id] : []),
        agentLabelSet: new Set(agent.label ? [agent.label] : []),
        isActive: false,
        activeAgentLabelSet: new Set(),
      };
      groups.set(key, grp);
    } else {
      if (activeEnum) grp.modelEnumSet.add(activeEnum);
      grp.variantSet.add(rawActive);
      if (agent.id) grp.agentIdSet.add(agent.id);
      if (agent.label) grp.agentLabelSet.add(agent.label);
    }
    grp.isActive = true;
    grp.activeAgentLabelSet.add(agent.label || agent.id || '主会话');
  }

  const out = [];
  for (const grp of groups.values()) {
    grp.validCalls.sort((a, b) => (a.timestampMs - b.timestampMs) || (a.callIndex - b.callIndex));
    grp.allCalls.sort((a, b) => (a.timestampMs - b.timestampMs) || (a.callIndex - b.callIndex));

    const valid = grp.validCalls;
    const latestValid = valid.length > 0 ? valid[valid.length - 1] : null;
    const latestAny = grp.allCalls.length > 0 ? grp.allCalls[grp.allCalls.length - 1] : null;

    const recent20 = valid.slice(-20);
    let recentOut = 0;
    let recentSec = 0;
    for (const c of recent20) {
      recentOut += c.outputTokens;
      recentSec += c.streamingSec;
    }

    const avgSpeed = recentSec > 0 ? recentOut / recentSec : null;
    const variants = [...grp.variantSet];
    const quota =
      lookupQuota(quotaIndex, {
        modelEnum: grp.modelEnum,
        responseModel: grp.responseModel,
        modelDisplayName: grp.model,
      }) ||
      (variants.length > 0 ? lookupQuota(quotaIndex, { modelDisplayName: variants[0] }) : null);

    out.push({
      model: grp.model,
      modelEnum: grp.modelEnum,
      modelEnums: [...grp.modelEnumSet],
      variants,
      isActive: Boolean(grp.isActive),
      activeAgents: [...grp.activeAgentLabelSet],
      totalCalls: grp.allCalls.length,
      totalOutputTokens: grp.totalOutputTokens,
      lastTimestampMs: latestValid ? latestValid.timestampMs : (latestAny ? latestAny.timestampMs : 0),
      last: latestValid
        ? {
            speed: Number(latestValid.speed.toFixed(1)),
            outputTokens: latestValid.outputTokens,
            streamingSec: Number(latestValid.streamingSec.toFixed(2)),
            agentId: latestValid.agentId,
            agentLabel: latestValid.agentLabel,
            timestampMs: latestValid.timestampMs,
          }
        : null,
      avg20: avgSpeed !== null
        ? {
            speed: Number(avgSpeed.toFixed(1)),
            sampleCount: recent20.length,
            totalOutputTokens: recentOut,
            totalStreamingSec: Number(recentSec.toFixed(2)),
          }
        : null,
      agentIds: [...grp.agentIdSet],
      agentLabels: [...grp.agentLabelSet],
      quota,
    });
  }

  out.sort(
    (a, b) =>
      (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) ||
      (b.lastTimestampMs - a.lastTimestampMs) ||
      (b.totalCalls - a.totalCalls)
  );
  return out;
}
