# Motivation & Design Goals

## Why Insieme Exists

**Insieme** (Italian for *"together"*) is an offline-first collaborative library that is simple to use, easy to reason about, and robust enough for production.

We built it because existing solutions either require always-online connectivity or use CRDTs, which come with trade-offs that don't fit a large class of applications — specifically, any application that needs a server to validate and authorize changes.

## Who This Is For

Insieme is for any application that needs collaborative state with authoritative validation. If your app has multiple users (or multiple devices) modifying shared data, and a server that enforces business rules, Insieme fits.

Examples:
- Project management tools (tasks, boards, workflows).
- Shared dashboards and configuration editors.
- Collaborative planning tools (timelines, resource allocation).
- Content management systems with approval workflows.
- Any multi-user app where the server must validate before accepting a change.

The common thread: these applications need offline support and optimistic UI, but they also need a central authority that can reject invalid operations.

Important scope note: Insieme's client runtime can be used fully offline with no server for single-client/local-only apps. A server is only needed when multiple clients must collaborate and converge on authoritative commits.

## Why Not CRDTs

CRDTs solve conflict resolution without a central server. For purely peer-to-peer systems with no server — local-first note-taking, real-time cursors, shared whiteboards — CRDTs can be the right choice.

But for applications that need authoritative validation, CRDTs come at a cost:

- **No validation.** Without a central authority, there is no place to reject invalid state transitions. Every peer must accept every operation. For applications that need business rules, access control, or schema enforcement, this is a fundamental limitation.
- **Complexity.** CRDT merge semantics are difficult to implement correctly, difficult to debug, and difficult to reason about. The complexity leaks into application code.
- **Merge surprises.** Automatic conflict resolution can produce states that no user intended. Debugging why the state looks wrong requires understanding the CRDT internals.

If your application needs to validate and reject invalid operations, you need a central authority. At that point the core benefit of CRDTs (no central coordinator) becomes irrelevant, and you're left paying the complexity cost for nothing.

## Our Approach: Authoritative Server + LWW

Insieme uses a central server as the single source of truth:

- Clients create events locally (offline-first, optimistic UI).
- Events are sent to the server asynchronously.
- The server **validates** every event and decides to commit or reject.
- The server assigns a global monotonic commit order.
- Clients deterministically replay committed events and rebase local drafts on top.

The core library is the deterministic replay engine — it provides event validation, replay, snapshots, and state derivation. The sync protocol, draft management, and rebase logic are built as a layer on top. Insieme provides local payload and schema validation; authoritative business-rule validation is implemented by your server.

For conflict resolution, we use **Last-Write-Wins (LWW)**. It's simple, predictable, and easy to explain to users. The server's commit order is the canonical timeline — no vector clocks, no causal graphs, no merge functions.

## Interface Design

To maximize long-term robustness, Insieme standardizes on:

- **One low-level implementation**: model/event-sourcing core (append-only events, schema validation, deterministic reducer, replay, snapshots).
- **Two first-class app-facing interfaces** on top of that core:
  - **Tree profile** (`set`, `unset`, `tree*`) for free-form dynamic documents.
  - **Event profile** (`type: event` envelope) for explicit schema-driven command domains.

This keeps correctness guarantees on a single execution core while allowing two intentional interface styles.

### Event Profile

Use model-style command events:
- Define domain command schemas (e.g., `scene.create`, `scene.move`).
- Validate every command payload against schema.
- Apply with deterministic reducers.

Model snapshots are version-aware: snapshot reuse is gated by `model.version`, so stale snapshots are automatically discarded when the model schema evolves.

### Tree Profile

Tree actions (`set`, `unset`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`) are first-class for dynamic data models and document-like structures.

For production robustness, tree profile deployments should enforce target/action whitelists, payload schemas, and post-state invariants as defined in the protocol docs.

## Storage Agnostic

Insieme does not own your storage layer. The core library works against a simple store interface (`getEvents`, `appendEvent`, `getSnapshot`, `setSnapshot`), and any backend can implement it:

- **SQLite** — mobile apps, Electron, server-side.
- **IndexedDB** — web browsers.
- **In-memory** — tests, prototyping.
- **PostgreSQL** — server storage.

Planned: official adapters for the most common backends as separate packages.

## What Insieme Is Not

Setting clear boundaries prevents misuse:

- **Not a real-time text editor.** Insieme operates at the event/action level, not the character level. For collaborative rich text editing with per-keystroke sync, use a dedicated OT or CRDT text library.
- **Not a database.** Insieme is a state synchronization layer. It manages an event log and computes state from it. Your storage backend is yours to choose and operate.
- **Not a full backend framework.** Insieme defines the sync protocol and provides the client-side event sourcing engine. The server implementation, authentication, and deployment are your responsibility (we provide the spec, not the server).
- **Not serverless peer-to-peer collaboration.** Insieme's collaboration protocol relies on a central server for authoritative validation/ordering. Single-client offline usage is supported without a server.

## Priorities

### 1. Robustness and Reliability

A collaborative library touches every part of an application's data layer. If it has bugs, users lose work. If it has edge cases, they surface under the worst conditions — poor connectivity, concurrent edits, crash recovery.

This is our top priority:

- **Extensive test coverage.** Declarative spec-based tests for every action type and validation rule. End-to-end sync scenarios covering normal flows, edge cases, and failure modes.
- **Protocol specification.** Every message type, every field, every ordering guarantee is documented and tested against scenarios before implementation.
- **Idempotent sync semantics.** At the protocol level, retries, duplicate deliveries, and out-of-order arrivals must converge to the correct state. The core repository is deterministic given an authoritative event order; dedup and ordering are enforced by the sync/server layer.
- **Fail-safe defaults.** When in doubt, re-sync from source of truth rather than guessing.

A fast library that loses data is worthless. A correct library that's slow can be optimized.

### 2. Performance

Once correctness is established, performance matters. Users expect responsive collaborative apps, even with large datasets and spotty connections.

Performance goals:
- **Snapshots for fast initialization.** Avoid replaying thousands of events on startup. Load the latest snapshot and replay only what's new.
- **Incremental state computation.** When a new event arrives, update state incrementally rather than replaying the full log.
- **Efficient partition queries.** Partition-scoped operations should only touch data relevant to that partition, not scan everything.
- **Minimal wire overhead.** The sync protocol is designed for small message payloads, batched submissions, and paged catch-up to reduce bandwidth.
- **Compact and compressed data when possible.** Storage and payload formats should avoid redundant/unnecessary bytes, and use compression where it provides clear wins without hurting correctness.
- **Lazy loading.** Clients should only load and compute state for partitions they actively need. In-memory cached mode optimizes fast local reads; partition-scoped reads use async store queries for memory efficiency.

These optimizations are layered on top of a correct foundation. We will not sacrifice correctness for speed, but we will invest in making the correct path fast.
