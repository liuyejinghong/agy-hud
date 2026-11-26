/**
 * Agy HUD sidecar backend.
 *
 * Read-only observer of local Antigravity Language Server trajectories,
 * model quotas, Swarm rosters (coordinator & worker views), and SQLite
 * conversation hierarchy. Uses zero-retention trajectory caching and
 * stat-gated SQLite caching to minimize memory and CPU overhead.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  aggregateModelSpeeds,
  buildQuotaIndex,
  buildQuotaPools,
  buildQuotaPoolsFromSummary,
  extractAgentSnapshot,
  normalizeAgentStatus,
  refreshAgentQuota,
} from './metrics.mjs';
import { computeSessionUsage, createUsageScanner, loadPricing } from './usage.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
function readPluginVersion() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', 'plugin.json'), 'utf-8'));
    return typeof raw?.version === 'string' && raw.version.trim() ? raw.version.trim() : '';
  } catch {
    return '';
  }
}
const PLUGIN_VERSION = readPluginVersion();
const ID_RE = /^[0-9a-f-]{8,}$/i;
const LABELED_CONV_RE = /(?:conversationId|conversation_id|subagentConversationId|subagent_conversation_id)["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const SUBAGENT_ID_KEYS = new Set([
  'conversationId',
  'conversation_id',
  'subagentConversationId',
  'subagent_conversation_id',
]);
const MAX_CHILDREN = 16;
const MAX_TRAJ_CACHE = 96;
const QUOTA_TTL_MS = 30_000;
const SQLITE_MIN_RECHECK_MS = 3_000;
const REVERSE_SWARM_TTL_MS = 5_000;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'application/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function safeStatFp(p) {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
  }
  const root = join(homedir(), '.gemini');
  const preferred = join(root, 'antigravity');
  const dirs = [];
  if (existsSync(join(preferred, 'brain'))) dirs.push(preferred);
  for (const name of safeReaddir(root).sort()) {
    const candidate = join(root, name);
    if (candidate !== preferred && existsSync(join(candidate, 'brain'))) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

function resolveAppDataForConv(conv) {
  const dirs = findAppDataDirs();
  for (const dir of dirs) {
    if (existsSync(join(dir, 'brain', conv))) return dir;
  }
  return dirs[0] || join(homedir(), '.gemini', 'antigravity');
}

function resolveDesktopAppData() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
  }
  return join(homedir(), '.gemini', 'antigravity');
}

function getLsEndpoint() {
  const raw = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!raw || !csrf) return null;
  const base = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return { base: base.replace(/\/+$/, ''), csrf };
}

async function callLs(method, body = {}) {
  const ep = getLsEndpoint();
  if (!ep) throw new Error('LS endpoint env missing');
  const res = await fetch(`${ep.base}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': ep.csrf,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`${method} HTTP ${res.status}`);
  }
  return res.json();
}

const quotaCache = { fetchedAt: 0, index: buildQuotaIndex(null), pools: [], fingerprint: '' };

async function getQuotaIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - quotaCache.fetchedAt < QUOTA_TTL_MS && quotaCache.fetchedAt > 0) {
    return quotaCache;
  }
  const [cfgRes, summaryRes] = await Promise.allSettled([
    callLs('GetCascadeModelConfigData', {}),
    callLs('RetrieveUserQuotaSummary', {}),
  ]);

  if (cfgRes.status === 'fulfilled' || summaryRes.status === 'fulfilled') {
    if (cfgRes.status === 'fulfilled') {
      quotaCache.index = buildQuotaIndex(cfgRes.value);
    }
    const summaryPools = summaryRes.status === 'fulfilled'
      ? buildQuotaPoolsFromSummary(summaryRes.value)
      : [];
    if (summaryPools.length > 0) {
      quotaCache.pools = summaryPools;
    } else if (cfgRes.status === 'fulfilled') {
      quotaCache.pools = buildQuotaPools(cfgRes.value);
    }

    const fpParts = [];
    for (const p of quotaCache.pools) {
      const buckets = Array.isArray(p.buckets) && p.buckets.length
        ? p.buckets
        : [{ window: '5h', remainingFraction: p.remainingFraction, resetTime: p.resetTime }];
      for (const b of buckets) {
        const pct = b.remainingFraction !== null ? Math.round(b.remainingFraction * 1000) : 'x';
        fpParts.push(`${p.id}:${b.window}:${pct}:${b.resetTime || ''}`);
      }
    }
    quotaCache.fetchedAt = now;
    quotaCache.fingerprint = fpParts.sort().join(',');
  } else if (quotaCache.fetchedAt === 0) {
    quotaCache.fetchedAt = now - QUOTA_TTL_MS + 5000;
  }
  return quotaCache;
}

// ---------------------------------------------------------------------------
// Strict subagent extraction from main trajectory (Fix #1)
// ---------------------------------------------------------------------------

function extractSubagentIds(obj, outSet, depth = 0) {
  if (!obj || depth > 6) return;
  if (typeof obj === 'string') {
    if (!obj.includes('-')) return;
    LABELED_CONV_RE.lastIndex = 0;
    let m;
    while ((m = LABELED_CONV_RE.exec(obj)) !== null) {
      outSet.add(m[1]);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractSubagentIds(item, outSet, depth + 1);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (SUBAGENT_ID_KEYS.has(k) && typeof v === 'string' && ID_RE.test(v)) {
        outSet.add(v.trim());
      } else {
        extractSubagentIds(v, outSet, depth + 1);
      }
    }
  }
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return {};
    }
  }
  return {};
}

function stripQuotes(v) {
  return String(v || '').trim().replace(/^"(.*)"$/, '$1').trim();
}

function scanTrajectoryForSubagents(mainTrajectoryResp, rootConv, appData) {
  const found = new Map();
  const steps = Array.isArray(mainTrajectoryResp?.trajectory?.steps)
    ? mainTrajectoryResp.trajectory.steps
    : [];

  for (const step of steps) {
    const toolName = String(step?.metadata?.toolCall?.name || '').toLowerCase();
    const stepType = String(step?.type || '').toLowerCase();
    if (!toolName.includes('subagent') && !stepType.includes('subagent')) continue;

    const candidateIds = new Set();
    extractSubagentIds(step?.metadata?.toolCall, candidateIds);
    extractSubagentIds(step?.generic, candidateIds);
    extractSubagentIds(step?.invokeSubagent, candidateIds);
    extractSubagentIds(step?.subagent, candidateIds);
    if (candidateIds.size === 0) continue;

    const args = parseToolArgs(step?.metadata?.toolCall?.argumentsJson || step?.metadata?.toolCall?.args);
    const typeName = stripQuotes(args.TypeName || args.typeName || step?.invokeSubagent?.typeName || 'subagent') || 'subagent';
    const role = stripQuotes(args.Role || args.role || step?.invokeSubagent?.role || '');

    for (const cid of candidateIds) {
      if (!cid || cid === rootConv || found.has(cid)) continue;
      if (!existsSync(join(appData, 'brain', cid))) continue;
      found.set(cid, {
        id: cid,
        label: role || (typeName !== 'subagent' ? `${typeName}-${cid.slice(0, 6)}` : `subagent-${cid.slice(0, 6)}`),
        hasSpecificLabel: Boolean(role),
        role: typeName,
        source: 'subagent',
        killed: false,
        modelHint: '',
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Zero-retention trajectory cache + adaptive TTL + in-flight dedup (Perf P1)
// ---------------------------------------------------------------------------

const trajCache = new Map(); // convId -> { fp, fetchedAt, rawStatus, snapshot, stepChildren }
const inflightTraj = new Map(); // convId -> Promise

function adaptiveTrajTtl(status, isMain = false) {
  if (status === 'running') return 2_000;
  if (isMain) return 6_000;
  if (status === 'waiting') return 20_000;
  return 60_000;
}

async function getAgentSnapshotCached(appData, convId, meta, quotaIndex, { scanChildren = false } = {}) {
  const fp = safeStatFp(join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'));
  const cached = trajCache.get(convId);
  const now = Date.now();

  if (cached) {
    const prevStatus = normalizeAgentStatus(cached.rawStatus, meta);
    const ttl = adaptiveTrajTtl(prevStatus, Boolean(meta.isMain));
    const fpMatches = fp ? cached.fp === fp : !cached.fp;
    if (fpMatches && prevStatus === cached.snapshot.status && now - cached.fetchedAt < ttl) {
      const snap = cached.snapshot;
      snap.label = meta.label || snap.label;
      snap.role = meta.role || snap.role;
      snap.source = meta.source || snap.source;
      snap.isMain = Boolean(meta.isMain);
      snap.status = prevStatus;
      refreshAgentQuota(snap, quotaIndex, meta.modelHint);
      return {
        snapshot: snap,
        stepChildren: cached.stepChildren || new Map(),
      };
    }
  }

  let promise = inflightTraj.get(convId);
  if (!promise) {
    promise = (async () => {
      const rawTraj = await callLs('GetCascadeTrajectory', { cascadeId: convId });
      const snapshot = extractAgentSnapshot(convId, rawTraj, meta, quotaIndex);
      const stepChildren = scanChildren
        ? scanTrajectoryForSubagents(rawTraj, convId, appData)
        : new Map();
      const rawStatus = rawTraj?.status || '';

      trajCache.set(convId, {
        fp,
        fetchedAt: Date.now(),
        rawStatus,
        snapshot,
        stepChildren,
      });
      if (trajCache.size > MAX_TRAJ_CACHE) {
        const oldestKey = trajCache.keys().next().value;
        if (oldestKey) trajCache.delete(oldestKey);
      }
      return { rawStatus, snapshot, stepChildren };
    })().finally(() => {
      inflightTraj.delete(convId);
    });
    inflightTraj.set(convId, promise);
  }

  const res = await promise;
  res.snapshot.label = meta.label || res.snapshot.label;
  res.snapshot.role = meta.role || res.snapshot.role;
  res.snapshot.source = meta.source || res.snapshot.source;
  res.snapshot.isMain = Boolean(meta.isMain);
  res.snapshot.status = normalizeAgentStatus(res.rawStatus, meta);
  refreshAgentQuota(res.snapshot, quotaIndex, meta.modelHint);
  return {
    snapshot: res.snapshot,
    stepChildren: res.stepChildren,
  };
}

// ---------------------------------------------------------------------------
// Swarm roster discovery: coordinator + worker perspective (Fix #5)
// ---------------------------------------------------------------------------

const membersFileCache = new Map(); // path -> { fp, parsed }
const reverseSwarmCache = { appData: '', checkedAt: 0, byMember: new Map() };

function readMembersFile(membersPath) {
  const fp = safeStatFp(membersPath);
  if (!fp) return null;
  const cached = membersFileCache.get(membersPath);
  if (cached && cached.fp === fp) return cached.parsed;
  try {
    const parsed = JSON.parse(readFileSync(membersPath, 'utf-8'));
    membersFileCache.set(membersPath, { fp, parsed });
    if (membersFileCache.size > 64) {
      const oldestKey = membersFileCache.keys().next().value;
      if (oldestKey) membersFileCache.delete(oldestKey);
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildReverseSwarmIndex(appData) {
  const now = Date.now();
  if (
    reverseSwarmCache.appData === appData &&
    now - reverseSwarmCache.checkedAt < REVERSE_SWARM_TTL_MS
  ) {
    return reverseSwarmCache.byMember;
  }
  const byMember = new Map();
  const brainDir = join(appData, 'brain');
  for (const coordConv of safeReaddir(brainDir)) {
    if (!ID_RE.test(coordConv)) continue;
    const membersPath = join(brainDir, coordConv, '.system_generated', 'swarm', 'members.json');
    const raw = readMembersFile(membersPath);
    const members = raw?.members && typeof raw.members === 'object' ? raw.members : null;
    if (!members) continue;
    for (const info of Object.values(members)) {
      const cid = typeof info?.conversation_id === 'string' ? info.conversation_id.trim() : '';
      if (cid && ID_RE.test(cid)) {
        byMember.set(cid, { coordConv, members });
      }
    }
  }
  reverseSwarmCache.appData = appData;
  reverseSwarmCache.checkedAt = now;
  reverseSwarmCache.byMember = byMember;
  return byMember;
}

function addMembersToMap(out, members, excludeConv) {
  for (const [name, info] of Object.entries(members)) {
    const cid = typeof info?.conversation_id === 'string' ? info.conversation_id.trim() : '';
    if (!cid || cid === excludeConv || !ID_RE.test(cid)) continue;
    const role = typeof info?.role === 'string' && info.role ? info.role : 'worker';
    const label = role && role !== 'worker' && role !== name ? `${name} · ${role}` : name;
    out.set(cid, {
      id: cid,
      label,
      hasSpecificLabel: true,
      role,
      source: 'swarm',
      swarmStatus: info?.status || '',
      killed: Boolean(info?.killed),
      modelHint: typeof info?.model === 'string' ? info.model : '',
    });
  }
}

function readSwarmMembers(appData, rootConv) {
  const out = new Map();
  if (!appData) return out;

  // 1. Coordinator perspective: <rootConv>/.system_generated/swarm/members.json
  const ownPath = join(appData, 'brain', rootConv, '.system_generated', 'swarm', 'members.json');
  const ownRaw = readMembersFile(ownPath);
  if (ownRaw?.members && typeof ownRaw.members === 'object') {
    addMembersToMap(out, ownRaw.members, rootConv);
    return out;
  }

  // 2. Worker perspective: find coordinator whose members.json contains rootConv
  const rev = buildReverseSwarmIndex(appData);
  const hit = rev.get(rootConv);
  if (hit) {
    const coordInfo = hit.members.coordinator || {};
    if (hit.coordConv !== rootConv) {
      out.set(hit.coordConv, {
        id: hit.coordConv,
        label: 'coordinator · 主协调',
        hasSpecificLabel: true,
        role: 'coordinator',
        source: 'swarm',
        swarmStatus: coordInfo.status || '',
        killed: Boolean(coordInfo.killed),
        modelHint: typeof coordInfo.model === 'string' ? coordInfo.model : '',
      });
    }
    addMembersToMap(out, hit.members, rootConv);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stat-gated SQLite subagent discovery cache (Perf P2)
// ---------------------------------------------------------------------------

function resolveSqliteBin() {
  if (process.platform !== 'win32' && existsSync('/usr/bin/sqlite3')) {
    return '/usr/bin/sqlite3';
  }
  return 'sqlite3';
}

let sqliteUnavailable = false;
const sqliteCache = { fp: '', fetchedAt: 0, byId: new Map(), childrenOf: new Map() };

async function querySqliteJson(dbPath, sql) {
  try {
    const { stdout } = await execFileAsync(resolveSqliteBin(), ['-readonly', '-json', dbPath, sql], {
      timeout: 1500,
      maxBuffer: 2 * 1024 * 1024,
    });
    const txt = stdout.trim();
    return txt ? JSON.parse(txt) : [];
  } catch (err) {
    if (err?.code === 'ENOENT') {
      sqliteUnavailable = true;
    }
    throw err;
  }
}

async function getSqliteGraph(appData) {
  if (sqliteUnavailable) return { byId: new Map(), childrenOf: new Map() };
  const dbPath = join(appData, 'conversation_summaries.db');
  const dbFp = safeStatFp(dbPath);
  if (!dbFp) return { byId: new Map(), childrenOf: new Map() };

  const fp = `${dbFp}|${safeStatFp(`${dbPath}-wal`)}`;
  const now = Date.now();
  if (sqliteCache.fp === fp || (sqliteCache.fp && now - sqliteCache.fetchedAt < SQLITE_MIN_RECHECK_MS)) {
    return sqliteCache;
  }

  const [summariesRes, parentsRes] = await Promise.allSettled([
    querySqliteJson(
      dbPath,
      'SELECT conversation_id, agent_name, title, parent_conversation_id, status, killed FROM conversation_summaries;'
    ),
    querySqliteJson(dbPath, 'SELECT conversation_id, parent_id FROM conversation_parents;'),
  ]);
  if (sqliteUnavailable) {
    return { byId: new Map(), childrenOf: new Map() };
  }

  const byId = new Map();
  const childrenOf = new Map();
  const addEdge = (parentId, childId) => {
    if (!parentId || !childId || parentId === childId) return;
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, new Set());
    childrenOf.get(parentId).add(childId);
  };

  if (summariesRes.status === 'fulfilled') {
    for (const row of summariesRes.value) {
      if (!row?.conversation_id) continue;
      byId.set(row.conversation_id, row);
      if (row.parent_conversation_id) addEdge(row.parent_conversation_id, row.conversation_id);
    }
  }
  if (parentsRes.status === 'fulfilled') {
    for (const row of parentsRes.value) {
      if (row?.parent_id && row?.conversation_id) {
        addEdge(row.parent_id, row.conversation_id);
      }
    }
  }

  sqliteCache.fp = fp;
  sqliteCache.fetchedAt = now;
  sqliteCache.byId = byId;
  sqliteCache.childrenOf = childrenOf;
  return sqliteCache;
}

async function readSqliteSubagents(appData, rootConv) {
  const out = new Map();
  if (!appData) return out;
  const { byId, childrenOf } = await getSqliteGraph(appData);
  if (!childrenOf.size) return out;

  const visited = new Set([rootConv]);
  const queue = [{ id: rootConv, depth: 0 }];
  while (queue.length > 0 && out.size < 24) {
    const { id, depth } = queue.shift();
    if (depth >= 4) continue;
    const kids = childrenOf.get(id);
    if (!kids) continue;
    for (const cid of kids) {
      if (visited.has(cid) || !ID_RE.test(cid)) continue;
      visited.add(cid);
      const row = byId.get(cid) || {};
      const name = (row.agent_name || '').trim();
      const title = (row.title || '').trim();
      const label = name && title && name !== title
        ? `${name} · ${title.slice(0, 18)}`
        : (name || title.slice(0, 24) || `subagent-${cid.slice(0, 8)}`);
      out.set(cid, {
        id: cid,
        label,
        hasSpecificLabel: Boolean(title),
        role: name || 'subagent',
        source: 'subagent',
        dbStatus: row.status || '',
        killed: Boolean(row.killed),
        modelHint: '',
      });
      queue.push({ id: cid, depth: depth + 1 });
      if (out.size >= 24) break;
    }
  }
  return out;
}

function stripCalls(agent) {
  const { calls: _ignored, ...rest } = agent;
  return rest;
}

function mergeChildMeta(prev, next) {
  if (!prev) return next;
  const useNextLabel = Boolean(
    !prev.label ||
    next.hasSpecificLabel ||
    (!prev.hasSpecificLabel && next.label && !next.label.startsWith('subagent-'))
  );
  return {
    ...prev,
    ...next,
    label: useNextLabel ? next.label : prev.label,
    hasSpecificLabel: Boolean(prev.hasSpecificLabel || next.hasSpecificLabel),
    role: (next.role && next.role !== 'subagent') ? next.role : (prev.role || next.role || 'subagent'),
    source: next.source === 'swarm' ? 'swarm' : (prev.source || next.source),
    dbStatus: next.dbStatus || prev.dbStatus || '',
    swarmStatus: next.swarmStatus || prev.swarmStatus || '',
    killed: Boolean(prev.killed || next.killed),
    modelHint: next.modelHint || prev.modelHint || '',
  };
}

async function buildMetricsPayload(rootConv, clientEtag = '', { forceQuota = false } = {}) {
  const appData = resolveAppDataForConv(rootConv);
  const quotaRes = await getQuotaIndex({ force: forceQuota });
  const quotaIndex = quotaRes.index;

  const [mainResult, sqliteChildren] = await Promise.all([
    getAgentSnapshotCached(
      appData,
      rootConv,
      { label: '主会话', role: 'coordinator', source: 'main', isMain: true },
      quotaIndex,
      { scanChildren: true }
    ),
    readSqliteSubagents(appData, rootConv),
  ]);

  const mainSnapshot = mainResult.snapshot;
  const stepChildren = mainResult.stepChildren;
  const swarmChildren = readSwarmMembers(appData, rootConv);

  const childMetaMap = new Map();
  for (const sourceMap of [sqliteChildren, stepChildren, swarmChildren]) {
    for (const [cid, meta] of sourceMap.entries()) {
      childMetaMap.set(cid, mergeChildMeta(childMetaMap.get(cid), meta));
    }
  }

  const childEntries = [...childMetaMap.values()].slice(0, MAX_CHILDREN);
  const childResults = await Promise.allSettled(
    childEntries.map((meta) => getAgentSnapshotCached(appData, meta.id, meta, quotaIndex))
  );

  const subagentSnapshots = childEntries.map((meta, idx) => {
    const res = childResults[idx];
    if (res.status === 'fulfilled') return res.value.snapshot;
    return extractAgentSnapshot(meta.id, null, meta, quotaIndex);
  });

  const statusWeight = { running: 0, waiting: 1, idle: 2, killed: 3 };
  subagentSnapshots.sort((a, b) => {
    const wa = statusWeight[a.status] ?? 9;
    const wb = statusWeight[b.status] ?? 9;
    if (wa !== wb) return wa - wb;
    return (b.usedTokens - a.usedTokens) || a.label.localeCompare(b.label);
  });

  const allAgents = [mainSnapshot, ...subagentSnapshots];
  const models = aggregateModelSpeeds(allAgents, quotaIndex);
  const pricing = loadPricing(join(__dirname, 'pricing.json'));
  const sessionCost = computeSessionUsage(allAgents, pricing.data);

  const mainPublic = {
    ...stripCalls(mainSnapshot),
    models: aggregateModelSpeeds([mainSnapshot], quotaIndex),
  };
  const subagentsPublic = subagentSnapshots.map((s) => ({
    ...stripCalls(s),
    models: aggregateModelSpeeds([s], quotaIndex),
  }));

  const activeSubagents = subagentSnapshots.filter(
    (s) => s.status === 'running' || s.status === 'waiting'
  ).length;
  const totalCalls = allAgents.reduce((sum, a) => sum + a.callCount, 0);
  const totalOutputTokens = allAgents.reduce((sum, a) => sum + (a.totals?.outputTokens || 0), 0);

  const agentSig = allAgents
    .map((a) => [
      a.id,
      a.status,
      a.callCount,
      a.usedTokens,
      a.sessionModel || a.latestModel,
      a.activeModel || '',
      a.compaction?.state || '',
      a.compaction?.stepIndex ?? '',
      a.lastCallTimestampMs ?? '',
      a.label,
    ].join(':'))
    .join('|');
  const etag = `${PLUGIN_VERSION}#${rootConv}#${quotaRes.fingerprint}#${pricing.fp || pricing.data?.updatedAt || ''}#${agentSig}`;

  if (!forceQuota && clientEtag && clientEtag === etag) {
    return { conversationId: rootConv, version: PLUGIN_VERSION, ready: true, unchanged: true, etag };
  }

  return {
    conversationId: rootConv,
    version: PLUGIN_VERSION,
    ready: true,
    unchanged: false,
    updatedAt: new Date().toISOString(),
    etag,
    main: mainPublic,
    subagents: subagentsPublic,
    models,
    quotaPools: quotaRes.pools,
    sessionCost,
    sessionTotals: {
      agentCount: allAgents.length,
      activeSubagents,
      totalCalls,
      totalOutputTokens,
    },
  };
}

const app = new SidecarApp();
const usageScanner = createUsageScanner({
  appData: resolveDesktopAppData(),
  pricingPath: join(__dirname, 'pricing.json'),
});

app.page('/', () =>
  readFileSync(join(__dirname, 'index.html'), 'utf-8').replace(
    '__PLUGIN_VERSION__',
    PLUGIN_VERSION ? `v${PLUGIN_VERSION}` : ''
  )
);

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET'
  );
}

app.api('/api/metrics', async (data) => {
  const conv = String(data.conversationId || app.config.conversationId || '').trim();
  if (!conv || !ID_RE.test(conv)) {
    return { conversationId: conv || null, version: PLUGIN_VERSION, ready: false, error: '等待会话上下文' };
  }
  try {
    const forceQuota = data.refreshQuota === '1';
    return await buildMetricsPayload(conv, typeof data.etag === 'string' ? data.etag : '', { forceQuota });
  } catch (err) {
    return {
      conversationId: conv,
      version: PLUGIN_VERSION,
      ready: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}, 'GET');

app.api('/api/usage', (data) => {
  try {
    return usageScanner.getSnapshot(typeof data.etag === 'string' ? data.etag : '', {
      force: data.force === '1',
    });
  } catch (err) {
    return {
      ready: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}, 'GET');

app.run();
