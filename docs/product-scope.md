# Product Scope: Library vs Framework

Decision date: March 1, 2026

## Decision

Insieme is a **library**, not an application framework.

It should provide heavy-lifting for sync protocol/runtime reliability and common integration boilerplate, while keeping application/domain architecture fully user-controlled.

## What We Optimize For

- Minimize repeated app code for:
  - connection/session lifecycle,
  - sync protocol handling,
  - draft/commit durability semantics,
  - common transport/store/server wiring.
- Preserve flexibility at boundaries where products differ:
  - auth/authz policy,
  - domain schema/validation,
  - partition strategy,
  - UI/runtime stack choices.

## Scope Boundaries

### In Scope (Insieme owns this)

- Core sync protocol runtime (`createSyncClient`, `createSyncServer`).
- Reliability semantics (dedupe, ordering, cursor/paging, reconnect behavior).
- Store adapters and persistence helpers.
  - Common client providers are first-class, specifically:
    - SQLite via `@libsql/client`
    - IndexedDB
- Transport adapters and server bridge helpers for common platforms.
- Reusable envelope/profile utilities that remove client/server mapping duplication.

### Out of Scope (App owns this)

- Domain business logic and reducers.
- UI state management and rendering.
- Router/page lifecycle policies.
- Product-specific auth token issuance and ACL business rules.
- Product-specific migration/backfill logic.

## Design Rule: Opinionated Core, Pluggable Edges

- Provide strong defaults for common production use-cases.
- Every default path must have a low-friction override seam.
- New convenience APIs must compile down to existing core protocol primitives (no hidden alternate protocol).
- Users should be able to adopt only one layer (transport/store/profile helper) without adopting all others.

## API Layering Model

### Layer 1: Core (Required, Stable)

- Protocol/client/server/store primitives.
- Strictly minimal and deterministic.

### Layer 2: Batteries Included (Optional)

- Browser WebSocket transport helpers.
- Node `ws` server bridge helpers.
- Client persistence helpers/providers:
  - SQLite via `@libsql/client`
  - IndexedDB
- Envelope/profile helpers (for command/event mapping + validation).

### Layer 3: App Composition (User Land)

- Product-specific services, repositories, command APIs, and UI integrations.

## Acceptance Criteria for New Insieme Features

A new feature should be added only if all are true:

1. Removes boilerplate repeated across multiple app/server implementations.
2. Improves reliability or correctness, not just convenience.
3. Keeps override seams explicit (no hard lock-in).
4. Does not require app framework adoption.
5. Can be tested as protocol/runtime behavior, not product behavior.

## Non-Goals

- Becoming a full-stack app framework.
- Owning product schemas or workflow/state orchestration.
- Hiding protocol semantics behind opaque magic.
