export const createLoopbackTransport = ({ server, connectionId, faults = {} }) => {
  let onMessageHandler = null;
  let session = null;
  let connected = false;
  const sentMessages = [];
  const receivedMessages = [];
  const rng = faults.rng || Math.random;
  const dropRate = faults.dropRate || 0;

  const serverTransport = {
    connectionId,
    send: async (message) => {
      receivedMessages.push(message);
      if (onMessageHandler) onMessageHandler(message);
    },
    close: async () => {},
  };

  return {
    connect: async () => {
      if (connected) return;
      session = server.attachConnection(serverTransport);
      connected = true;
    },
    disconnect: async () => {
      if (!connected || !session) return;
      try { await session.close("client_disconnect"); } catch {}
      connected = false;
      session = null;
    },
    send: async (message) => {
      if (!connected || !session) throw new Error("transport disconnected");
      if (dropRate > 0 && rng() < dropRate) {
        sentMessages.push({ ...message, _dropped: true });
        return;
      }
      sentMessages.push(message);
      await session.receive(message);
    },
    onMessage: (handler) => {
      onMessageHandler = handler;
      return () => { if (onMessageHandler === handler) onMessageHandler = null; };
    },
    isConnected: () => connected,
    getSession: () => session,
    getSentMessages: () => [...sentMessages],
    getReceivedMessages: () => [...receivedMessages],
    clearLogs: () => { sentMessages.length = 0; receivedMessages.length = 0; },
  };
};
