import { commandToSyncEvent, committedSyncEventToCommand } from "./command-profile.js";
import { createInMemoryClientStore } from "./in-memory-client-store.js";
import { createOfflineTransport } from "./offline-transport.js";
import { createSyncClient } from "./sync-client.js";

const toNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

const commandPartition = (command) => toNonEmptyString(command?.partition);

const isTransportDisconnectedError = (error) => {
  const code = error?.code;
  if (code === "transport_disconnected") return true;
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("websocket is not connected") ||
    message.includes("transport_disconnected") ||
    message.includes("disconnected")
  );
};

/**
 * Higher-level command-oriented sync session.
 *
 * @param {{
 *   token: string,
 *   actor: { userId: string, clientId: string },
 *   projectId: string,
 *   transport?: object,
 *   store?: object,
 *   logger?: (entry: object) => void,
 *   reconnect?: object,
 *   schemaVersion?: number,
 *   mapCommandToSyncEvent?: (command: object) => object,
 *   mapCommittedToCommand?: (committedEvent: object) => object | null,
 *   onCommittedCommand?: (payload: {
 *     command: object,
 *     committedEvent: object,
 *     sourceType: string,
 *     isFromCurrentActor: boolean,
 *   }) => void | Promise<void>,
 *   onEvent?: (payload: { type: string, payload: any }) => void,
 *   swallowTransportDisconnect?: boolean,
 * }} input
 */
export const createCommandSyncSession = ({
  token,
  actor,
  projectId,
  transport,
  store,
  logger = () => {},
  reconnect = {},
  schemaVersion = 1,
  mapCommandToSyncEvent = (command) =>
    commandToSyncEvent(command, {
      defaultSchemaVersion: schemaVersion,
    }),
  mapCommittedToCommand = (committedEvent) =>
    committedSyncEventToCommand(committedEvent),
  onCommittedCommand = () => {},
  onEvent = () => {},
  swallowTransportDisconnect = true,
}) => {
  if (!actor || !toNonEmptyString(actor.userId) || !toNonEmptyString(actor.clientId)) {
    throw new Error(
      "createCommandSyncSession: actor.userId and actor.clientId are required",
    );
  }
  if (!toNonEmptyString(projectId)) {
    throw new Error("createCommandSyncSession: projectId is required");
  }

  const runtimeStore =
    store ||
    createInMemoryClientStore({
      materializedViews: [],
    });
  const baseTransport = transport || createOfflineTransport();

  const appliedEventIds = new Set();
  let lastError = null;

  const boundedRemember = (id) => {
    if (!id) return;
    appliedEventIds.add(id);
    if (appliedEventIds.size > 5000) {
      const oldest = appliedEventIds.values().next().value;
      appliedEventIds.delete(oldest);
    }
  };

  const emitCommittedCommand = ({
    command,
    committedEvent,
    sourceType,
    isFromCurrentActor,
  }) => {
    try {
      const maybePromise = onCommittedCommand({
        command: structuredClone(command),
        committedEvent: structuredClone(committedEvent),
        sourceType,
        isFromCurrentActor,
      });
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch((error) => {
          lastError = {
            code: "on_committed_command_failed",
            message: error?.message || "unknown",
          };
        });
      }
    } catch (error) {
      lastError = {
        code: "on_committed_command_failed",
        message: error?.message || "unknown",
      };
    }
  };

  const applyCommittedEvents = (events, sourceType = "unknown") => {
    for (const committedEvent of events) {
      const command = mapCommittedToCommand(committedEvent);
      if (!command) continue;
      const dedupeId = command.id || committedEvent?.id;
      if (dedupeId && appliedEventIds.has(dedupeId)) continue;

      const isFromCurrentActor =
        command?.actor?.clientId === actor?.clientId &&
        command?.actor?.userId === actor?.userId;

      boundedRemember(dedupeId);
      boundedRemember(committedEvent?.id);

      emitCommittedCommand({
        command,
        committedEvent,
        sourceType,
        isFromCurrentActor,
      });
    }
  };

  const syncClient = createSyncClient({
    transport: baseTransport,
    store: runtimeStore,
    token,
    clientId: actor.clientId,
    projectId,
    logger,
    reconnect,
    onEvent: (entry) => {
      try {
        if (entry?.type === "broadcast") {
          applyCommittedEvents([entry.payload], "broadcast");
        } else if (entry?.type === "sync_page") {
          applyCommittedEvents(entry.payload?.events || [], "sync_page");
        } else if (entry?.type === "rejected") {
          lastError = {
            code: entry?.payload?.reason || "validation_failed",
            message: "Server rejected command",
            payload: entry.payload,
          };
        } else if (entry?.type === "not_processed") {
          lastError = {
            code: entry?.payload?.reason || "prior_item_failed",
            message: "Server did not process command",
            payload: entry.payload,
          };
        } else if (entry?.type === "error") {
          lastError = entry.payload || {
            code: "unknown_error",
            message: "unknown",
          };
        }
      } finally {
        onEvent(entry);
      }
    },
  });

  const submitCommands = async (commands) => {
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error("submitCommands requires at least one command");
    }

    const submitItems = commands.map((command) => {
      const partition = commandPartition(command);
      if (!partition) {
        throw new Error("Command must include a partition");
      }

      boundedRemember(command?.id);
      const syncEvent = mapCommandToSyncEvent(command);
      const resolvedProjectId =
        toNonEmptyString(syncEvent?.projectId) ||
        toNonEmptyString(command?.projectId) ||
        projectId;
      return {
        id: command.id,
        partition,
        projectId: resolvedProjectId,
        ...syncEvent,
      };
    });

    try {
      const submittedIds = await syncClient.submitEvents(submitItems);
      return submittedIds;
    } catch (error) {
      if (!swallowTransportDisconnect || !isTransportDisconnectedError(error)) {
        throw error;
      }
      lastError = {
        code: "transport_disconnected",
        message: error?.message || "transport disconnected",
      };
      return submitItems.map((item) => item.id);
    }
  };

  return {
    start: async () => {
      await syncClient.start();
    },

    stop: async () => {
      await syncClient.stop();
    },

    submitCommands,

    submitEvents: async (inputs) => {
      return syncClient.submitEvents(
        inputs.map((input) => ({
          ...input,
        })),
      );
    },

    submitEvent: async (input) => {
      return syncClient.submitEvent({
        ...input,
      });
    },

    syncNow: async (options = {}) => {
      await syncClient.syncNow(options);
    },

    flushDrafts: async () => {
      await syncClient.flushDrafts();
    },

    setOnlineTransport: async (nextTransport) => {
      if (typeof baseTransport.setOnlineTransport !== "function") {
        throw new Error(
          "Current transport does not support online transport swap",
        );
      }
      await baseTransport.setOnlineTransport(nextTransport);
    },

    getActor: () => structuredClone(actor),

    getStatus: () => syncClient.getStatus(),

    getLastError: () => (lastError ? structuredClone(lastError) : null),

    clearLastError: () => {
      lastError = null;
    },
  };
};
