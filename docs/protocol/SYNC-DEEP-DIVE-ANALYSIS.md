# Insieme Sync Protocol — Deep-Dive Reliability Analysis & Improvement Proposals

**Date:** 2026-05-08  
**Scope:** `sync-client.js`, `sync-server.js`, `offline-transport.js`, `docs/protocol/`, `docs/sync-scenarios/`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Cursor-Based Sync Sufficiency](#2-cursor-based-sync-sufficiency)
3. [WebSocket-Only Protocol Risks](#3-websocket-only-protocol-risks)
4. [Conflict Resolution Beyond LWW](#4-conflict-resolution-beyond-lww)
5. [Broadcast Model Reliability](#5-broadcast-model-reliability)
6. [Batch Submission Atomicity](#6-batch-submission-atomicity)
7. [Rate Limiting & Backpressure](#7-rate-limiting--backpressure)
8. [Wire Format Improvement Proposals](#8-wire-format-improvement-proposals)

---

## 1. Executive Summary

The Insieme sync protocol (v1.0) is a well-designed, minimal collaboration protocol built around four primitives: **connect handshake**, **submit_events**, **sync** (cursor-based catch-up), and **event_broadcast**. It achieves strong idempotency via UUID dedup, global monotonic `committedId` ordering, and a clean LWW (last-writer-wins) convergence model.

However, several reliability gaps exist when the system is pushed toward **high-latency networks**, **large event histories**, **true concurrent editing**, and **production crash resilience**. This document analyzes each weakness and proposes specific improvements with wire-format examples.

**Key findings:**
- Cursor-based sync is adequate for small-to-medium projects but lacks snapshot acceleration for cold starts
- WebSocket-only transport has no HTTP fallback — a single blocked WS handshake blocks all sync
- LWW is sufficient only when the application layer handles merge semantics; the protocol provides no structured merge support
- Broadcast is fire-and-forget with no acknowledgment — gaps during reconnect are covered by sync, but timing windows exist
- Batch atomicity is partial: server processes items sequentially and stops on first failure, but mid-batch crashes can leave partial commits
- Rate limiting exists on the server but the client has no adaptive backpressure mechanism

---

## 2. Cursor-Based Sync Sufficiency

### 2.1 Current Design

The protocol uses a single integer cursor (`sinceCommittedId`) for incremental sync:

```
Client -> Server:  sync { sinceCommittedId: 1200, limit: 500 }
Server -> Client:  sync_response { events: [...], nextSinceCommittedId: 1700, hasMore: false }
```

**Strengths:**
- Simple to implement and reason about
- Global monotonic `committedId` guarantees no gaps
- Paged sync with fixed `syncToCommittedId` ensures convergence
- Idempotent: re-syncing the same cursor produces the same results

**Weaknesses:**

| Scenario | Problem |
|----------|---------|
| Cold start with 100K+ events | Must page through the entire history linearly |
| Cross-device first sync | No way to bootstrap without full replay |
| Multi-partition selective sync | No partition-scoped cursor; always syncs the whole project |
| Event log pruning | Once old events are pruned, cursor 0 is invalid |

### 2.2 Proposal: Snapshot + Delta Hybrid

Add a **snapshot** message type that allows clients to bootstrap from a materialized state rather than replaying the full log.

#### Wire Format — `sync_snapshot` Request

```yaml
type: sync_snapshot
protocolVersion: "1.1"
payload:
  projectId: workspace-1
  partitions:
    - workspace-1
  minCommittedId: 0        # client's current cursor (0 = fresh)
```

#### Wire Format — `sync_snapshot` Response

```yaml
type: sync_snapshot_response
protocolVersion: "1.1"
payload:
  projectId: workspace-1
  snapshotCommittedId: 45000
  snapshotTs: 1738451200000
  partitions:
    - partition: workspace-1
      stateBase64: <compressed JSON or protobuf blob>
      checksum: "sha256:a1b2c3..."
  deltaRange:
    sinceCommittedId: 45000
    totalDeltaEvents: 120
```

After receiving a snapshot, the client would issue a normal `sync { sinceCommittedId: 45000 }` to catch up from the snapshot point.

#### When to Use

| Condition | Sync Mode |
|-----------|-----------|
| `sinceCommittedId > 0` and delta is small (<5000 events) | Cursor-based (current) |
| `sinceCommittedId == 0` or delta > 50K events | Snapshot + delta |
| Snapshot unavailable or corrupted | Fallback to full cursor replay |

### 2.3 Merkle Clocks — Assessment

Merkle clocks (or Merkle DAGs) allow partition-level diff detection by comparing hash trees. They would enable:

- **Selective partition sync**: Only sync partitions that have diverged
- **Efficient multi-project sync**: One hash comparison per partition
- **Peer-to-peer sync**: Detect divergence without a central authority

**However**, Merkle clocks add significant complexity:
- Require per-partition hash maintenance on both client and server
- The current single-project, single-cursor model makes this over-engineering
- The protocol already achieves convergence via `committedId` monotonicity

**Recommendation**: Defer Merkle clocks until multi-project or P2P sync is required. The snapshot+delta hybrid addresses the cold-start problem more pragmatically.

### 2.4 Delta Sync — Assessment

Delta sync (sending only field-level changes rather than full events) would reduce bandwidth for large events:

```yaml
# Current: full event
payload: { id: A, name: "New Name", description: "Long text...", tags: [...] }

# Delta: only changed fields
payload: { id: A, _delta: { name: "New Name" } }
```

**Risk**: Delta sync requires the receiver to maintain exact state to apply deltas correctly. This conflicts with the protocol's current idempotent-replay model where any event can be applied independently.

**Recommendation**: Not appropriate for the commit-log model. Events are already the unit of change. Bandwidth optimization should be addressed at the transport layer (compression, binary encoding) rather than the semantic layer.

---

## 3. WebSocket-Only Protocol Risks

### 3.1 Current State

The protocol runs exclusively over WebSocket. The transport interface requires:

```javascript
transport.connect()
transport.disconnect()
transport.send(message)
transport.onMessage(handler)
```

All sync, submit, and broadcast messages flow through a single WebSocket connection.

**Risks:**

| Risk | Impact |
|------|--------|
| Corporate proxies blocking WebSocket upgrades | Client cannot sync at all |
| Mobile network WS connection instability | Frequent reconnect cycles |
| Initial bulk sync over WS is slow | WS framing + JSON overhead for large payloads |
| No CDN/cache layer possible | All data must traverse the WS connection |
| Load balancer WS idle timeouts | Silent connection drops |

### 3.2 Proposal: HTTP Fallback for Bulk Sync

Add an HTTP endpoint for initial sync/catch-up, keeping WebSocket for real-time broadcasts and submits.

#### Architecture

```
┌─────────────────────────────────────────────┐
│ Client                                       │
│                                              │
│  1. WS connect + handshake                   │
│  2. HTTP GET /sync?since=1200&projectId=P1   │  ← bulk sync
│  3. WS receive broadcasts                    │  ← real-time
│  4. WS submit_events                         │  ← mutations
└─────────────────────────────────────────────┘
```

#### HTTP Sync Endpoint

```
GET /api/v1/sync?projectId=workspace-1&sinceCommittedId=1200&limit=1000
Authorization: Bearer <jwt>
Accept: application/x-ndjson          # newline-delimited JSON streaming
Accept-Encoding: gzip
```

**Response** (streaming NDJSON):

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
X-Sync-Next-Committed-Id: 2200
X-Sync-Has-More: true
X-Sync-To-Committed-Id: 50000

{"committedId":1201,"id":"evt-1","partition":"P1",...}
{"committedId":1202,"id":"evt-2","partition":"P1",...}
...
```

**Benefits:**
- HTTP works through proxies, corporate firewalls
- Streaming NDJSON avoids loading entire result into memory
- HTTP caching headers allow CDN-assisted distribution of snapshots
- WS connection is freed for real-time work while HTTP sync runs in parallel

#### Protocol Change

Add a `sync_mode` field to the `connected` response:

```yaml
type: connected
protocolVersion: "1.1"
payload:
  clientId: client-123
  projectId: workspace-1
  projectLastCommittedId: 1700
  syncCapabilities:
    httpSyncUrl: "https://api.example.com/api/v1/sync"
    wsSync: true
    snapshotSupported: false
```

Client behavior:
1. On connect, receive `syncCapabilities`
2. If `httpSyncUrl` is present and delta is large, use HTTP for bulk sync
3. Always use WS for submit and broadcast
4. Fall back to WS sync if HTTP fails

### 3.3 Proposal: Binary Encoding

Replace JSON with MessagePack for wire encoding. This provides 20-40% size reduction without schema compilation complexity.

#### Wire Format — Current vs Proposed

**Current (JSON, ~342 bytes):**
```json
{
  "type": "event_broadcast",
  "protocolVersion": "1.0",
  "payload": {
    "committedId": 1201,
    "id": "evt-uuid-1",
    "partition": "workspace-1",
    "projectId": "workspace-1",
    "type": "explorer.folderCreated",
    "schemaVersion": 1,
    "payload": { "id": "A", "name": "Folder A" },
    "meta": { "clientId": "client-123", "clientTs": 1738451200000 },
    "serverTs": 1738451205000
  }
}
```

**Proposed (MessagePack binary framing, ~240 bytes):**
```
Binary frame:
  [1 byte: encoding=0x01=msgpack]
  [4 bytes: payload length, big-endian uint32]
  [msgpack-encoded envelope, field names as integers via shared schema]
```

With a shared field-ID mapping:
```
1 = type          (string)
2 = protocolVersion (string)
3 = payload       (map)
  10 = committedId  (uint32)
  11 = id           (string)
  12 = partition    (string)
  13 = projectId    (string)
  14 = type         (string)
  15 = schemaVersion (uint8)
  16 = payload      (map)
  17 = meta         (map)
    20 = clientId   (string)
    21 = clientTs   (uint64)
  18 = serverTs     (uint64)
```

**Implementation path:**
1. Add `acceptEncoding: ["json", "msgpack"]` to `connect` payload
2. Server responds with `connected.encoding: "msgpack"` if supported
3. All subsequent messages use binary frames
4. Fallback to JSON if either side doesn't support it

### 3.4 Proposal: Per-Message Compression

For JSON mode, add per-message deflate compression:

```
WS frame:
  [1 byte: flags]
    bit 0: compressed (1=yes, 0=no)
  [remaining: JSON or deflate-compressed JSON]
```

The `connected` handshake negotiates:
```yaml
type: connect
payload:
  compression: ["deflate-raw"]   # or empty for none
```

---

## 4. Conflict Resolution Beyond LWW

### 4.1 Current Design — Server Commit Order (LWW)

The protocol currently resolves concurrent writes by **server commit order**:

> "All clients converge to state produced by highest `committedId`."  
> — Scenario 14

This is effectively **Last-Writer-Wins (LWW)** where "last" is defined by server-assigned `committedId`. The server is a single sequencer.

**Where LWW works well:**
- Independent entity mutations (rename folder, update description)
- Non-overlapping field updates
- Events that are naturally commutative (add tag, remove tag)

**Where LWW fails:**
- Concurrent edits to the **same text field** (e.g., collaborative text editing)
- **Counter increments** (two clients increment from 5 → both write 6, should be 7)
- **Set operations** (two clients remove different items from a list simultaneously)
- **Structural moves** (two clients move the same item to different parents)

### 4.2 When Would CRDTs Help?

CRDTs (Conflict-Free Replicated Data Types) would help when:

1. **The application has concurrent mutation of the same entity/field** — not just "same entity" but genuinely overlapping mutations
2. **Offline editing is long-lived** — the current offline transport buffers submits and replays them, but if two offline clients both edit the same field, LWW silently discards one edit
3. **Fine-grained collaborative editing** — text editing, shared lists, shared maps

#### CRDT Integration Points

The protocol could support CRDTs **at the payload level** without changing the commit/sync infrastructure:

```yaml
# Current event payload
type: task.nameUpdated
payload: { id: T1, name: "New Name" }

# CRDT-aware event payload  
type: task.nameUpdated
payload:
  id: T1
  name:
    _crdt: "lww-register"
    value: "New Name"
    lamportTs: 42
    clientId: client-123
```

The server would still assign `committedId` for total ordering, but the **application layer** would use CRDT merge semantics when replaying events rather than simple LWW.

**Recommended CRDT types by use case:**

| Use Case | CRDT Type | Rationale |
|----------|-----------|-----------|
| Text editing | RGA (Replicated Growable Array) | Character-level concurrent edit support |
| Counters | PN-Counter (G-Counter pair) | Independent increment/decrement |
| Sets (tags, members) | OR-Set (Observed-Remove) | Add/remove concurrent operations |
| Maps (entity fields) | LWW-Register per field | Last-writer-wins per field with logical clock |
| Lists (ordered items) | Sequence CRDT (LWW-Element-Set) | Ordered concurrent insert/remove |

#### Wire Format — CRDT Metadata Extension

```yaml
type: submit_events
protocolVersion: "1.1"
payload:
  events:
    - id: evt-uuid-1
      partition: workspace-1
      projectId: workspace-1
      type: task.nameUpdated
      schemaVersion: 2
      payload:
        id: T1
        name: "New Name"
      crdt:
        field: "name"
        type: "lww-register"
        lamportTs: 42
        clientId: client-123
      meta:
        clientId: client-123
        clientTs: 1738451200000
```

**Recommendation**: Do NOT implement CRDTs in the protocol layer. Instead:
1. Add an optional `crdt` metadata field to the event envelope
2. Let the application layer handle CRDT merge on replay
3. The server remains a dumb sequencer — it doesn't need to understand CRDT semantics

### 4.3 Operational Transforms — Assessment

OT (Operational Transform) is the traditional approach for collaborative text editing (used by Google Docs). It requires:
- A central transformation server
- Strict ordering of operations
- Transform function for every pair of concurrent operations

**Why OT is NOT recommended for Insieme:**
- OT requires the server to understand operation semantics (insert/delete at positions)
- The current protocol treats events as opaque payloads — the server doesn't interpret them
- OT introduces tight coupling between client and server logic
- CRDTs achieve the same result with simpler integration

**Recommendation**: If collaborative text editing is needed, use a CRDT-based approach (Yjs, Automerge) at the application layer, not OT.

### 4.4 Practical Improvement: Conflict Detection

Even without CRDTs, the protocol can add **conflict detection** to help the application layer:

#### Wire Format — `conflict_detected` Broadcast

```yaml
type: event_broadcast
protocolVersion: "1.1"
payload:
  committedId: 1202
  id: evt-c2
  partition: workspace-1
  projectId: workspace-1
  type: task.nameUpdated
  schemaVersion: 1
  payload: { id: T1, name: "C2's version" }
  meta:
    clientId: client-c2
    clientTs: 1738451205000
  serverTs: 1738451206000
  conflict:
    detected: true
    supersededCommittedId: 1201
    supersededId: evt-c1
    supersededPayload: { id: T1, name: "C1's version" }
```

This lets the receiving application know that the event at `committedId: 1202` superseded a recent event, enabling it to show a "conflict resolved" notification or trigger a merge UI.

---

## 5. Broadcast Model Reliability

### 5.1 Current Design

The broadcast model is **fire-and-forget**:

```javascript
// sync-server.js, line 434-446
for (const session of recipients) {
  await sendMessage(session.transport, "event_broadcast", committedEvent, {
    msgId: broadcastMsgId,
  });
}
```

Key behaviors:
- Server broadcasts to all active sessions **except the originator** and **sessions in active sync**
- If `transport.send()` fails, the broadcast is silently lost
- Missed broadcasts are recovered by sync on next reconnect
- Broadcasts are suppressed during active sync cycles (`syncInProgress: true`)

### 5.2 Identified Weaknesses

| Weakness | Severity | Scenario |
|----------|----------|----------|
| **Fire-and-forget delivery** | Medium | If WS send fails (network blip, buffer full), the broadcast is lost until next sync |
| **Broadcast suppression creates gaps** | Low | During sync, broadcasts are suppressed; after sync completes, there's a gap before the client is "live" again |
| **No broadcast acknowledgment** | Medium | Server has no way to know if a broadcast was received and applied |
| **Sequential broadcast fan-out** | Medium | `for...of` with `await` means one slow client blocks all subsequent broadcasts |
| **No broadcast ordering guarantee** | Low | Broadcasts to different clients may arrive in different orders (mitigated by `committedId`-based ordering in application) |

### 5.3 The Sync Recovery Safety Net

The protocol's most important reliability feature is that **sync is always the recovery mechanism**. Even if broadcasts are lost:

1. Client reconnects → `connect` → receives `projectLastCommittedId`
2. Client compares with local cursor → issues `sync` if behind
3. Sync pages through all missed events
4. Client is now consistent

This means broadcast loss is a **latency problem**, not a **correctness problem**. However, latency matters for real-time collaboration UX.

### 5.4 Proposal: Broadcast Acknowledgment (Optional Enhancement)

Add a lightweight ack mechanism for broadcasts:

#### Wire Format — Broadcast with Ack

```yaml
# Server -> Client
type: event_broadcast
protocolVersion: "1.1"
payload:
  committedId: 1201
  id: evt-uuid-1
  # ... standard event fields ...
  broadcastSeq: 42     # per-connection monotonic sequence
```

#### Wire Format — Broadcast Ack

```yaml
# Client -> Server
type: broadcast_ack
protocolVersion: "1.1"
payload:
  lastBroadcastSeq: 42
```

**Server behavior:**
- Track `lastAckedBroadcastSeq` per session
- On reconnect, server checks: if `lastAckedBroadcastSeq < lastSentBroadcastSeq`, automatically include missed broadcasts in sync response
- Client doesn't need to change sync logic

**Benefits:**
- Server can detect broadcast gaps without waiting for client to notice
- Enables server-side metrics on broadcast delivery rate
- Minimal overhead (one small message per N broadcasts, or piggybacked on next client message)

### 5.5 Proposal: Parallel Fan-Out

Replace sequential broadcast with parallel:

```javascript
// Current (sequential, blocking):
for (const session of recipients) {
  await sendMessage(session.transport, "event_broadcast", committedEvent);
}

// Proposed (parallel, non-blocking):
await Promise.allSettled(
  recipients.map(session =>
    sendMessage(session.transport, "event_broadcast", committedEvent)
      .catch(err => log({ event: "broadcast_failed", connectionId: session.transport.connectionId, error: err }))
  )
);
```

**Trade-off**: Parallel fan-out means broadcasts may arrive out-of-order across clients, but the protocol already handles this via `committedId` ordering. Parallel fan-out prevents one slow client from blocking all others.

### 5.6 The Gap Window Problem

**Scenario**: Client completes sync at `committedId: 1700`. Server then commits event `1701`. But between the sync completing and the client's state transitioning to "receiving broadcasts," event `1701` might be committed but not broadcast to this client.

**Current mitigation**: The `syncToCommittedId` is captured at the first sync page. After sync completes (`hasMore=false`), the client's cursor is at `syncToCommittedId`. Any events after that are broadcast in real-time.

**Remaining risk**: There's a tiny window between "sync response sent" and "session marked as ready for broadcasts." During this window, a committed event could be missed.

**Fix**: After sync completes, the server should check if any new events were committed since `syncToCommittedId` and immediately queue them:

```javascript
// After sync cycle completes:
session.syncInProgress = false;
const newMax = await store.getMaxCommittedIdForProject({ projectId });
if (newMax > syncToCommittedId) {
  // Queue a mini-sync or broadcasts for the gap
  await sendMissedGapEvents(session, syncToCommittedId, newMax);
}
```

---

## 6. Batch Submission Atomicity

### 6.1 Current Design

The server processes `submit_events` batches as follows (`sync-server.js`, lines 552-731):

```
For each event in batch:
  If blockedById is set:
    Mark as "not_processed"
    Continue
  
  Validate event
  
  If validation fails:
    Mark as "rejected"
    Set blockedById = event.id
    Continue
  
  Commit event to store
  Add to committedEvents
  
Send submit_events_result
Broadcast committed events
```

**Key behaviors:**
- Events are processed sequentially in request order
- First rejection blocks all subsequent events in the batch (`not_processed`)
- Each successful commit is individually persisted before moving to the next
- Results are sent after all items are processed

### 6.2 Crash Scenarios

| Crash Point | State | Recovery |
|-------------|-------|----------|
| Before any commit | No events persisted | Client retries full batch (idempotent by UUID) |
| After committing event N of M | Events 1..N persisted, N+1..M not processed | Client receives no response, reconnects, syncs, sees 1..N. Drafts for N+1..M are retried |
| After persisting all events, before sending result | All events persisted | Client retries, server dedupes by event `id`, returns existing commits |
| After sending result, before broadcasting | All events persisted, origin informed, peers uninformed | Peers miss broadcasts but recover on next sync |

### 6.3 Identified Weakness: Partial Batch Not Processed Correctly

**Scenario**: A batch of 3 events. Event 1 commits successfully. Event 2 fails validation. Event 3 is marked `not_processed`.

```
Results:
  [{ id: E1, status: committed, committedId: 501 },
   { id: E2, status: rejected, reason: validation_failed },
   { id: E3, status: not_processed, blockedById: E2 }]
```

The client handles this correctly: E1 is committed, E2 is rejected (draft removed), E3 remains a draft for later retry. ✅

### 6.4 Identified Weakness: Mid-Batch Crash

**Scenario**: Server crashes after committing E1 but before processing E2.

```
Server state: E1 committed (committedId: 501)
Client state: No response received → reconnects → syncs from cursor → receives E1
Client state: E2 and E3 remain as drafts → retried in next flush cycle
```

This is handled correctly because:
- E1 is durably persisted → recovered via sync
- E2, E3 are not processed → remain as drafts → retried
- If client retries E1 with same `id`, server dedupes → returns existing commit

**However**, there's a subtle issue: the client retries E2 and E3 as a new batch. If E2 was a dependent event (e.g., "create folder A" then "create file in folder A"), E2 might now fail because the context changed during the reconnect gap.

**Recommendation**: This is an application-level concern. The protocol correctly preserves E2/E3 as drafts. The application should handle dependency failures through validation errors and user feedback.

### 6.5 Proposal: Transactional Batch Commit

For stronger atomicity, the server could use a database transaction for the entire batch:

```javascript
// Proposed: Transactional batch
await db.transaction(async (tx) => {
  for (const item of payload.events) {
    // validate + commit within transaction
    const { committedEvent } = await store.commitOrGetExisting(tx, item);
    committedEvents.push(committedEvent);
  }
  // All-or-nothing: if any commit fails, entire transaction rolls back
});
```

**Trade-offs:**
- ✅ Atomic: either all events commit or none do
- ✅ No partial state on crash
- ❌ Reduces throughput (longer transaction hold time)
- ❌ Larger transactions may conflict with concurrent connections
- ❌ Requires store to support transactions

**Recommendation**: Only implement if the application has tight event dependencies within batches. The current sequential commit is sufficient for most cases because the dedup mechanism handles retries cleanly.

### 6.6 Proposal: Batch ID for Crash Recovery

Add a batch identifier to enable more precise crash recovery:

```yaml
type: submit_events
protocolVersion: "1.1"
payload:
  batchId: batch-uuid-1       # optional, client-generated
  events:
    - id: evt-1
      # ...
    - id: evt-2
      # ...
```

Server records `batchId` alongside committed events. On reconnect, client can query:

```yaml
type: batch_status
payload:
  batchId: batch-uuid-1
```

```yaml
type: batch_status_response
payload:
  batchId: batch-uuid-1
  status: completed    # completed | partial | unknown
  committedIds: [501, 502]
  rejectedIds: []
  notProcessedIds: []
```

This eliminates the ambiguity of "did the server receive my batch?"

---

## 7. Rate Limiting & Backpressure

### 7.1 Current Design

**Server-side rate limiting** (`sync-server.js`, lines 258-320):

```javascript
const inboundLimits = {
  maxInboundMessagesPerWindow: 200,    // messages per window
  rateWindowMs: 1000,                   // 1-second window
  maxEnvelopeBytes: 256 * 1024,         // 256KB max message
  closeOnRateLimit: true,               // close connection on violation
  closeOnOversize: true,                // close on oversized message
};
```

**Client-side batching** (`sync-client.js`, lines 84-93):

```javascript
const batching = {
  maxEvents: 50,              // max events per submit batch
  maxBytes: 64 * 1024,        // 64KB max batch size
};
```

### 7.2 Identified Weaknesses

| Weakness | Impact |
|----------|--------|
| **No client-side rate awareness** | Client doesn't know server limits, may repeatedly hit rate limit and get disconnected |
| **Close-on-rate-limit is aggressive** | A burst of 201 messages in 1 second kills the connection, losing all in-flight state |
| **No backpressure signal** | Server cannot tell client to slow down without closing the connection |
| **No priority queuing** | Submit and sync compete for the same rate budget |
| **Offline buffer unbounded growth** | `maxBufferedSubmits: 10_000` with no backpressure to the application layer |
| **No per-project rate limiting** | One chatty client can exhaust rate limits for the entire connection |

### 7.3 Proposal: Backpressure Signal

Add a `backpressure` message that allows the server to signal the client to slow down without closing the connection:

#### Wire Format — `backpressure`

```yaml
# Server -> Client
type: backpressure
protocolVersion: "1.1"
payload:
  action: slow_down           # slow_down | resume
  suggestedDelayMs: 100       # minimum delay between messages
  reason: submit_rate_high
  currentRate: 180            # messages in current window
  maxRate: 200                # server limit
```

**Client behavior on receiving `backpressure` with `action: slow_down`:**
1. Set minimum delay between outbound messages to `suggestedDelayMs`
2. Increase batch size (fewer, larger messages)
3. Defer non-critical sync requests

**Client behavior on receiving `backpressure` with `action: resume`:**
1. Remove minimum delay
2. Resume normal batch size

### 7.4 Proposal: Rate Limit Headers in `connected`

Server advertises rate limits during handshake:

```yaml
type: connected
protocolVersion: "1.1"
payload:
  clientId: client-123
  projectId: workspace-1
  projectLastCommittedId: 1700
  rateLimits:
    maxMessagesPerWindow: 200
    windowMs: 1000
    maxEnvelopeBytes: 262144
    maxBatchEvents: 50
    maxBatchBytes: 65536
  backpressureSupported: true
```

Client can then:
- Pre-configure batch sizes to stay within limits
- Implement local rate limiting to avoid hitting server limits
- Respect `suggestedDelayMs` from backpressure signals

### 7.5 Proposal: Graceful Rate Limit (Don't Close)

Instead of closing the connection on rate limit violation, switch to a **reject-and-queue** model:

```javascript
// Server behavior on rate limit:
if (session.rateWindowCount > inboundLimits.maxInboundMessagesPerWindow) {
  // Instead of closing, send a backpressure signal
  await sendMessage(session.transport, "backpressure", {
    action: "slow_down",
    suggestedDelayMs: 500,
    reason: "rate_limited",
  });
  
  // Drop the message but keep the connection open
  // Client must retry
  return;
}
```

Only close after repeated violations (e.g., 3 backpressure signals in 10 seconds).

### 7.6 Client-Side Adaptive Batching

The client should adapt its batch size based on feedback:

```javascript
let adaptiveBatchConfig = {
  currentDelay: 0,        // ms between batches
  currentBatchSize: 50,   // events per batch
  consecutiveSuccesses: 0,
  consecutiveErrors: 0,
};

// On successful submit:
adaptiveBatchConfig.consecutiveSuccesses++;
if (adaptiveBatchConfig.consecutiveSuccesses > 10) {
  adaptiveBatchConfig.currentDelay = Math.max(0, adaptiveBatchConfig.currentDelay - 10);
}

// On backpressure signal:
adaptiveBatchConfig.currentDelay = signal.suggestedDelayMs;
adaptiveBatchConfig.currentBatchSize = Math.max(1, adaptiveBatchConfig.currentBatchSize / 2);
adaptiveBatchConfig.consecutiveErrors++;

// On rate_limited error:
adaptiveBatchConfig.currentDelay *= 2;  // exponential backoff
```

### 7.7 Offline Buffer Backpressure

The offline transport should signal the application when buffer is nearing capacity:

```javascript
// Current: silent drop at maxBufferedSubmits
if (bufferedSubmits.length < maxBufferedSubmits) {
  bufferedSubmits.push(message);
} else {
  // emit rate_limited error
}

// Proposed: gradual backpressure
const BUFFER_HIGH_WATERMARK = maxBufferedSubmits * 0.8;
const BUFFER_LOW_WATERMARK = maxBufferedSubmits * 0.5;

if (bufferedSubmits.length >= maxBufferedSubmits) {
  emit({ type: "error", payload: { code: "offline_buffer_full" } });
} else if (bufferedSubmits.length >= BUFFER_HIGH_WATERMARK) {
  emit({ type: "backpressure", payload: { action: "slow_down", bufferUsage: 0.85 } });
} else if (bufferedSubmits.length <= BUFFER_LOW_WATERMARK) {
  emit({ type: "backpressure", payload: { action: "resume" } });
}
```

---

## 8. Wire Format Improvement Proposals

### 8.1 Protocol Version Negotiation

Current: Single version `"1.0"`. Client sends it, server accepts or rejects.

Proposed: Semantic negotiation:

```yaml
# Client -> Server
type: connect
protocolVersion: "1.1"
payload:
  token: jwt
  clientId: client-123
  projectId: workspace-1
  capabilities:
    encoding: ["json", "msgpack"]
    compression: ["none", "deflate-raw"]
    maxBatchEvents: 100
    maxBatchBytes: 131072
    httpSyncUrl: null
    backpressure: true
    broadcastAck: true

# Server -> Client
type: connected
protocolVersion: "1.1"
payload:
  clientId: client-123
  projectId: workspace-1
  projectLastCommittedId: 1700
  negotiated:
    encoding: msgpack
    compression: deflate-raw
    backpressure: true
    broadcastAck: false
    rateLimits:
      maxMessagesPerWindow: 200
      windowMs: 1000
      maxEnvelopeBytes: 262144
```

### 8.2 Summary of Proposed New Message Types

| Message | Direction | Purpose |
|---------|-----------|---------|
| `sync_snapshot` | C→S | Request snapshot for fast cold-start sync |
| `sync_snapshot_response` | S→C | Deliver compressed snapshot + delta range |
| `broadcast_ack` | C→S | Acknowledge received broadcast sequence |
| `backpressure` | S→C | Signal client to slow down or resume |
| `batch_status` | C→S | Query batch outcome after reconnect |
| `batch_status_response` | S→C | Return batch outcome |

### 8.3 Implementation Priority Matrix

| Improvement | Impact | Effort | Priority |
|-------------|--------|--------|----------|
| HTTP fallback for bulk sync | High | Medium | **P1** |
| Rate limit headers in `connected` | High | Low | **P1** |
| Backpressure signal | High | Medium | **P1** |
| Parallel broadcast fan-out | Medium | Low | **P1** |
| Broadcast ack (optional) | Medium | Medium | **P2** |
| Gap window fix after sync | Medium | Low | **P2** |
| Binary encoding (MessagePack) | Medium | Medium | **P2** |
| Snapshot + delta sync | High | High | **P3** |
| Batch ID for crash recovery | Low | Low | **P3** |
| CRDT metadata extension | Medium | High | **P3** |
| Per-message compression | Low | Medium | **P4** |
| Conflict detection metadata | Low | Medium | **P4** |

### 8.4 Backward Compatibility Strategy

All proposals maintain backward compatibility:

1. **Protocol version `"1.1"`** is optional — servers that only support `"1.0"` will reject it and close. Client falls back to `"1.0"` behavior.
2. **New message types** are only sent when negotiated in `capabilities`.
3. **Optional fields** (e.g., `batchId`, `crdt`, `broadcastSeq`) are ignored by servers/clients that don't understand them (per existing envelope rule: "Unknown extra fields MUST be ignored").
4. **HTTP sync** is a parallel channel — WebSocket protocol is unaffected.

---

## Appendix A: Current Protocol Message Flow Diagram

```
Client                          Server
  │                                │
  │──── connect ──────────────────>│  handshake
  │<─── connected ────────────────│
  │                                │
  │──── sync ─────────────────────>│  catch-up
  │<─── sync_response (page 1) ──│
  │──── sync ─────────────────────>│
  │<─── sync_response (final) ────│
  │                                │
  │──── submit_events ───────────>│  mutation
  │<─── submit_events_result ────│
  │                                │
  │    (other client submits)      │
  │<─── event_broadcast ──────────│  real-time
  │                                │
  │──── submit_events ───────────>│  another mutation
  │<─── submit_events_result ────│
  │                                │
  │    (connection drops)          │
  │──── connect ──────────────────>│  reconnect
  │<─── connected ────────────────│
  │──── sync ─────────────────────>│  catch-up
  │<─── sync_response ────────────│
```

## Appendix B: Proposed Enhanced Message Flow

```
Client                          Server
  │                                │
  │──── connect (v1.1, caps) ────>│  negotiate
  │<─── connected (negotiated) ──│
  │                                │
  │──── sync_snapshot ───────────>│  fast cold-start (if needed)
  │<─── sync_snapshot_response ──│
  │──── sync ─────────────────────>│  delta catch-up
  │<─── sync_response ────────────│
  │                                │
  │──── submit_events ───────────>│  mutation
  │<─── submit_events_result ────│
  │                                │
  │<─── backpressure (optional) ──│  flow control
  │──── broadcast_ack ───────────>│  reliability
  │                                │
  │<─── event_broadcast ──────────│  real-time
  │──── broadcast_ack ───────────>│
  │                                │
  │    (connection drops)          │
  │──── connect ──────────────────>│  reconnect
  │<─── connected ────────────────│
  │──── batch_status ────────────>│  check lost batch
  │<─── batch_status_response ────│
  │──── sync ─────────────────────>│  catch-up
  │<─── sync_response ────────────│
```
