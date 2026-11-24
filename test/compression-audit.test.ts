import { describe, expect, it, vi } from "vitest";
import { auditCompression } from "../src/functions/compression-audit.js";
import { KV } from "../src/state/schema.js";
import { summaryFingerprint, summaryObservations } from "../src/functions/summary-state.js";
import type { CompressedObservation, Session } from "../src/types.js";

describe("read-only compression audit", () => {
  it("counts actual states, correlates failures, and checks summary coverage without writes", async () => {
    const session = {id:"s", project:"p", cwd:"/p", status:"completed", startedAt:"2026-01-01", observationCount:5} as Session;
    const base = {sessionId:"s", timestamp:"2026-01-01", type:"task", title:"Summary", narrative:"A summary", facts:[], concepts:[], files:[], importance:4};
    const source = {hookType:"post_tool_use", toolOutput:"done", originalBytes:4, truncated:false};
    const rows = [
      {...base,id:"done",source,compression:{status:"complete",revision:"x",attempts:3}},
      {...base,id:"legacy"},
      {...base,id:"failed",source,compression:{status:"failed",revision:"y",attempts:2}},
      {...base,id:"pending",compression:{status:"pending",revision:"z",attempts:0}},
      {id:"raw",sessionId:"s",timestamp:base.timestamp,hookType:"post_tool_use",toolOutput:"x"},
    ];
    const values: Record<string,unknown[]> = {
      [KV.sessions]:[session], [KV.observations("s")]:rows, [KV.compressionQueue]:[],
      [KV.metrics]:[{functionId:"mem::compress",totalCalls:3484,failureCount:2014,successCount:1470}],
      [KV.summaryRepairs]:[],
    };
    const summary = {coveredFingerprint:summaryFingerprint(session,summaryObservations(rows as CompressedObservation[])),observationCount:4};
    const kv = {list:vi.fn(async (scope:string)=>values[scope]??[]),
      get:vi.fn(async (scope:string)=>scope===KV.compressionQueueHistory?
        [{sessionId:"s",observationId:"done"},{sessionId:"s",observationId:"missing"}]:
        scope===KV.compressionQueueArchive?[{sessionId:"s",observationId:"legacy"}]:
        scope===KV.summaries?summary:null),
      set:vi.fn(),delete:vi.fn()};
    const report=await auditCompression(kv as never,"known_failure");
    expect(report).toMatchObject({observations:5,totals:{complete:1,legacy:1,failed:1,pending:1,raw:1,unknown:0},
      sourceUnavailable:1,retryableUnqueued:2,knownFailuresFound:3,missingReferenceCount:1,
      knownFailureStates:{complete:1,legacy:1,failed:1},summaryTotals:{stale:1},
      historicalCalls:[{failureCount:2014}],matched:3});
    expect(report.items.map(x=>x.observationId)).toEqual(["done","legacy","failed"]);
    expect(kv.set).not.toHaveBeenCalled();expect(kv.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("toolOutput");
  });
  it("paginates all observations and does not treat legacy summaries as confirmed", async () => {
    const session={id:"s",status:"active",observationCount:101};
    const rows=Array.from({length:101},(_,i)=>({id:"o"+i,sessionId:"s",title:"Legacy",timestamp:"2026-01-01"}));
    const kv={list:async(scope:string)=>scope===KV.sessions?[session]:scope===KV.observations("s")?rows:[],
      get:async()=>null};
    const a=await auditCompression(kv as never,"all");
    expect(a.totals).toMatchObject({complete:0,legacy:101});
    expect(a.items).toHaveLength(100);expect(a.nextOffset).toBe(100);
    const b=await auditCompression(kv as never,"all",100);
    expect(b.items).toHaveLength(1);expect(b.nextOffset).toBeNull();
  });
});
