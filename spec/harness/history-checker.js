const committedIdOf = (event) => event.committedId ?? event.committed_id;

const invariantError = (message, trace) => {
  const error = new Error(message);
  error.invariant = message;
  if (trace) {
    trace.record("invariant.failed", { message });
  }
  return error;
};

export const readCommittedEvents = async (store) => {
  const committed = store?._debug?.getCommitted?.();
  return typeof committed?.then === "function" ? await committed : committed || [];
};

export const readDrafts = async (store) => {
  const drafts = store?._debug?.getDrafts?.();
  return typeof drafts?.then === "function" ? await drafts : drafts || [];
};

export const assertCommittedIdsStrictlyIncreasing = async ({
  store,
  events,
  trace,
} = {}) => {
  const committed = events || (await readCommittedEvents(store));
  let previous = 0;
  const seen = new Set();
  for (const event of committed) {
    const committedId = committedIdOf(event);
    if (!Number.isInteger(committedId) || committedId <= previous) {
      throw invariantError(
        `committedId must strictly increase: ${committedId} after ${previous}`,
        trace,
      );
    }
    if (seen.has(committedId)) {
      throw invariantError(`committedId reused: ${committedId}`, trace);
    }
    seen.add(committedId);
    previous = committedId;
  }
};

export const assertNoDrafts = async ({ store, label = "client", trace } = {}) => {
  const drafts = await readDrafts(store);
  if (drafts.length > 0) {
    throw invariantError(
      `${label} has unexpected drafts: ${drafts.map((draft) => draft.id).join(", ")}`,
      trace,
    );
  }
};

export const assertCommittedEventIds = async ({
  store,
  ids,
  label = "store",
  trace,
} = {}) => {
  const committed = await readCommittedEvents(store);
  const actualIds = committed.map((event) => event.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(ids)) {
    throw invariantError(
      `${label} committed ids mismatch: expected ${ids.join(", ")} got ${actualIds.join(", ")}`,
      trace,
    );
  }
};

export const assertClientServerConverged = async ({
  serverStore,
  clientStore,
  trace,
} = {}) => {
  const serverCommitted = await readCommittedEvents(serverStore);
  const clientCommitted = await readCommittedEvents(clientStore);
  const serverIds = serverCommitted.map((event) => event.id);
  const clientIds = clientCommitted.map((event) => event.id);
  if (JSON.stringify(serverIds) !== JSON.stringify(clientIds)) {
    throw invariantError(
      `client/server committed ids diverged: server=${serverIds.join(", ")} client=${clientIds.join(", ")}`,
      trace,
    );
  }
  await assertCommittedIdsStrictlyIncreasing({
    events: serverCommitted,
    trace,
  });
  await assertCommittedIdsStrictlyIncreasing({
    events: clientCommitted,
    trace,
  });
};

