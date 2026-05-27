# Insieme Competitive Analysis — Offline-First Sync Libraries

**Date:** May 8, 2026  
**Scope:** Architecture comparison of 9 competitors against Insieme v2.1.1  
**Purpose:** Identify architectural patterns, strengths, and lessons Insieme can adopt

---

## Table of Contents

1. [Insieme Profile](#1-insieme-profile)
2. [Competitor Profiles](#2-competitor-profiles)
3. [Comparison Matrix](#3-comparison-matrix)
4. [Lessons for Insieme](#4-lessons-for-insieme)
5. [Strategic Recommendations](#5-strategic-recommendations)
6. [Appendix: Feature Detail Matrix](#6-appendix-feature-detail-matrix)

---

## 1. Insieme Profile

| Attribute | Detail |
|-----------|--------|
| **Version** | 2.1.1 |
| **License** | MIT |
| **Architecture** | Authoritative server + event-sourced client |
| **Sync Protocol** | Custom cursor-based (`committedId`) over WebSocket |
| **Transport** | WebSocket-only (no HTTP fallback) |
| **Conflict Resolution** | First-writer-wins (server commit order = LWW by `committedId`) |
| **Offline Support** | Offline transport wraps online transport; drafts buffered locally; replayed on reconnect |
| **Storage Backends** | SQLite, LibSQL (Turso), IndexedDB, in-memory (5 client store variants) |
| **Query Capabilities** | Materialized views via event replay with user-defined reducers; no built-in query engine |
| **Scaling Model** | Single server; per-project event streams; broadcast fan-out to active sessions |
| **Dependencies** | `immer`, `nanoid` (minimal) |
| **Wire Format** | JSON over WebSocket frames |
| **Reconnection** | Exponential backoff with jitter; configurable policy |
| **Event Model** | Flat event log with `partition` and `projectId` scoping; no aggregate boundaries |
| **Idempotency** | UUID-based event deduplication on server |
| **Checkpointing** | Materialized view checkpoints with configurable modes (immediate/debounced/interval) |

### 1.1 Insieme's Architectural Strengths

1. **Minimal dependency footprint** — Only 2 runtime dependencies (immer, nanoid)
2. **Protocol-level idempotency** — UUID dedup ensures safe retries after crashes
3. **Multiple storage backends** — Works in browser (IndexedDB), desktop (SQLite/LibSQL), and server (in-memory/SQLite)
4. **Offline-first by design** — Offline transport adapter transparently buffers submissions
5. **Materialized view runtime** — Checkpointed event replay with configurable debounce/interval modes
6. **Clean client/server separation** — Server is a dumb sequencer; all domain logic lives in reducers

### 1.2 Insieme's Known Weaknesses (from internal analysis)

1. **No HTTP fallback** — WebSocket-only transport fails behind corporate proxies
2. **No snapshot acceleration** — Cold starts must replay entire event history linearly
3. **Flat event model** — No aggregate boundaries for domain modeling
4. **LWW-only conflict resolution** — No CRDT support, no structured merge, no conflict detection
5. **Monolithic client/server** — 1,059-line and 1,047-line closures with implicit state machines
6. **Store code duplication** — ~2,600 duplicated lines across 5 store implementations (~70%)
7. **Fire-and-forget broadcast** — No acknowledgment; sequential fan-out blocks on slow clients
8. **No built-in query engine** — Consumers must build their own projection/replay systems

---

## 2. Competitor Profiles

### 2.1 PowerSync

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Client-side SQLite with server-side Postgres as source of truth |
| **Sync Protocol** | Custom streaming protocol; bidirectional sync via persistent connection |
| **Conflict Resolution** | Last-writer-wins by default; custom merge logic supported via "buckets" |
| **Offline Support** | Full offline-first; writes to local SQLite; syncs when online |
| **Storage Backends** | Client: SQLite (via OP-SQLite or wa-sqlite); Server: PostgreSQL |
| **Query Capabilities** | Full SQL on local SQLite; reactive queries via watchers |
| **Scaling Model** | Postgres-backed; rules engine for per-row access control; supports Supabase integration |
| **Languages** | Dart/Flutter primary; Kotlin (alpha); Swift (alpha); JS/React Native |
| **License** | Source-available (BSL 1.1); core client Apache 2.0 |
| **Maturity** | Production-ready; venture-funded company |

**Architecture Approach:** PowerSync treats Postgres as the authoritative source and maintains a client-side SQLite mirror. The sync engine streams changes from Postgres logical replication (via a custom connector) to clients. Writes go to local SQLite first, then are uploaded and applied to Postgres.

**Key Innovation:** "Buckets" — sync rules partition data into buckets (like Insieme's partitions), and each bucket has independent sync state. This allows fine-grained access control and selective sync.

**Reactive Queries:** PowerSync's strongest differentiator is its reactive query system. Consumers wrap SQL queries with `watch()` which returns a streaming result set that updates in real-time as the underlying data changes. This eliminates the need for manual materialized view management.

**Lessons for Insieme:**
- **Reactive query layer** — Insieme's materialized views require consumers to manage subscriptions manually. PowerSync's `watch()` pattern is dramatically simpler for consumers.
- **Bucket-based sync rules** — PowerSync's declarative sync rules (SQL WHERE clauses) control which rows sync to which users. Insieme has `partition` scoping but no declarative access control.
- **Postgres integration** — PowerSync leverages Postgres's mature replication infrastructure rather than building its own commit log.

---

### 2.2 ElectricSQL

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Postgres logical replication → shape-based sync → local SQLite |
| **Sync Protocol** | HTTP-based; shapes (logical data partitions) with real-time updates via HTTP streaming/SSE |
| **Conflict Resolution** | LWW by Postgres commit timestamp; CRDT primitives planned |
| **Offline Support** | Full offline; writes buffered locally; synced on reconnect |
| **Storage Backends** | Client: SQLite (wa-sqlite in browser, better-sqlite3 in Node); Server: PostgreSQL |
| **Query Capabilities** | Full SQL on local SQLite; no reactive queries yet |
| **Scaling Model** | Postgres-backed; shape-based partitioning; horizontally scalable sync service |
| **Languages** | TypeScript/JavaScript |
| **License** | Apache 2.0 |
| **Maturity** | Active development; well-funded; production users |

**Architecture Approach:** ElectricSQL sits between Postgres and clients. It reads Postgres's logical replication stream and translates it into "shapes" — logical data partitions defined by queries (e.g., "all tasks in project X where status = active"). Clients subscribe to shapes and receive incremental updates.

**Key Innovation:** "Shapes" — Instead of syncing entire tables, ElectricSQL syncs the result of queries. This is conceptually similar to Insieme's partitions but more expressive because shapes are defined by arbitrary SQL WHERE clauses.

**HTTP-First Protocol:** ElectricSQL uses HTTP for sync, not WebSocket. Initial shape loads are HTTP requests. Real-time updates use SSE (Server-Sent Events) or HTTP streaming. This is more resilient to proxies and firewalls than WebSocket-only approaches.

**Lessons for Insieme:**
- **Shape-based sync** — Moving from flat partition-based sync to query-defined shapes would allow consumers to sync only the data they need.
- **HTTP-first transport** — ElectricSQL's HTTP/SSE approach is more resilient than Insieme's WebSocket-only transport. The proposed HTTP sync fallback in Insieme's protocol analysis directly addresses this.
- **Logical replication** — Leveraging Postgres's native replication rather than building a custom commit log reduces infrastructure complexity.

---

### 2.3 RxDB

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Reactive document database with pluggable storage and sync engines |
| **Sync Protocol** | Pluggable: CouchDB replication, GraphQL, WebRTC, custom backends |
| **Conflict Resolution** | LWW by default; custom conflict handlers per collection |
| **Offline Support** | Full offline-first; all data in local storage; syncs when connected |
| **Storage Backends** | IndexedDB, LokiJS (in-memory), OPFS, SQLite, FoundationDB, custom |
| **Query Capabilities** | MongoDB-style query language; reactive queries via Observables (RxJS) |
| **Scaling Model** | Client-centric; server is pluggable; P2P via WebRTC possible |
| **Languages** | TypeScript/JavaScript |
| **License** | Apache 2.0 (core); some plugins commercial |
| **Maturity** | Very mature; 8+ years; large community |

**Architecture Approach:** RxDB is a reactive, offline-first, NoSQL-style database that runs in the browser/Node. It wraps storage engines and provides a MongoDB-like query interface with reactive subscriptions. Sync is a plugin — you choose the backend and protocol.

**Key Innovation:** "Everything is Observable" — RxDB's core architectural principle is that all data access returns RxJS Observables. Queries return live result sets that update automatically as data changes. This eliminates the gap between "data at rest" and "data in motion."

**Pluggable Everything:** RxDB's most distinctive feature is its plugin architecture. Storage, replication, encryption, query, and validation are all pluggable. This makes it extremely flexible but also creates complexity — consumers must assemble their own stack from 30+ plugins.

**Lessons for Insieme:**
- **Reactive by default** — RxDB proves that reactive queries are table stakes for modern offline-first libraries. Insieme's materialized views are powerful but not reactive out of the box.
- **Pluggable storage** — RxDB abstracts storage behind a common interface, eliminating the duplication problem Insieme has across 5 stores.
- **Custom conflict handlers** — RxDB allows per-collection conflict handlers, giving consumers control over merge semantics beyond LWW. Insieme could benefit from this pattern.

---

### 2.4 WatermelonDB

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Lazy-loading SQLite database with reactive queries; designed for React/React Native |
| **Sync Protocol** | Application-level sync protocol; consumer implements backend adapter |
| **Conflict Resolution** | LWW; application-level resolution via sync adapter |
| **Offline Support** | Full offline; SQLite-first; optimized for large datasets |
| **Storage Backends** | SQLite (native on iOS/Android, better-sqlite3 on Node, wa-sqlite in browser) |
| **Query Capabilities** | Custom query builder (Q.where, Q.on); reactive via withObservations |
| **Scaling Model** | Client-focused; lazy loading handles 10K+ records efficiently |
| **Languages** | TypeScript/JavaScript |
| **License** | MIT |
| **Maturity** | Mature; 6+ years; used by production apps |

**Architecture Approach:** WatermelonDB is designed for React/React Native apps that need to handle large local datasets efficiently. Its key architectural principle is **lazy loading** — records are loaded on demand rather than all at once. This makes it efficient for datasets with tens of thousands of records.

**Key Innovation:** Lazy Loading Architecture — WatermelonDB never loads full tables into memory. Instead, it uses a custom query builder that compiles to SQL and returns lazy iterators. For a sync library, this is relevant because it solves the "cold start with 100K+ events" problem that Insieme faces.

**Sync Design:** WatermelonDB takes a surprisingly hands-off approach to sync. It provides:
- A sync protocol specification (push/pull phases)
- Local change tracking (what changed since last sync)
- A `synchronize()` function that consumers call with their own push/pull implementations

The consumer is responsible for the backend. This makes WatermelonDB more of a "local database with sync primitives" than a "sync library."

**Lessons for Insieme:**
- **Lazy loading** — WatermelonDB's lazy-load architecture solves the cold-start problem without snapshots. Insieme could benefit from lazy materialized view hydration.
- **Change tracking** — WatermelonDB tracks changes at the record level (created/updated/deleted since last sync). Insieme tracks changes as event drafts but doesn't expose a change log API to consumers.
- **Simpler sync contract** — WatermelonDB's push/pull sync model is simpler to understand than Insieme's cursor-based protocol. Simplicity in the sync contract reduces integration friction.

---

### 2.5 PouchDB / CouchDB

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Peer-to-peer document sync; CouchDB server + PouchDB client |
| **Sync Protocol** | CouchDB replication protocol (HTTP-based; _rev-based MVCC) |
| **Conflict Resolution** | Deterministic conflict detection via revision tree; application-level resolution |
| **Offline Support** | Full offline; PouchDB is a complete CouchDB client that works offline |
| **Storage Backends** | Client: IndexedDB, WebSQL, LevelDB (Node); Server: CouchDB (B-tree storage) |
| **Query Capabilities** | MapReduce views (Mango queries for CouchDB 2+) |
| **Scaling Model** | Horizontal via CouchDB clustering; P2P sync between PouchDB instances possible |
| **Languages** | JavaScript |
| **License** | Apache 2.0 |
| **Maturity** | Very mature; 10+ years; Apache Foundation project |

**Architecture Approach:** PouchDB/CouchDB pioneered the offline-first sync pattern. CouchDB uses Multi-Version Concurrency Control (MVCC) with a revision tree (`_rev`). Each document mutation creates a new revision. When conflicts occur, both revisions are stored, and the application chooses the winner.

**Key Innovation:** Revision Tree — Every document has a revision history tree. When two clients edit the same document offline, both revisions are stored on sync. CouchDB picks a winner deterministically (by comparing `_rev` strings), but the losing revision is preserved and accessible. The application can then merge or resolve the conflict.

**HTTP-Based Protocol:** The CouchDB replication protocol runs entirely over HTTP. This makes it work through any proxy or firewall. Replication is simply a series of GET/POST requests to `_bulk_docs`, `_changes`, and `_revs_diff` endpoints.

**Lessons for Insieme:**
- **Explicit conflict detection** — PouchDB/CouchDB's revision tree makes conflicts visible and resolvable. Insieme's LWW silently discards one writer's changes. Adding a `conflict_detected` metadata field (as proposed in the protocol deep-dive) would address this.
- **HTTP replication** — CouchDB's HTTP-based replication is universally compatible. Insieme's WebSocket-only approach is a known risk.
- **Deterministic conflict winner** — Even without CRDTs, having a deterministic conflict resolution algorithm (not just "server commit order") makes behavior predictable across clients.
- **P2P sync** — PouchDB can sync directly with other PouchDB instances. While Insieme's authoritative server model doesn't require P2P, enabling peer-to-peer state exchange could reduce server load in collaborative scenarios.

---

### 2.6 Yjs / Automerge

| Attribute | Detail |
|-----------|--------|
| **Architecture** | CRDT-based state synchronization; no authoritative server required |
| **Sync Protocol** | Custom binary sync protocol (Yjs); Automerge sync protocol |
| **Conflict Resolution** | CRDTs (mathematically guaranteed convergence) |
| **Offline Support** | Full offline; all state is local; sync when connected |
| **Storage Backends** | Client: IndexedDB, SQLite, LevelDB, custom; Server: any (relay-only) |
| **Query Capabilities** | Yjs: Y.Array, Y.Map, Y.Text, Y.Xml (structured CRDT types); Automerge: document-level |
| **Scaling Model** | Client-to-client via relay servers; no server-side state computation |
| **Languages** | JavaScript/TypeScript |
| **License** | MIT |
| **Maturity** | Production-ready; active research communities |

**Architecture Approach:** Yjs and Automerge represent a fundamentally different approach: instead of an authoritative server resolving conflicts, CRDTs mathematically guarantee convergence regardless of operation ordering or network partitions. The server is reduced to a message relay.

**Yjs** provides structured CRDT types (Y.Text, Y.Map, Y.Array, Y.Xml) that support fine-grained concurrent editing. It uses a custom binary encoding that is extremely compact. Yjs is the CRDT engine behind collaborative editors like TipTap, Slate, and others.

**Automerge** provides a document-level CRDT where the entire document state is a CRDT. Automerge 2.0 (automerge-repo) added a sync protocol and networking layer. It's research-oriented with strong theoretical foundations.

**Key Innovation:** Mathematically guaranteed convergence — CRDTs eliminate the need for conflict resolution entirely. Any two clients that have seen the same set of operations will converge to the same state, regardless of order.

**Lessons for Insieme:**
- **CRDT as application-layer plugin** — Insieme's protocol deep-dive already proposes CRDT metadata as an optional event payload extension. Yjs proves this is viable: keep the transport protocol simple and let the application layer handle CRDT semantics.
- **Binary encoding** — Yjs's custom binary encoding achieves 5-10x smaller payloads than JSON. Insieme's proposed MessagePack encoding is a step in this direction but doesn't go as far.
- **Server as relay** — Insieme's authoritative server does more work (sequencing, validation, broadcast) than a CRDT relay would. For some use cases, a relay-only mode could reduce operational complexity.
- **Structured CRDT types** — If Insieme adds CRDT support, providing structured types (text, counter, set) at the reducer level rather than leaving everything to the consumer would dramatically reduce integration friction.

---

### 2.7 Triplit

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Distributed SQLite with server-assisted sync; full-stack database |
| **Sync Protocol** | Custom binary protocol over WebSocket; delta-based sync |
| **Conflict Resolution** | LWW with pluggable conflict resolution |
| **Offline Support** | Full offline; SQLite on client; queries work offline |
| **Storage Backends** | Client: SQLite (wa-sqlite); Server: SQLite (better-sqlite3) |
| **Query Capabilities** | Full query engine with filtering, ordering, pagination; reactive queries |
| **Scaling Model** | Single server; per-client delta tracking; designed for small-to-medium apps |
| **Languages** | TypeScript/JavaScript |
| **License** | Polyform Strict (source-available; not open source) |
| **Maturity** | Early stage; venture-funded; active development |

**Architecture Approach:** Triplit provides a full-stack database experience: schema definition, queries, mutations, and sync all in one package. The client runs SQLite locally, and the server also runs SQLite. Changes are tracked as deltas and synced bidirectionally.

**Key Innovation:** Triplit's claim is "the database that syncs" — it combines a local query engine, a sync engine, and a server into a single abstraction. Consumers define a schema, write queries, and get sync automatically.

**TriplitDB Query Engine:** Triplit implements its own query engine on top of SQLite, supporting:
- Relational queries across collections
- Filtering with comparison operators
- Ordering and pagination
- Variable binding for parameterized queries

This is relevant because Insieme has no query engine — consumers must build their own via materialized views and reducers.

**Lessons for Insieme:**
- **Schema definition** — Triplit's schema-first approach (define collections with types) gives consumers type safety and automatic validation. Insieme's schema-free events require consumers to validate manually.
- **Integrated query engine** — Triplit proves that an offline-first library can include a query engine without becoming bloated. Insieme could layer a lightweight query engine on top of its materialized views.
- **Delta-based sync** — Triplit syncs only changed fields rather than entire events. While Insieme's protocol analysis correctly identifies the trade-offs of delta sync, Triplit shows it's viable for certain use cases.

---

### 2.8 Convex

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Real-time backend-as-a-service with reactive query engine |
| **Sync Protocol** | Custom WebSocket protocol; function-based mutations; reactive subscriptions |
| **Conflict Resolution** | Optimistic concurrency with serializable transactions; no offline writes |
| **Offline Support** | Limited; optimistic updates with server confirmation; no offline write queue |
| **Storage Backends** | Convex cloud (proprietary); document-based storage |
| **Query Capabilities** | Full reactive query engine; TypeScript query functions; relational queries |
| **Scaling Model** | Cloud-managed; auto-scaling; per-function execution |
| **Languages** | TypeScript (full-stack) |
| **License** | Proprietary (Apache 2.0 client SDK) |
| **Maturity** | Production-ready; venture-funded company |

**Architecture Approach:** Convex is a full-stack backend platform. You define your data schema, query functions, and mutation functions in TypeScript. Convex runs them on its cloud infrastructure and automatically keeps clients in sync via reactive queries.

**Key Innovation:** Reactive functions — In Convex, you define query functions that run on the server. When the underlying data changes, Convex automatically re-runs the query and pushes the updated result to all subscribed clients. This is the gold standard for developer experience in reactive data.

**Weakness for Comparison:** Convex is not truly offline-first. It's a real-time backend with optimistic updates. It does not support offline writes or a local database. However, it's included because its reactive query system is the benchmark that offline-first libraries should aspire to.

**Lessons for Insieme:**
- **Reactive query functions** — Convex's model (define a function, get reactive results) is the simplest possible API for consumers. Insieme's materialized view + reducer + runtime + checkpoint system is powerful but complex. A higher-level abstraction layer could dramatically improve DX.
- **Optimistic UI built-in** — Convex handles optimistic updates automatically based on mutation definitions. Insieme's offline transport handles buffering but doesn't provide optimistic UI primitives.
- **Server-defined queries** — Convex runs queries on the server, reducing client complexity. Insieme could offer server-side materialized views as a complement to client-side ones.

---

### 2.9 Sanity

| Attribute | Detail |
|-----------|--------|
| **Architecture** | Headless CMS with real-time content lake; structured content storage |
| **Sync Protocol** | GROQ queries over HTTP; real-time via EventSource (SSE) + WebSocket |
| **Conflict Resolution** | LWW by default; custom validation middleware |
| **Offline Support** | Limited; optimistic locks via `_rev`; no offline write queue |
| **Storage Backends** | Sanity Content Lake (proprietary); client-side caching via Sanity client |
| **Query Capabilities** | GROQ (Graph-Relational Object Queries); extremely expressive query language |
| **Scaling Model** | Cloud-managed; multi-tenant; CDN-backed |
| **Languages** | JavaScript/TypeScript (client); any (API) |
| **License** | MIT (client SDKs); proprietary (server) |
| **Maturity** | Production-ready; venture-funded company |

**Architecture Approach:** Sanity is a headless CMS, not a sync library. It's included because its Content Lake architecture provides a different perspective on real-time data synchronization. Content is stored as structured documents in a distributed content lake. Clients query via GROQ (an extremely expressive query language) and receive real-time updates.

**Key Innovation:** GROQ — Sanity's query language (Graph-Relational Object Queries) is uniquely powerful. It can join across document types, project fields, filter, sort, and aggregate — all in a single query expression. While a full GROQ implementation would be overkill for Insieme, the principle of an expressive query layer is relevant.

**Real-time via SSE + HTTP:** Sanity uses HTTP for queries and Server-Sent Events (SSE) for real-time updates. This hybrid approach works through firewalls and proxies while still providing low-latency updates.

**Lessons for Insieme:**
- **Query language as API** — Sanity proves that a good query language can be the primary API surface. Insieme's current API is transport-level (send messages, handle events). A query-level API would be more consumer-friendly.
- **SSE for real-time** — Sanity uses SSE rather than WebSocket for real-time updates. SSE is simpler, works through proxies, and has built-in reconnection. For Insieme's broadcast model, SSE could be a lighter alternative to WebSocket.
- **Content lake vs. event log** — Sanity stores current state (content lake) rather than event history. This is the opposite of Insieme's event-sourced approach. A hybrid (event log for audit + snapshots for queries) would give the best of both worlds.

---

## 3. Comparison Matrix

### 3.1 Architecture & Protocol

| Feature | Insieme | PowerSync | ElectricSQL | RxDB | WatermelonDB | PouchDB/CouchDB | Yjs/Automerge | Triplit | Convex | Sanity |
|---------|---------|-----------|-------------|------|--------------|-----------------|---------------|---------|--------|--------|
| **Architecture** | Auth server + event log | Postgres → SQLite mirror | Postgres logical replication → SQLite | Reactive document DB | Lazy SQLite DB | Document sync (MVCC) | CRDT state sync | Distributed SQLite | Real-time BaaS | Content Lake CMS |
| **Auth model** | Authoritative server | Authoritative Postgres | Authoritative Postgres | Pluggable | Consumer-defined | Authoritative CouchDB | None (relay only) | Server-assisted | Authoritative cloud | Authoritative cloud |
| **Sync protocol** | Custom WS cursor-based | Custom streaming | HTTP/SSE shapes | Pluggable | Consumer-defined | HTTP replication | Binary CRDT sync | Custom binary WS | Custom WS reactive | HTTP + SSE |
| **Transport** | WebSocket only | Persistent connection | HTTP/SSE | Pluggable | HTTP | HTTP | WebSocket/WebRTC | WebSocket | WebSocket | HTTP + SSE |
| **Wire format** | JSON | Custom | Custom | JSON/binary | JSON | JSON | Binary | Binary | JSON | JSON |
| **Open source** | MIT | BSL 1.1 + Apache 2.0 | Apache 2.0 | Apache 2.0 | MIT | Apache 2.0 | MIT | Polyform Strict | Apache 2.0 (client) | MIT (client) |

### 3.2 Data & Sync Features

| Feature | Insieme | PowerSync | ElectricSQL | RxDB | WatermelonDB | PouchDB/CouchDB | Yjs/Automerge | Triplit | Convex | Sanity |
|---------|---------|-----------|-------------|------|--------------|-----------------|---------------|---------|--------|--------|
| **Conflict resolution** | FWW (server commit order) | LWW + custom merge | LWW + planned CRDT | LWW + custom handlers | LWW + app-level | Rev tree + app resolution | CRDT (automatic) | LWW + pluggable | OCC + transactions | LWW + validation |
| **Offline writes** | ✅ (draft queue) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (optimistic only) | ❌ |
| **Offline queue visibility** | ❌ (no API) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Snapshot/bootstrap** | ❌ (full replay) | ✅ (initial sync) | ✅ (shape load) | ✅ (checkpoint) | ✅ (initial pull) | ✅ (_changes since rev) | ✅ (state vector) | ✅ (initial sync) | ✅ (initial query) | ✅ (initial query) |
| **Selective sync** | Partition scope | Bucket rules | Shape queries | Per-collection | Per-table | Per-database | Per-document | Per-collection | Per-query | Per-query |
| **Encryption** | ❌ | ❌ | ❌ | ✅ (plugin) | ❌ | ❌ | ✅ (Yjs) | ✅ | ❌ | ❌ |

### 3.3 Storage & Query

| Feature | Insieme | PowerSync | ElectricSQL | RxDB | WatermelonDB | PouchDB/CouchDB | Yjs/Automerge | Triplit | Convex | Sanity |
|---------|---------|-----------|-------------|------|--------------|-----------------|---------------|---------|--------|--------|
| **Client storage** | SQLite, LibSQL, IndexedDB, memory | SQLite | SQLite | IndexedDB, SQLite, OPFS, memory | SQLite | IndexedDB, WebSQL, LevelDB | IndexedDB, SQLite, LevelDB | SQLite | Cloud only | Cloud only |
| **Server storage** | SQLite, LibSQL, memory | PostgreSQL | PostgreSQL | Pluggable | Consumer-defined | CouchDB | None (relay) | SQLite | Proprietary | Proprietary |
| **Query engine** | ❌ (materialized views only) | ✅ (full SQL) | ✅ (full SQL) | ✅ (MongoDB-style) | ✅ (custom builder) | ✅ (MapReduce/Mango) | ✅ (CRDT types) | ✅ (built-in) | ✅ (reactive functions) | ✅ (GROQ) |
| **Reactive queries** | ❌ | ✅ (watch) | ❌ | ✅ (Observables) | ✅ (withObservations) | ✅ (changes feed) | ✅ (observe) | ✅ | ✅ (auto re-run) | ✅ (listen) |
| **Schema support** | ❌ (opaque payloads) | ✅ (SQL schema) | ✅ (SQL schema) | ✅ (JSON schema) | ✅ (model definitions) | ✅ (design docs) | ❌ (CRDT types) | ✅ (schema required) | ✅ (schema definition) | ✅ (schema definition) |

### 3.4 Developer Experience

| Feature | Insieme | PowerSync | ElectricSQL | RxDB | WatermelonDB | PouchDB/CouchDB | Yjs/Automerge | Triplit | Convex | Sanity |
|---------|---------|-----------|-------------|------|--------------|-----------------|---------------|---------|--------|--------|
| **Setup complexity** | High (many components) | Medium | Medium | Medium | Low | Low | Low | Low | Low | Low |
| **Lines of consumer code** | ~3,000+ (per integration) | ~200-500 | ~200-500 | ~300-600 | ~200-400 | ~200-400 | ~100-300 | ~100-300 | ~100-200 | ~100-200 |
| **Framework coupling** | None | Flutter/Dart focused | None | None (RxJS dependency) | React focused | None | None | None | React/Vue/Svelte | React |
| **TypeScript support** | JSDoc types | ✅ (Dart) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Debugging tools** | Logger callback | Dev tools | Electric CLI | Devtools plugin | Chrome DevTools | Fauxton UI | Devtools | Triplit CLI | Dashboard | Vision (studio) |

---

## 4. Lessons for Insieme

### 4.1 From PowerSync: Reactive Queries Are Table Stakes

**What PowerSync does:** `db.watch('SELECT * FROM tasks WHERE project = ?', [projectId])` returns a live result stream.

**What Insieme should do:** Build a reactive query layer on top of materialized views. Instead of consumers manually managing subscriptions and hydration, provide:

```javascript
// Proposed Insieme API
const results = insieme.watch('tasks', {
  where: { projectId: 'p1' },
  orderBy: 'createdAt',
});

results.onUpdate((tasks) => {
  renderTaskList(tasks);
});
```

**Priority:** High — this is the single biggest DX improvement Insieme can make. The consumer pain points analysis shows that the RouteVN integration built ~2,000 lines of projection/replay code that should be the library's responsibility.

### 4.2 From ElectricSQL: HTTP Fallback and Shape-Based Sync

**What ElectricSQL does:** Uses HTTP for initial shape loads and SSE for real-time updates. Shapes are defined by arbitrary queries.

**What Insieme should do:**
1. Implement the HTTP sync fallback already proposed in the protocol deep-dive
2. Evolve partitions into "shapes" — query-defined sync scopes rather than static strings

**Priority:** Medium — HTTP fallback is a reliability win; shape-based sync is a DX win.

### 4.3 From RxDB: Pluggable Storage with Shared Logic

**What RxDB does:** Abstracts all storage behind a common interface. Each storage adapter is ~200 lines of adapter code, not a full reimplementation.

**What Insieme should do:** Extract the shared ~2,600 lines of duplicated store logic into an abstract base class or shared module, as proposed in the architecture redesign. Each store adapter should be ~100-150 lines of storage-specific code.

**Priority:** High — eliminates the biggest maintenance burden and bug surface.

### 4.4 From WatermelonDB: Lazy Loading and Simpler Sync Contract

**What WatermelonDB does:** Never loads full datasets; provides a simple `synchronize({ push, pull })` API.

**What Insieme should do:**
1. Implement lazy/progressive materialized view hydration — don't require full event replay before serving queries
2. Consider a higher-level sync API: `insieme.sync({ onPush, onPull })` for simpler integrations

**Priority:** Medium — lazy loading addresses the cold-start problem; simpler sync API reduces integration friction.

### 4.5 From PouchDB/CouchDB: Explicit Conflict Visibility

**What PouchDB does:** Makes conflicts visible via the revision tree. Losing revisions are accessible for merge.

**What Insieme should do:**
1. Add conflict detection metadata to broadcast events (as proposed in protocol deep-dive)
2. Expose conflict information to consumers via the materialized view runtime
3. Allow consumers to register conflict handlers per event type

**Priority:** Medium — LWW is acceptable for many use cases, but invisible data loss is a trust issue.

### 4.6 From Yjs/Automerge: CRDT as an Application-Layer Option

**What Yjs does:** Provides CRDT types (Y.Text, Y.Map, Y.Array) that consumers use directly. The transport is just a message relay.

**What Insieme should do:**
1. Add optional CRDT metadata fields to event payloads (already proposed)
2. Provide CRDT-aware reducer primitives (counter, OR-set, LWW-register per field)
3. Do NOT build CRDTs into the protocol layer — keep the server as a dumb sequencer

**Priority:** Low — CRDTs are only needed for collaborative text editing and concurrent field mutation, which are not Insieme's primary use case. But having the extension point ready is valuable.

### 4.7 From Triplit: Integrated Query Engine and Schema

**What Triplit does:** Requires schema definition, provides a full query engine, handles sync automatically.

**What Insieme should do:**
1. Add optional schema definition for event types (field types, validation rules)
2. Build a lightweight query engine on top of materialized views
3. Provide automatic validation based on schema definitions

**Priority:** Medium — schema support reduces consumer boilerplate; query engine improves DX.

### 4.8 From Convex: Reactive Functions as the Gold Standard

**What Convex does:** Define a query function → get reactive results. No manual subscriptions, no view management.

**What Insieme should do:** This is aspirational rather than immediately actionable. The lesson is that Insieme should trend toward a world where consumers define what they want (queries) rather than how to compute it (reducers + views + checkpoints).

**Priority:** Long-term — the current architecture is too far from this model for an incremental step.

### 4.9 From Sanity: SSE for Broadcast and Query Language

**What Sanity does:** Uses SSE for real-time updates; provides an expressive query language (GROQ).

**What Insieme should do:**
1. Consider SSE as an alternative to WebSocket for the broadcast channel
2. Investigate a lightweight query DSL for materialized view queries

**Priority:** Low — SSE is a transport detail; a query DSL is a nice-to-have.

---

## 5. Strategic Recommendations

### 5.1 Priority Roadmap (Lessons Ranked by Impact)

| Priority | Lesson | Source | Effort | Impact |
|----------|--------|--------|--------|--------|
| **P0** | Reactive query layer on materialized views | PowerSync, RxDB | High | Critical DX improvement |
| **P0** | Eliminate store duplication via abstract base | RxDB | Medium | Removes 2,600 lines of duplication |
| **P0** | Formal state machines for client/server | Internal proposal | Medium | Eliminates 128-state implicit space |
| **P1** | Conflict detection and visibility | PouchDB | Low | Trust and correctness improvement |
| **P1** | HTTP sync fallback | ElectricSQL | Medium | Reliability behind proxies/firewalls |
| **P1** | Snapshot/bootstrap for cold starts | ElectricSQL, PouchDB | Medium | Performance for large event histories |
| **P2** | Schema definition and validation | Triplit, Convex | Medium | Reduces consumer boilerplate |
| **P2** | Lightweight query engine | Triplit | High | DX improvement |
| **P2** | Offline queue visibility API | WatermelonDB | Low | Consumer UX improvement |
| **P3** | CRDT extension points | Yjs/Automerge | Low | Future-proofing |
| **P3** | SSE broadcast alternative | Sanity | Low | Transport resilience |
| **P3** | Shape-based sync scoping | ElectricSQL | High | Selective sync |

### 5.2 Insieme's Unique Position

After analyzing all 9 competitors, Insieme occupies a unique niche:

1. **Self-hostable, no vendor lock-in** — Unlike Convex, Sanity, and PowerSync (which all require specific backends), Insieme can be deployed anywhere with any storage backend.

2. **Minimal dependencies** — Only 2 runtime deps vs. RxDB's RxJS requirement, PowerSync's Flutter/Dart ecosystem, or CouchDB's JVM server.

3. **Event sourcing backbone** — Insieme's event log is its core data model. Most competitors use state-based models (current state only). The event log provides full audit trail and replay capability.

4. **Authoritative server model** — Unlike CRDT approaches (Yjs/Automerge), Insieme's server provides validation, authorization, and ordering guarantees. This is simpler to reason about for most business applications.

5. **Multi-platform storage** — Native support for SQLite, LibSQL, IndexedDB, and in-memory is broader than most competitors' storage options.

### 5.3 What Insieme Should NOT Do

Based on competitor analysis, Insieme should avoid:

1. **Building a full CRDT engine** — Yjs and Automerge have years of research invested. Insieme should provide extension points, not compete.

2. **Becoming a full backend platform** — Convex and Sanity are entire platforms. Insieme is a library. Staying focused on sync is the right call.

3. **Requiring a specific backend** — PowerSync and ElectricSQL require Postgres. Insieme's backend-agnostic approach is a competitive advantage.

4. **Building a visual IDE/studio** — Sanity's Vision studio is a CMS feature. Insieme should focus on developer tools (debugging, logging, state inspection).

5. **Adopting RxJS or similar** — RxDB's RxJS dependency adds complexity. Insieme's callback/subscription model is simpler. A reactive query layer can be built without Observables.

### 5.4 Competitive Positioning Statement

> **Insieme** is a self-hosted, offline-first sync library with event-sourced architecture, multi-platform storage, and an authoritative server model. Unlike CRDT-based libraries (Yjs, Automerge) that require consumers to understand distributed systems, Insieme provides simple server-ordered convergence. Unlike cloud-dependent services (Convex, Sanity) that create vendor lock-in, Insieme runs anywhere with any backend. Unlike Postgres-only solutions (PowerSync, ElectricSQL), Insieme works with SQLite, LibSQL, IndexedDB, or in-memory storage. Insieme's gap is developer experience — it needs reactive queries, schema support, and reduced integration boilerplate to match the DX of its competitors.

---

## 6. Appendix: Feature Detail Matrix

### A.1 Transport & Protocol Details

| Library | Primary Transport | Fallback | Binary Encoding | Compression | Reconnection |
|---------|-------------------|----------|-----------------|-------------|--------------|
| **Insieme** | WebSocket | None | None | None | Exponential backoff + jitter |
| **PowerSync** | Persistent WS/HTTP | HTTP polling | Custom | Optional | Automatic |
| **ElectricSQL** | HTTP/SSE | HTTP polling | Custom | Optional | Automatic (SSE built-in) |
| **RxDB** | Pluggable | Per-plugin | Optional | Optional | Per-plugin |
| **WatermelonDB** | HTTP | — | None | None | Manual |
| **PouchDB** | HTTP | — | None | Optional | Automatic |
| **Yjs** | WebSocket | WebRTC | ✅ (custom) | ✅ (native) | Automatic |
| **Triplit** | WebSocket | None | ✅ (custom) | None | Automatic |
| **Convex** | WebSocket | None | None | None | Automatic |
| **Sanity** | HTTP + SSE | HTTP polling | None | ✅ (gzip) | SSE built-in |

### A.2 Offline Capabilities

| Library | Local DB | Write Queue | Queue Visibility | Optimistic UI | Offline Duration |
|---------|----------|-------------|------------------|---------------|------------------|
| **Insieme** | ✅ (SQLite/IDB) | ✅ (drafts) | ❌ | Manual | Unlimited |
| **PowerSync** | ✅ (SQLite) | ✅ | ✅ | ✅ | Unlimited |
| **ElectricSQL** | ✅ (SQLite) | ✅ | ✅ | ✅ | Unlimited |
| **RxDB** | ✅ (multiple) | ✅ | ✅ | Via plugin | Unlimited |
| **WatermelonDB** | ✅ (SQLite) | ✅ | ✅ | Manual | Unlimited |
| **PouchDB** | ✅ (IDB/Level) | ✅ | ✅ | Manual | Unlimited |
| **Yjs** | ✅ (multiple) | ✅ | ✅ | ✅ | Unlimited |
| **Triplit** | ✅ (SQLite) | ✅ | ✅ | ✅ | Unlimited |
| **Convex** | ❌ | ❌ | ❌ | ✅ (optimistic) | None |
| **Sanity** | ❌ | ❌ | ❌ | ✅ (optimistic) | None |

### A.3 Community & Ecosystem

| Library | GitHub Stars (approx) | npm Weekly DL | Company-backed | Last Updated |
|---------|----------------------|---------------|----------------|--------------|
| **RxDB** | ~21K | ~150K | No | Active |
| **PouchDB** | ~17K | ~350K | Apache Foundation | Active |
| **Yjs** | ~17K | ~800K | No | Active |
| **Automerge** | ~18K | ~100K | Ink & Switch | Active |
| **WatermelonDB** | ~10K | ~100K | Nozbe | Active |
| **Sanity** | ~5K | ~600K | Sanity.io | Active |
| **Convex** | ~3K | ~50K | Convex Inc. | Active |
| **ElectricSQL** | ~8K | ~30K | Electric SQL Ltd | Active |
| **PowerSync** | ~3K | ~20K | PowerSync | Active |
| **Triplit** | ~2K | ~5K | Triplit | Active |
| **Insieme** | — | — | Yuusoft | Active |

---

## Summary

Insieme's architectural foundation is sound — the event-sourced model, cursor-based sync, multi-platform storage, and minimal dependencies are genuine competitive advantages. However, the library is behind competitors in three critical areas:

1. **Developer experience** — Consumers write 3,000+ lines of integration code vs. 100-300 lines for competitors. This is the biggest barrier to adoption.

2. **Query capabilities** — Every competitor except Insieme provides some form of query engine. Materialized views are powerful but require too much consumer code.

3. **Reactive subscriptions** — PowerSync, RxDB, Convex, and others provide reactive queries out of the box. Insieme requires manual subscription management.

The recommended path forward is to implement the P0 items (reactive query layer, store deduplication, formal state machines) which address the largest pain points without fundamentally changing Insieme's architecture. The P1 items (conflict detection, HTTP fallback, snapshots) would bring Insieme to parity with competitors on reliability and correctness.

---

*Report generated as part of Insieme v2.1.1 architecture review, May 2026.*
