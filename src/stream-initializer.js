const toNonNegativeIntegerOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return 0;
  return Math.floor(parsed);
};

/**
 * Submit initialization events only if remote stream is empty.
 *
 * @param {{
 *   syncClient: {
 *     syncNow: (options?: object) => Promise<void>,
 *     getStatus?: () => { connectedServerLastCommittedId?: number | null },
 *     submitEvent: (input: { partitions: string[], event: object }) => Promise<string>,
 *     flushDrafts?: () => Promise<void>,
 *   },
 *   seedEvents?: { partitions: string[], event: object }[],
 *   syncOptions?: object,
 *   logger?: (entry: object) => void,
 * }} input
 */
export const initializeStreamIfEmpty = async ({
  syncClient,
  seedEvents = [],
  syncOptions = {},
  logger = () => {},
}) => {
  if (!syncClient || typeof syncClient.syncNow !== "function") {
    throw new Error("initializeStreamIfEmpty: syncClient.syncNow is required");
  }
  if (typeof syncClient.submitEvent !== "function") {
    throw new Error(
      "initializeStreamIfEmpty: syncClient.submitEvent is required",
    );
  }

  await syncClient.syncNow(syncOptions);

  const status =
    typeof syncClient.getStatus === "function" ? syncClient.getStatus() : {};
  const serverLastCommittedId = toNonNegativeIntegerOrNull(
    status?.connectedServerLastCommittedId,
  );

  if (serverLastCommittedId === null) {
    return {
      initialized: false,
      reason: "server_cursor_unknown",
      submittedCount: 0,
      serverLastCommittedId: null,
    };
  }

  if (serverLastCommittedId > 0) {
    return {
      initialized: false,
      reason: "remote_not_empty",
      submittedCount: 0,
      serverLastCommittedId,
    };
  }

  if (!Array.isArray(seedEvents) || seedEvents.length === 0) {
    return {
      initialized: false,
      reason: "no_seed_events",
      submittedCount: 0,
      serverLastCommittedId,
    };
  }

  for (const entry of seedEvents) {
    if (!entry || !Array.isArray(entry.partitions) || !entry.event) {
      throw new Error(
        "initializeStreamIfEmpty: each seed event needs partitions and event",
      );
    }
    await syncClient.submitEvent({
      partitions: entry.partitions,
      event: entry.event,
    });
  }

  if (typeof syncClient.flushDrafts === "function") {
    await syncClient.flushDrafts();
  }

  logger({
    component: "stream_initializer",
    event: "seed_events_submitted",
    submitted_count: seedEvents.length,
  });

  return {
    initialized: true,
    reason: "seed_submitted",
    submittedCount: seedEvents.length,
    serverLastCommittedId,
  };
};
