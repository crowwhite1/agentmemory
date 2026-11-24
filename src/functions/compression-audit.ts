import type { StateKV } from "../state/kv.js";
import { collectAll } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, CompressionQueueJob, FunctionMetrics, Session, SessionSummary, SessionSummaryRepair } from "../types.js";
import { compressionRaw, needsCompression, type StoredObservation } from "./compression-state.js";
import { summaryCovers, summaryObservations } from "./summary-state.js";

const states = ["complete", "legacy", "failed", "pending", "raw", "unknown"] as const;
type State = typeof states[number];
const summaryStates = ["current", "stale", "legacy_unverified", "missing", "active", "empty", "unknown"] as const;
type SummaryState = typeof summaryStates[number];
const PAGE = 100;
const identity = (sessionId: string, observationId: string) => JSON.stringify([sessionId, observationId]);

function classify(row: StoredObservation): State {
  const status = row.compression?.status;
  if (status === "complete" && "title" in row && typeof row.title === "string" && row.title.trim()) return "complete";
  if (status === "failed" || status === "pending") return status;
  if (status !== undefined) return "unknown";
  if ("title" in row && typeof row.title === "string" && row.title.trim()) return "legacy";
  return needsCompression(row) ? "raw" : "unknown";
}

function counts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>;
}

type HistoricalIdentity = { sessionId: string; observationId: string };

/** Explicit read-only inventory. No LLM, retry, mutations or background scan.
 * Counts registered session scopes, not arbitrary orphaned StateKV scopes.
 * It is a live scan rather than a transactional snapshot.
 */
export async function auditCompression(kv: StateKV, filter = "unverified", offset = 0) {
  if (!["all", "unverified", "known_failure", ...states].includes(filter) || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid audit filter or offset");
  const startedAt = Date.now();
  const [sessions, jobs, history, archive, metrics, repairs] = await Promise.all([
    collectAll<Session>(kv, KV.sessions),
    collectAll<CompressionQueueJob>(kv, KV.compressionQueue),
    kv.get<HistoricalIdentity[]>(KV.compressionQueueHistory, "recent"),
    kv.get<HistoricalIdentity[]>(KV.compressionQueueArchive, "recent"),
    collectAll<FunctionMetrics>(kv, KV.metrics),
    collectAll<SessionSummaryRepair>(kv, KV.summaryRepairs),
  ]);
  const queue = new Map(jobs.filter(j => j && typeof j.sessionId === "string" && typeof j.observationId === "string")
    .map(j => [identity(j.sessionId, j.observationId), j] as const));
  const known = new Map<string, HistoricalIdentity>();
  for (const row of [...(Array.isArray(history) ? history : []), ...(Array.isArray(archive) ? archive : []),
    ...jobs.filter(j => j?.lastError)]) {
    if (row && typeof row.sessionId === "string" && typeof row.observationId === "string")
      known.set(identity(row.sessionId, row.observationId), { sessionId: row.sessionId, observationId: row.observationId });
  }
  const repairMap = new Map(repairs.filter(r => r && typeof r.sessionId === "string").map(r => [r.sessionId, r] as const));
  const totals = counts(states);
  const summaryTotals = counts(summaryStates);
  const knownFailureStates = counts(states);
  const seen = new Set<string>();
  const sessionIds = new Set<string>();
  let invalidSessions = 0, invalidObservations = 0, sourceUnavailable = 0, retryableUnqueued = 0, knownFailuresFound = 0;
  let observationCountMismatch = 0, observed = 0, matched = 0;
  let summariesWithRepairs = 0;
  const items: Array<{ sessionId: string; observationId: string; status: State; attempts: number | null;
    sourceAvailable: boolean; queueStatus: string | null; knownFailure: boolean; lastAttemptAt: string | null }> = [];
  const summaryIssues: Array<{ sessionId: string; status: SummaryState; observations: number; covered: number | null;
    repairScheduled: boolean; repairAttempts: number | null }> = [];
  let summaryIssueCount = 0;
  sessions.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || !session.id || sessionIds.has(session.id)) { invalidSessions++; continue; }
    sessionIds.add(session.id);
    const rows = await collectAll<StoredObservation>(kv, KV.observations(session.id));
    rows.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
    const valid: StoredObservation[] = [];
    let summaryInvalid = false;
    if (typeof session.observationCount === "number" && session.observationCount !== rows.length) observationCountMismatch++;
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id || row.sessionId !== session.id) {
        invalidObservations++; summaryInvalid = true; continue;
      }
      const id = identity(session.id, row.id);
      if (seen.has(id)) { invalidObservations++; summaryInvalid = true; continue; }
      seen.add(id); valid.push(row); observed++;
      const status = classify(row);
      totals[status]++;
      const job = queue.get(id);
      const knownFailure = known.has(id) || status === "failed";
      if (knownFailure) { knownFailuresFound++; knownFailureStates[status]++; }
      const sourceAvailable = Boolean(compressionRaw(row));
      if (["failed", "pending", "raw"].includes(status)) {
        if (!sourceAvailable) sourceUnavailable++;
        else if (!job) retryableUnqueued++;
      }
      if (filter === "all" || filter === status || (filter === "unverified" && status !== "complete") ||
          (filter === "known_failure" && knownFailure)) {
        if (matched >= offset && items.length < PAGE) items.push({
          sessionId: session.id, observationId: row.id, status,
          attempts: Number.isSafeInteger(row.compression?.attempts) ? row.compression!.attempts : null,
          sourceAvailable, queueStatus: job?.status ?? null, knownFailure,
          lastAttemptAt: typeof row.compression?.lastAttemptAt === "string" ? row.compression.lastAttemptAt : null,
        });
        matched++;
      }
    }
    const summary = await kv.get<SessionSummary>(KV.summaries, session.id);
    const repair = repairMap.get(session.id);
    if (repair) summariesWithRepairs++;
    let summaryStatus: SummaryState;
    if (summaryInvalid || (valid.some(row => "title" in row && (typeof row.title !== "string" ||
        typeof row.timestamp !== "string" || (row.compressedAt !== undefined && typeof row.compressedAt !== "string"))))) {
      summaryStatus = "unknown";
    } else if (session.status === "active") summaryStatus = "active";
    else if (valid.length === 0) summaryStatus = "empty";
    else if (!summary) summaryStatus = "missing";
    else if (!summary.coveredFingerprint) summaryStatus = "legacy_unverified";
    else summaryStatus = summaryCovers(session, summaryObservations(valid as CompressedObservation[]), summary) &&
        !valid.some(needsCompression) ? "current" : "stale";
    summaryTotals[summaryStatus]++;
    if (!["current", "active", "empty"].includes(summaryStatus)) {
      summaryIssueCount++;
      if (summaryIssues.length < PAGE) summaryIssues.push({ sessionId: session.id, status: summaryStatus,
        observations: valid.length, covered: typeof summary?.observationCount === "number" ? summary.observationCount : null,
        repairScheduled: Boolean(repair), repairAttempts: repair?.attempts ?? null });
    }
  }
  const missingReferences = [...known].filter(([key]) => !seen.has(key)).map(([, row]) => row);
  const unmatchedQueue = [...queue.keys()].filter(key => !seen.has(key)).length;
  return {
    startedAt, finishedAt: Date.now(), sessions: sessionIds.size, observations: observed, totals,
    invalidSessions, invalidObservations, observationCountMismatch, sourceUnavailable, retryableUnqueued,
    knownFailuresFound, knownFailureStates, missingReferenceCount: missingReferences.length,
    missingReferences: missingReferences.slice(0, PAGE), unmatchedQueue,
    summaryTotals, summaryIssues, summaryIssueCount, summariesWithRepairs,
    historicalCalls: metrics.filter(m => m && ["mem::compress", "mem::summarize"].includes(m.functionId))
      .map(m => ({ functionId: m.functionId, totalCalls: m.totalCalls, successCount: m.successCount, failureCount: m.failureCount })),
    filter, offset, matched, items, nextOffset: offset + PAGE < matched ? offset + PAGE : null,
  };
}
