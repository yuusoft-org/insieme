# Insieme Production Readiness Hardening Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Bring Insieme from strong internal/beta readiness to production-critical readiness for multi-project durable sync.

**Architecture:** Fix must-not-ship correctness issues first: tenant-scoped event idempotency, atomic async/libSQL migrations, and package publish/type validity. Then add production-path evidence by running critical end-to-end scenarios over real storage, not only in-memory harnesses.

**Tech Stack:** Plain JavaScript with JSDoc, Vitest, Node SQLite helpers, libSQL shim, existing sync protocol/store APIs. No TypeScript implementation.

---

## Production readiness requirements

A production-ready Insieme release must satisfy these requirements:

1. **Tenant/project isolation:** Event IDs are idempotency keys only inside the submitting project/tenant boundary. Different projects may use the same event ID without collision.
2. **Idempotent retries:** Same project + same event ID + same canonical event payload dedupes; same project + same event ID + different payload rejects.
3. **Migration atomicity:** SQLite and libSQL sync-store migrations are transactional; interrupted migrations leave the previous schema/data intact and retryable.
4. **Published package validity:** Declared package exports and type entries exist in the package that consumers install.
5. **Production-path test evidence:** At least one critical convergence/restart/pagination path runs against real SQLite/libSQL storage, not only in-memory stores.
6. **Verification gate:** `npm run lint && npm run types && npm run test:ci && npm run test:coverage && npm run test:reliability:stress && git diff --check` passes.

---

## Task 1: Project-scope sync-store dedupe

**Objective:** Scope sync-store idempotency by project so cross-project duplicate event IDs do not collide.

**Files:**
- Modify: `src/sqlite-sync-store.js`
- Modify: `src/libsql-sync-store.js`
- Test: `spec/protocol/src/sqlite-sync-store.test.js`
- Test: `spec/protocol/src/libsql-sync-store.test.js`

**Step 1: Write failing tests**

Add tests to both sync-store test files:

- `allows different projects to commit the same event id independently`
- `rejects same-project duplicate id with different payload`
- Keep existing canonical dedupe test proving same-project/same-payload dedupes.

Expected behavior:

```js
const first = await store.commitOrGetExisting(makeSubmit({ id: "shared-id", projectId: "proj-1", partition: "P1", payload: { n: 1 }, now: 1 }));
const second = await store.commitOrGetExisting(makeSubmit({ id: "shared-id", projectId: "proj-2", partition: "P2", payload: { n: 2 }, now: 2 }));
expect(first.deduped).toBe(false);
expect(second.deduped).toBe(false);
expect(second.committedEvent.committedId).toBeGreaterThan(first.committedEvent.committedId);
```

Run:

```bash
npx vitest --run spec/protocol/src/sqlite-sync-store.test.js spec/protocol/src/libsql-sync-store.test.js
```

Expected: FAIL before implementation because `id` is globally unique / lookup is global.

**Step 2: Implement minimal storage change**

Approach:

- Add `project_key TEXT NOT NULL` to `committed_events` schema in both sync stores.
- Set `project_key` from the authenticated/store input `projectId` when present; fallback to the first `project:<id>` scoped partition; final fallback `"__global__"` for legacy/no-project rows.
- Change unique constraint from global `id UNIQUE` to `UNIQUE(project_key, id)`.
- Change `getById` to `getByProjectAndId(projectKey, id)`.
- Change inserts and migration copy paths to populate `project_key`.
- Treat old schema without `project_key` as migratable if otherwise compatible.

**Step 3: Verify targeted tests**

Run:

```bash
npx vitest --run spec/protocol/src/sqlite-sync-store.test.js spec/protocol/src/libsql-sync-store.test.js
```

Expected: PASS.

---

## Task 2: Atomic libSQL sync-store migration

**Objective:** Make libSQL sync-store migrations explicitly transactional and prove rollback on failure.

**Files:**
- Modify: `src/libsql-sync-store.js`
- Test: `spec/protocol/src/libsql-sync-store.test.js`

**Step 1: Write failing failure-injection test**

Add a wrapper around the libSQL client/driver that throws during migration after `ALTER TABLE committed_events RENAME...` or during first migrated insert. Assert:

- `store.init()` rejects.
- The old `committed_events` table still exists after failure, or at minimum no half-migrated `committed_events_legacy_v4` remains.
- A second init with a normal client succeeds and preserves rows.

Run targeted test and verify failure before implementation.

**Step 2: Implement transaction helper**

Add async helper:

```js
const runTransaction = async (db, fn) => {
  await db.execute("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await db.execute("COMMIT");
    return result;
  } catch (error) {
    try { await db.execute("ROLLBACK"); } catch {}
    throw error;
  }
};
```

Use it around:

- new schema initialization + version set
- legacy migration + version set

**Step 3: Verify targeted tests**

Run:

```bash
npx vitest --run spec/protocol/src/libsql-sync-store.test.js
```

Expected: PASS.

---

## Task 3: Package type export readiness

**Objective:** Ensure declared package type entrypoints exist for consumers.

**Files:**
- Create/modify: `types/client.d.ts`
- Create/modify: `types/browser.d.ts`
- Create/modify: `types/node.d.ts`
- Create/modify: `types/server.d.ts`
- Test: `spec/protocol/src/package-exports.test.js` or new package validation test

**Step 1: Write failing test**

Add test that reads `package.json` and verifies every `types` path in root/main/exports exists on disk.

Run:

```bash
npx vitest --run spec/protocol/src/package-exports.test.js
```

Expected: FAIL before declarations exist.

**Step 2: Add minimal declaration files**

Provide conservative public declarations for exported functions. Prefer `unknown`/broad object shapes where exact API is not yet documented rather than lying.

**Step 3: Verify package dry run**

Run:

```bash
npm pack --dry-run
npx vitest --run spec/protocol/src/package-exports.test.js
npm run types
```

Expected: PASS and tarball includes `types/*.d.ts`.

---

## Task 4: Real-storage production e2e coverage

**Objective:** Add at least one end-to-end scenario using production SQLite/libSQL storage paths.

**Files:**
- Create/modify: `spec/e2e/production-storage-convergence.test.js`
- May reuse: `spec/harness/create-loopback-transport.js`, `spec/harness/create-test-server.js`, `spec/harness/create-test-client.js`

**Step 1: Write e2e test**

Create a scenario using:

- SQLite sync server store against a temp file.
- SQLite client stores against temp files where available.
- Existing real sync client/server over loopback transport.

Scenario requirements:

1. Client A submits events.
2. Client B syncs and receives them.
3. Server restarts using the same SQLite file.
4. Client A retries a previously committed event and dedupes.
5. Client B syncs after restart and converges without duplicate committed events.

Run:

```bash
npx vitest --run spec/e2e/production-storage-convergence.test.js
```

Expected: PASS after implementation; failures should expose real production-path bugs.

---

## Task 5: Final verification and production gate

**Objective:** Prove all hardening changes pass the production readiness gate.

**Files:**
- No required source changes unless failures are found.

Run:

```bash
npm run lint && npm run types && npm run test:ci && npm run test:coverage && npm run test:reliability:stress && git diff --check
```

Expected: PASS.

Then review:

```bash
git diff --stat
git diff -- src/sqlite-sync-store.js src/libsql-sync-store.js package.json types spec
```

---

## Deferred but still production-important

These are not blockers for the first hardening pass but should remain in the roadmap:

1. Real WebSocket chaos/backpressure tests.
2. Optional partition-level read authorization hook if partitions map to document/room ACLs.
3. Project-indexed storage schema for scalability instead of JS filtering over global committed rows.
4. Longer randomized soak tests in nightly CI.
5. Published package smoke test in a throwaway consumer project.
