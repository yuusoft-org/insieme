# Work Breakdown and Owners

Plan date: February 13, 2026

## Streams

1. Protocol Core (Server)
- Deliverables:
  - connection lifecycle + auth/authz gate
  - submit pipeline with dedupe and durability ordering
  - sync paging + broadcast rules
  - canonical error mapping
- Owner: backend/runtime

2. Client Sync Engine
- Deliverables:
  - connect -> sync startup
  - paged sync loop
  - draft queue drain order
  - idempotent apply over submit/sync/broadcast
- Owner: client/runtime

3. Store Adapters
- Deliverables:
  - simplified transactional store interface
  - sqlite adapter conformance
  - cursor durability behavior
- Owner: persistence/runtime

4. Conformance Tests
- Deliverables:
  - scenario suite coverage (00-18)
  - deterministic fixtures
  - focused unit tests for canonicalization + bounds
- Owner: qa/conformance

## Dependency Order

1. Harness + deterministic fixtures
2. Scenario tests (initial failing set)
3. Focused unit tests for tricky invariants
4. Server/client/store implementation
5. Verification + hardening

## Merge Gates

- No implementation merge without corresponding tests.
- All scenario tests must pass.
- No open `must-fix-before-implementation` issues.

## Rollback Strategy

- Keep compatibility shims for legacy `partition` input during transition.
- Ship protocol/runtime changes behind feature flags where practical.
- If regression occurs, rollback to previous stable protocol handlers and replay from committed log.
