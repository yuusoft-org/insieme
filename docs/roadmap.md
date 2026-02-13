# Insieme Protocol Implementation Roadmap

This roadmap is the implementation plan for the current protocol/interface docs.

Status note: this roadmap still contains extended-protocol tracks (profiles, heartbeat, model-version, etc.). After the protocol simplification, treat those sections as backlog ideas unless they are explicitly re-adopted into `docs/protocol/*.md`.

## Source of Truth Policy

- Normative protocol/interface requirements remain in existing docs under:
  - `docs/protocol/*.md`
  - `docs/client/*.md`
  - `docs/README.md`
  - `docs/sync-scenarios/*.md`
- This roadmap is execution-only (tasks, order, acceptance criteria).
- Do not duplicate or fork protocol rules in code comments/spec files; reference the docs above by section.

## Target End State

- One low-level implementation model: event-sourcing runtime.
- Two first-class app-facing profiles on that core:
  - Tree profile (`compatibility` wire profile) for free-form dynamic data.
  - Event profile (`canonical` wire profile) for schema-driven command domains.
- Full client/server conformance against all protocol docs and all 19 sync scenarios.

## Delivery Principles

- Test-first for protocol behavior.
- Puty YAML is primary for behavior/conformance tests.
- Vitest is reserved for tricky algorithmic units and failure-path internals.
- Follow implementation constraints in `README.md` (`Implementation Guidelines (Required)`).
- No phase is complete without explicit pass/fail acceptance criteria.

## Phase 0 - Baseline and Gap Closure

### Scope

- Freeze current protocol docs as implementation input.
- Produce a single gap checklist from docs to code.

### Tasks

- Build a requirement matrix: one row per MUST/SHOULD from protocol/client docs and one column per implementation/test artifact.
- Mark current runtime (`src/repository.js`, `src/actions.js`, `src/validation.js`) coverage vs missing pieces.
- Identify terminology mismatches to remove during implementation (`partition` vs `partitions`, `eventIndex` vs `committed_id` boundaries).

### Acceptance

- Every normative section has an owner and a planned implementation phase.
- No unresolved ambiguity remains for protocol and interface behavior.

## Phase 1 - Conformance Harness First

### Scope

- Create executable conformance scaffolding before feature work.

### Tasks

- Extend Puty suites to support protocol message-flow fixtures and expected state transitions.
- Add scenario-to-spec mapping:
  - `docs/sync-scenarios/00-18` each maps to at least one Puty YAML executable case.
- Add deterministic fixtures:
  - logical clocks/time injector,
  - deterministic `committed_id` allocator,
  - deterministic UUID fixture mode for tests.
- Add CI gating for:
  - Puty scenario suites,
  - Vitest unit suites,
  - coverage threshold for tricky modules only.

### Puty Coverage Required

- handshake/profile negotiation
- submit/reject/commit flows
- dedupe/idempotency
- sync paging and high-watermark behavior
- broadcast buffering during sync
- batch ordered non-atomic processing
- partitions normalization/authorization
- model_version mismatch handling on reconnect/sync

### Vitest-Only Units (Tricky)

- canonical payload equality/hash implementation
- sync cycle buffering/flush algorithm
- self/descendant treeMove guard
- upsert idempotency path (`id` + `committed_id` collision diagnostics)
- snapshot/version invalidation logic

### Acceptance

- All 19 scenario docs have executable Puty coverage.
- CI blocks merges on conformance failures.

## Phase 2 - Backend Protocol Core

### Scope

- Implement server protocol lifecycle and persistence semantics.

### Tasks

- Connection lifecycle:
  - `connect`, auth checks, profile negotiation, `connected` payload capabilities.
  - heartbeat/timeout/disconnect/reconnect semantics.
- Message envelope validation and error boundary mapping (`bad_request`, `auth_failed`, etc.).
- Submit path:
  - `submit_events` single-item and ordered non-atomic batch processing,
  - request-level invariants precheck.
- Commit flow durability:
  - assign global monotonic `committed_id`,
  - durable persist before committed `submit_events_result` entries / `event_broadcast`.
- Idempotency:
  - dedupe by `id`,
  - reject same `id` with different canonical payload.
- Sync path:
  - partition-scoped fetch,
  - paging with stable `sync_to_committed_id`,
  - subscription replacement semantics,
  - future-cursor handling.
- Versioning:
  - include `model_version`,
  - enforce snapshot invalidation/full re-sync on version mismatch.

### Backend Data Model Requirements

- committed event log (append-only)
- unique index on `committed_id`
- dedupe index keyed by `id`
- partition membership index for query speed
- optional snapshot store with version tagging

### Acceptance

- Backend passes all protocol Puty scenarios as server-under-test.
- Crash-recovery replay and dedupe correctness validated in tests.

## Phase 3 - Frontend Sync Engine

### Scope

- Implement client runtime aligned with protocol and local draft model.

### Tasks

- Local storage:
  - events table (`id`, `committed_id`, `status`, `partitions[]`, `draft_clock`, timestamps),
  - snapshots with optional `model_version`.
- Draft lifecycle:
  - local-first insert,
  - async queue send,
  - commit/reject upgrade paths.
- Queue discipline:
  - preserve draft_clock order,
  - support batch submission while preserving order.
- Sync engine:
  - single in-flight sync request,
  - paging until `has_more=false`,
  - broadcast buffer for `committed_id > sync_to_committed_id`,
  - ordered flush after cycle.
- Idempotent apply:
  - update-by-`id` then insert fallback,
  - collision diagnostics and full re-sync fallback path.
- Rebase:
  - committed stream ordered by `committed_id`,
  - drafts overlay reapplied deterministically.
- Capability handling:
  - process `connected.payload.capabilities`,
  - enforce supported profile/event types locally.
- Version change:
  - invalidate snapshots globally,
  - full catch-up for active partitions.

### Acceptance

- Frontend runtime passes all client-side Puty scenarios with deterministic replay.
- Offline/reconnect/retry flows are idempotent and convergent.

## Phase 4 - Tree Profile Hardening

### Scope

- Keep tree profile safe and deterministic for first-class production use.

### Tasks

- Implement strict policy gate for tree profile:
  - target whitelist,
  - action whitelist by target,
  - payload schema by (target, action),
  - precondition checks,
  - simulated apply,
  - post-state invariants.
- Ensure tree profile behavior is selected only via negotiated profile.
- Ensure guardrails are applied consistently on both submit and batch paths.

### Acceptance

- Tree profile passes edge-case scenarios and cannot violate tree invariants.
- Tree profile and event profile both pass conformance suites.

## Phase 5 - Operational Hardening

### Scope

- Ensure production reliability under failure and load.

### Tasks

- Backpressure and limits:
  - max batch size,
  - sync limit clamping,
  - in-flight draft caps,
  - message size caps.
- Observability:
  - structured logs per `msg_id`, `id`, `committed_id`,
  - metrics for rejects, dedupe hits, sync lag, reconnects, buffer depth.
- Failure drills:
  - crash between persist and response,
  - duplicate delivery storms,
  - network flaps and reconnect loops.
- Performance validation:
  - high event volume replay,
  - partition fan-out stress,
  - snapshot rebuild timings.

### Acceptance

- Defined SLO checks pass in staging load/failure tests.
- Operational runbook is actionable for common fault modes.

## Phase 6 - Release and Migration

### Scope

- Roll out safely to existing apps and new critical workloads.

### Tasks

- Feature flags by capability/profile.
- Profile rollout plan:
  - maintain tree profile support as first-class,
  - maintain event profile support as first-class.
- Data migration checks for `partitions[]` canonicalization.
- Consumer integration pass (including `../routevn-creator-client`) to verify robust interface usage and policy enforcement.
- Release criteria checklist tied to conformance matrix.

### Acceptance

- No protocol regression in tree-profile clients.
- Tree profile and event profile live with full conformance suite passing.

## Reliability Verification Strategy

### Required (Now)

- Puty YAML scenario and conformance suites as primary reliability guard.
- Vitest unit tests only for tricky deterministic algorithms.
- Deterministic test harness (time/UUID/ID allocation control) to eliminate flaky behavior.

### Recommended (High Value, Optional Early)

- Add a small formal model for protocol invariants (TLA+ or Alloy) focused on:
  - monotonic global `committed_id`,
  - dedupe correctness (`id` with same vs different payload),
  - ordered non-atomic batch guarantees,
  - sync high-watermark/buffer correctness,
  - model_version mismatch invalidation behavior.
- Run model checking in CI nightly (not required on every PR initially).

### Is Formal Language Necessary?

- Not required to start implementation.
- Strongly recommended for long-lived critical apps because it catches ordering/idempotency edge cases earlier than example-based tests.
- Practical plan: ship with Puty+Vitest first, then add a narrow formal model once core behavior is stable.

## Execution Checklist

- [ ] Requirement matrix complete and reviewed
- [ ] Puty conformance harness complete
- [ ] All 19 sync scenarios executable in CI
- [ ] Backend protocol core complete
- [ ] Frontend sync engine complete
- [ ] Tree compatibility gate hardened
- [ ] Operational hardening and load/failure tests complete
- [ ] Release/migration checklist complete
- [ ] Optional formal model added and running nightly
