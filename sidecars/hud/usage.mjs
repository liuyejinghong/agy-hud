/**
 * Local Antigravity Desktop transcript scanner and API USD pricing aggregator.
 * Scans ONLY <appData>/brain/<convId>/.system_generated/logs/transcript.jsonl.
 * Zero external dependencies; unchanged files are cached by mtimeMs:size.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_PRICING = {
  default: {
    displayName: '{raw}',
    rates: { input: 1.50, cacheRead: 0.075, output: 7.50 },
  },
  rules: [],
};

const TIER_MAP = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function safeStatFp(p) {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addLocalDays(baseDate, deltaDays) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + deltaDays);
  return d;
}

const pricingFileCache = new Map(); // path -> { fp, data }

export function loadPricing(pricingPath) {
  if (!pricingPath) return { fp: 'builtin', data: FALLBACK_PRICING };
  const fp = safeStatFp(pricingPath);
  if (!fp) return { fp: 'builtin', data: FALLBACK_PRICING };
  const cached = pricingFileCache.get(pricingPath);
  if (cached && cached.fp === fp) return { fp, data: cached.data };
  try {
    const parsed = JSON.parse(readFileSync(pricingPath, 'utf-8'));
    pricingFileCache.set(pricingPath, { fp, data: parsed });
    return { fp, data: parsed };
  } catch {
    return { fp: 'builtin', data: FALLBACK_PRICING };
  }
}

const DISPLAY_NAME_TO_PREFIX = {
  'gemini 4 hydrogen': 'gemini-4-hydrogen',
  hydrogen: 'gemini-4-hydrogen',
  'gemini 4 neon': 'gemini-4-neon',
  neon: 'gemini-4-neon',
  'gemini 4 argon': 'gemini-4-argon',
  argon: 'gemini-4-argon',
  'gemini 4 carbon': 'gemini-4-carbon',
  carbon: 'gemini-4-carbon',
  orchestrator: 'gemini-pro-orchestrator',
  'gemini 3.8 flash': 'gemini-3.8-flash',
  '3.8 flash': 'gemini-3.8-flash',
  'claude opus 5.5': 'claude-opus-5-5',
  'claude sonnet 5.5': 'claude-sonnet-5-5',
  'gpt-oss 120b': 'gpt-oss-120b',
};

function normalizeModelLookupName(raw) {
  let s = String(raw || '').trim();
  const orchMatch = /^Orchestrator\s*\(([^)]+)\)\s*$/i.exec(s);
  if (orchMatch) {
    const inner = orchMatch[1].trim();
    if (/^(neon|hydrogen|carbon|argon)$/i.test(inner)) {
      s = `Gemini 4 ${inner}`;
    } else if (/^(opus|sonnet|haiku)\b/i.test(inner)) {
      s = `Claude ${inner}`;
    } else {
      s = inner;
    }
  }
  return s
    .replace(/\s*\((?:XHigh|High|Medium|Low|Max|Orchestrator|Orch|Thinking)\)\s*$/i, '')
    .trim()
    .toLowerCase();
}

function matchRuleByPrefix(lower, rules) {
  let matched = null;
  let matchedLen = -1;
  for (const r of rules) {
    const prefix = String(r?.prefix || '').toLowerCase();
    if (!prefix) continue;
    if (lower.startsWith(prefix) && prefix.length > matchedLen) {
      matched = r;
      matchedLen = prefix.length;
    }
  }
  return matched;
}

export function resolveModelRate(modelId, pricingData = FALLBACK_PRICING, dateStr = '') {
  const raw = String(modelId || 'unknown').trim() || 'unknown';
  const lower = raw.toLowerCase();
  const effectivePricing = pricingData || FALLBACK_PRICING;
  const rules = Array.isArray(effectivePricing?.rules) ? effectivePricing.rules : [];

  let matched = matchRuleByPrefix(lower, rules);

  if (!matched) {
    const norm = normalizeModelLookupName(raw);
    const mappedPrefix = DISPLAY_NAME_TO_PREFIX[norm];
    if (mappedPrefix) {
      matched = matchRuleByPrefix(mappedPrefix, rules);
    }
    if (!matched && norm) {
      let bestDispLen = -1;
      for (const r of rules) {
        const disp = String(r?.displayName || '')
          .replace(/\{tier\}|\{raw\}/g, '')
          .trim()
          .toLowerCase();
        if (!disp) continue;
        if ((norm === disp || norm.startsWith(`${disp} `) || norm.startsWith(`${disp}(`)) && disp.length > bestDispLen) {
          matched = r;
          bestDispLen = disp.length;
        }
      }
    }
  }

  const def = effectivePricing?.default || FALLBACK_PRICING.default;
  const rule = matched || def;
  let rates = rule.rates || FALLBACK_PRICING.default.rates;

  if (dateStr && Array.isArray(rule.scheduled) && rule.scheduled.length > 0) {
    let bestDate = '';
    for (const s of rule.scheduled) {
      const eff = String(s?.effectiveFrom || '');
      if (eff && dateStr >= eff && eff >= bestDate && s?.rates) {
        bestDate = eff;
        rates = s.rates;
      }
    }
  }

  const parts = lower.split('-');
  const lastSeg = parts[parts.length - 1];
  const tier = TIER_MAP[lastSeg] || 'Std';
  const tpl = String(rule.displayName || '{raw}');
  const displayName = tpl
    .replace('{tier}', tier)
    .replace('{raw}', raw);

  return {
    displayName,
    input: Number(rates.input) || 0,
    cacheRead: Number(rates.cacheRead) || 0,
    output: Number(rates.output) || 0,
  };
}

/**
 * Parses one transcript.jsonl file text into compact (date, hour, model) usage buckets.
 */
export function parseTranscriptUsage(text) {
  const buckets = new Map(); // "YYYY-MM-DD|HH|model" -> { dateKey, hour, model, inp, cache, out, calls }
  if (!text) return [];

  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const line = text.slice(start, end);
    start = end + 1;

    if (!line || !line.includes('PLANNER_RESPONSE')) continue;

    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== 'PLANNER_RESPONSE' || !d?.created_at) continue;

    const tsMs = Date.parse(d.created_at);
    if (!Number.isFinite(tsMs)) continue;

    const inp = Math.max(0, Number(d.input_tokens) || 0);
    const cache = Math.max(0, Number(d.cache_read_tokens) || 0);
    const out = Math.max(0, Number(d.output_tokens) || 0);
    if (inp === 0 && cache === 0 && out === 0) continue;

    const dt = new Date(tsMs);
    const dateKey = localDateKey(dt);
    const hour = dt.getHours();
    const model = String(d.model || 'unknown').trim() || 'unknown';
    const key = `${dateKey}|${hour}|${model}`;

    let b = buckets.get(key);
    if (!b) {
      b = { dateKey, hour, model, inp: 0, cache: 0, out: 0, calls: 0 };
      buckets.set(key, b);
    }
    b.inp += inp;
    b.cache += cache;
    b.out += out;
    b.calls += 1;
  }

  return [...buckets.values()];
}

function emptyPeriod() {
  return {
    calls: 0,
    inp: 0,
    cache: 0,
    out: 0,
    totalTok: 0,
    netTok: 0,
    cacheHitPct: 0,
    inUsd: 0,
    cacheUsd: 0,
    outUsd: 0,
    totalUsd: 0,
  };
}

function addToBucket(target, row, rate) {
  const inUsd = (row.inp / 1e6) * rate.input;
  const cacheUsd = (row.cache / 1e6) * rate.cacheRead;
  const outUsd = (row.out / 1e6) * rate.output;
  target.calls += row.calls;
  target.inp += row.inp;
  target.cache += row.cache;
  target.out += row.out;
  target.inUsd += inUsd;
  target.cacheUsd += cacheUsd;
  target.outUsd += outUsd;
  target.totalUsd += inUsd + cacheUsd + outUsd;
}

function finalizeSummary(obj) {
  obj.totalTok = obj.inp + obj.cache + obj.out;
  obj.netTok = obj.inp + obj.out;
  const denom = obj.inp + obj.cache;
  obj.cacheHitPct = denom > 0 ? Math.round((obj.cache / denom) * 1000) / 10 : 0;
  return obj;
}

function finalizePeriod(summary, bars, modelsMap) {
  finalizeSummary(summary);
  const models = [...modelsMap.values()]
    .map((m) => finalizeSummary(m))
    .sort((a, b) => (b.totalUsd - a.totalUsd) || (b.totalTok - a.totalTok));

  const axis = bars.length > 0
    ? [bars[0].label, bars[Math.floor((bars.length - 1) / 2)].label, bars[bars.length - 1].label]
    : ['—', '—', '—'];

  return {
    ...summary,
    axis,
    bars,
    models,
  };
}

function emptyBar(label) {
  return {
    label,
    inp: 0,
    cache: 0,
    out: 0,
    calls: 0,
    inUsd: 0,
    cacheUsd: 0,
    outUsd: 0,
    totalUsd: 0,
  };
}

function addModelToMap(modelsMap, rate, row) {
  let m = modelsMap.get(rate.displayName);
  if (!m) {
    m = { name: rate.displayName, ...emptyPeriod() };
    modelsMap.set(rate.displayName, m);
  }
  addToBucket(m, row, rate);
}

function pickCallModelKey(call, agent) {
  const resp = typeof call?.responseModel === 'string' ? call.responseModel.trim() : '';
  if (resp) return resp;
  const disp = typeof call?.modelDisplayName === 'string' ? call.modelDisplayName.trim() : '';
  if (disp && disp !== 'Unknown' && !/^MODEL_PLACEHOLDER_/i.test(disp)) return disp;
  const sess = typeof agent?.sessionModel === 'string' ? agent.sessionModel.trim() : '';
  if (sess && sess !== '未调用' && sess !== 'Unknown' && !/^MODEL_PLACEHOLDER_/i.test(sess)) return sess;
  const latest = typeof agent?.latestModel === 'string' ? agent.latestModel.trim() : '';
  if (latest && latest !== '未调用' && latest !== 'Unknown' && !/^MODEL_PLACEHOLDER_/i.test(latest)) return latest;
  return disp || 'unknown';
}

export function computeSessionUsage(agents, pricingData = FALLBACK_PRICING) {
  const list = Array.isArray(agents) ? agents : [];
  const effectivePricing = pricingData || FALLBACK_PRICING;
  const todayStr = localDateKey(new Date());

  const totalSummary = emptyPeriod();
  const mainSummary = emptyPeriod();
  const subSummary = emptyPeriod();
  const modelsMap = new Map();
  let subagentCount = 0;

  for (const agent of list) {
    if (!agent || typeof agent !== 'object') continue;
    const calls = Array.isArray(agent.calls) ? agent.calls : [];
    const isMain = Boolean(agent.isMain);
    let agentCallCount = 0;

    for (const c of calls) {
      if (!c || typeof c !== 'object') continue;
      agentCallCount += 1;
      const modelKey = pickCallModelKey(c, agent);
      const ts = Number(c.timestampMs);
      const dateStr = Number.isFinite(ts) && ts > 1_000_000_000_000
        ? localDateKey(new Date(ts))
        : todayStr;
      const rate = resolveModelRate(modelKey, effectivePricing, dateStr);
      const row = {
        inp: Math.max(0, Number(c.inputTokens) || 0),
        cache: Math.max(0, Number(c.cacheReadTokens) || 0),
        out: Math.max(0, Number(c.outputTokens) || 0),
        calls: 1,
      };
      addToBucket(totalSummary, row, rate);
      addToBucket(isMain ? mainSummary : subSummary, row, rate);
      addModelToMap(modelsMap, rate, row);
    }

    if (!isMain && agentCallCount > 0) {
      subagentCount += 1;
    }
  }

  finalizeSummary(totalSummary);
  finalizeSummary(mainSummary);
  finalizeSummary(subSummary);

  const models = [...modelsMap.values()]
    .map((m) => finalizeSummary(m))
    .sort((a, b) => (b.totalUsd - a.totalUsd) || (b.totalTok - a.totalTok));

  return {
    ...totalSummary,
    mainTok: mainSummary.totalTok,
    mainUsd: mainSummary.totalUsd,
    subagentsTok: subSummary.totalTok,
    subagentsUsd: subSummary.totalUsd,
    subagentCount,
    models,
    pricingUpdatedAt: effectivePricing?.updatedAt || '',
  };
}

export function createUsageScanner({ appData, pricingPath }) {
  const fileCache = new Map(); // filePath -> { fp, rows }
  let lastScanAt = 0;
  let lastSnapshot = null;

  function refreshFiles(nowMs) {
    const brainDir = appData ? join(appData, 'brain') : '';
    const seenPaths = new Set();
    const fpParts = [];

    if (brainDir && existsSync(brainDir)) {
      for (const convId of safeReaddir(brainDir).sort()) {
        if (convId.startsWith('.')) continue;
        const p = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        const fp = safeStatFp(p);
        if (!fp) continue;
        seenPaths.add(p);
        fpParts.push(`${convId}:${fp}`);
        const prev = fileCache.get(p);
        if (!prev || prev.fp !== fp) {
          try {
            const text = readFileSync(p, 'utf-8');
            fileCache.set(p, { fp, rows: parseTranscriptUsage(text) });
          } catch {
            // Keep previous on transient read failure
          }
        }
      }
    }

    for (const cachedPath of fileCache.keys()) {
      if (!seenPaths.has(cachedPath)) fileCache.delete(cachedPath);
    }

    lastScanAt = nowMs;
    return createHash('sha1').update(fpParts.join('|')).digest('hex').slice(0, 16);
  }

  function buildSnapshot(clientEtag = '', { force = false } = {}) {
    const now = new Date();
    const nowMs = now.getTime();
    const todayStr = localDateKey(now);
    const currentHour = now.getHours();
    const { fp: pricingFp, data: pricingData } = loadPricing(pricingPath);

    let filesDigest = lastSnapshot?._filesDigest || '';
    if (force || !lastSnapshot || nowMs - lastScanAt >= 1500) {
      filesDigest = refreshFiles(nowMs);
    }

    const etag = `${todayStr}|${currentHour}|${pricingFp}|${filesDigest}`;
    if (lastSnapshot && lastSnapshot.etag === etag) {
      if (clientEtag && clientEtag === etag) {
        return { ready: true, unchanged: true, etag };
      }
      return lastSnapshot.payload;
    }

    // Build 7-day and 30-day date lists ending today
    const d30Dates = [];
    for (let i = 29; i >= 0; i--) {
      const dt = addLocalDays(now, -i);
      d30Dates.push({
        dateKey: localDateKey(dt),
        label: `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`,
      });
    }
    const d7Dates = d30Dates.slice(-7);
    const d30Set = new Set(d30Dates.map((d) => d.dateKey));
    const d7Set = new Set(d7Dates.map((d) => d.dateKey));

    // Accumulators
    const todaySummary = emptyPeriod();
    const d7Summary = emptyPeriod();
    const d30Summary = emptyPeriod();

    const todayModels = new Map();
    const d7Models = new Map();
    const d30Models = new Map();

    const todayHourMap = new Map(); // hour -> bar
    const d30DayMap = new Map();
    for (const d of d30Dates) {
      d30DayMap.set(d.dateKey, emptyBar(d.label));
    }

    let minTodayHour = currentHour;

    for (const entry of fileCache.values()) {
      for (const row of entry.rows) {
        if (!d30Set.has(row.dateKey)) continue;
        const rate = resolveModelRate(row.model, pricingData, row.dateKey);

        addToBucket(d30Summary, row, rate);
        addModelToMap(d30Models, rate, row);
        const dayBar = d30DayMap.get(row.dateKey);
        if (dayBar) addToBucket(dayBar, row, rate);

        if (d7Set.has(row.dateKey)) {
          addToBucket(d7Summary, row, rate);
          addModelToMap(d7Models, rate, row);
        }

        if (row.dateKey === todayStr) {
          addToBucket(todaySummary, row, rate);
          addModelToMap(todayModels, rate, row);
          if (row.hour < minTodayHour) minTodayHour = row.hour;
          let hb = todayHourMap.get(row.hour);
          if (!hb) {
            hb = emptyBar(`${String(row.hour).padStart(2, '0')}:00`);
            todayHourMap.set(row.hour, hb);
          }
          addToBucket(hb, row, rate);
        }
      }
    }

    const startHour = Math.min(minTodayHour, Math.max(0, currentHour - 7));
    const todayBars = [];
    for (let h = startHour; h <= currentHour; h++) {
      todayBars.push(todayHourMap.get(h) || emptyBar(`${String(h).padStart(2, '0')}:00`));
    }

    const d30Bars = d30Dates.map((d) => d30DayMap.get(d.dateKey));
    const d7Bars = d7Dates.map((d) => d30DayMap.get(d.dateKey));

    const payload = {
      ready: true,
      unchanged: false,
      etag,
      updatedAt: now.toISOString(),
      pricingUpdatedAt: pricingData?.updatedAt || '',
      today: finalizePeriod(todaySummary, todayBars, todayModels),
      d7: finalizePeriod(d7Summary, d7Bars, d7Models),
      d30: finalizePeriod(d30Summary, d30Bars, d30Models),
    };

    lastSnapshot = { etag, _filesDigest: filesDigest, payload };
    if (clientEtag && clientEtag === etag) {
      return { ready: true, unchanged: true, etag };
    }
    return payload;
  }

  return { getSnapshot: buildSnapshot };
}
