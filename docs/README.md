# Docs Entrypoint

Start here. This file is the navigation index for all Insieme docs.

## First Read

1. `overview.md` - protocol and client doc map, glossary, and architecture context.
2. `motivation.md` - design goals, tradeoffs, and interface rationale.
3. `javascript-interface.md` - small JS interface contract for client and backend.
4. `roadmap.md` - implementation plan (backend + frontend + test strategy).

## Protocol Spec

- `protocol/messages.md` - wire envelope and all message schemas.
- `protocol/connection.md` - handshake, auth, lifecycle, profile negotiation.
- `protocol/ordering-and-idempotency.md` - global ordering and dedupe semantics.
- `protocol/partitions.md` - partition rules, subscriptions, multi-partition behavior.
- `protocol/validation.md` - event/tree profile validation and policy gates.
- `protocol/durability.md` - commit flow, sync paging, persistence guarantees.
- `protocol/errors.md` - canonical error codes and recovery behavior.

## Client Runtime

- `client/storage.md` - local tables, snapshots, cursor mapping, retention.
- `client/drafts.md` - draft lifecycle, rebase, idempotent apply strategy.
- `client/tree-actions.md` - tree profile action semantics and edge cases.

## Scenario Index

- `sync-examples.md` - index of all end-to-end sync scenarios.
- `sync-scenarios/*.md` - scenario-by-scenario expected behavior.

## Source of Truth Rules

- Normative behavior lives in `protocol/*.md` and `client/*.md`.
- `roadmap.md` is execution planning only (not normative protocol text).
- Keep terminology consistent:
  - tree profile = `compatibility` wire profile
  - event profile = `canonical` wire profile
