const cloneMessage = (message) => structuredClone(message);

const matchesFault = (fault, context) => {
  if (fault.direction && fault.direction !== context.direction) return false;
  if (typeof fault.match === "function") return fault.match(context);
  if (fault.type) return context.message?.type === fault.type;
  return true;
};

const resolveFault = (faults, context) => {
  for (const fault of faults) {
    const remaining = fault.remaining ?? fault.times ?? (fault.once ? 1 : Infinity);
    if (remaining <= 0 || !matchesFault(fault, context)) continue;
    fault.remaining = remaining === Infinity ? Infinity : remaining - 1;
    return {
      action: fault.action || "drop",
      name: fault.name || `${context.direction}:${context.message?.type || "message"}`,
    };
  }
  return undefined;
};

export const createFaultTransport = ({
  server,
  connectionId,
  trace,
  faults = [],
} = {}) => {
  let onMessageHandler = null;
  let session = null;
  let connected = false;
  const sentMessages = [];
  const receivedMessages = [];
  const droppedMessages = [];
  const delayedMessages = [];

  const deliverServerMessage = async (message) => {
    receivedMessages.push(message);
    if (onMessageHandler) onMessageHandler(message);
  };

  const serverTransport = {
    connectionId,
    send: async (message) => {
      const storedMessage = cloneMessage(message);
      trace?.record("transport.server_to_client", {
        connectionId,
        type: storedMessage.type,
      });
      const fault = resolveFault(faults, {
        direction: "server_to_client",
        message: storedMessage,
        connectionId,
      });
      if (fault?.action === "drop") {
        droppedMessages.push(storedMessage);
        trace?.record("fault.drop", {
          connectionId,
          direction: "server_to_client",
          name: fault.name,
          type: storedMessage.type,
        });
        return;
      }
      if (fault?.action === "delay") {
        delayedMessages.push(storedMessage);
        trace?.record("fault.delay", {
          connectionId,
          direction: "server_to_client",
          name: fault.name,
          type: storedMessage.type,
        });
        return;
      }
      await deliverServerMessage(storedMessage);
    },
    close: async (reason = "server_close") => {
      trace?.record("transport.server_close", { connectionId, reason });
      connected = false;
    },
  };

  return {
    connect: async () => {
      if (connected) return;
      session = server.attachConnection(serverTransport);
      connected = true;
      trace?.record("transport.connect", { connectionId });
    },
    disconnect: async (reason = "client_disconnect") => {
      if (!connected || !session) return;
      trace?.record("transport.disconnect", { connectionId, reason });
      try {
        await session.close(reason);
      } catch {
        // best effort in test transport
      }
      connected = false;
      session = null;
    },
    send: async (message) => {
      if (!connected || !session) {
        const error = new Error("transport disconnected");
        error.code = "transport_disconnected";
        throw error;
      }
      const storedMessage = cloneMessage(message);
      trace?.record("transport.client_to_server", {
        connectionId,
        type: storedMessage.type,
      });
      const fault = resolveFault(faults, {
        direction: "client_to_server",
        message: storedMessage,
        connectionId,
      });
      sentMessages.push(storedMessage);
      if (fault?.action === "drop") {
        droppedMessages.push(storedMessage);
        trace?.record("fault.drop", {
          connectionId,
          direction: "client_to_server",
          name: fault.name,
          type: storedMessage.type,
        });
        return;
      }
      if (fault?.action === "delay") {
        delayedMessages.push({
          direction: "client_to_server",
          message: storedMessage,
        });
        trace?.record("fault.delay", {
          connectionId,
          direction: "client_to_server",
          name: fault.name,
          type: storedMessage.type,
        });
        return;
      }
      await session.receive(storedMessage);
    },
    flushDelayed: async () => {
      while (delayedMessages.length > 0) {
        const item = delayedMessages.shift();
        if (item?.direction === "client_to_server") {
          await session.receive(item.message);
        } else {
          await deliverServerMessage(item);
        }
      }
    },
    onMessage: (handler) => {
      onMessageHandler = handler;
      return () => {
        if (onMessageHandler === handler) onMessageHandler = null;
      };
    },
    getSentMessages: () => [...sentMessages],
    getReceivedMessages: () => [...receivedMessages],
    getDroppedMessages: () => [...droppedMessages],
    getDelayedMessages: () => [...delayedMessages],
    isConnected: () => connected,
  };
};

