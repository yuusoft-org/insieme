export function createWebSocketTransport({ url, protocols }) {
  let socket = null;
  const messageListeners = new Set();

  const emitMessage = (message) => {
    for (const listener of messageListeners) listener(message);
  };

  const waitForOpen = (ws) =>
    new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (error) => {
        ws.removeEventListener("open", onOpen);
        reject(error);
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

  const connect = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    socket = new WebSocket(url, protocols);
    socket.addEventListener("message", (event) => {
      emitMessage(JSON.parse(event.data));
    });
    await waitForOpen(socket);
  };

  const disconnect = async () => {
    if (!socket) return;
    if (socket.readyState === WebSocket.CLOSED) return;

    await new Promise((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.close();
    });
  };

  const send = async (message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    socket.send(JSON.stringify(message));
  };

  const onMessage = (handler) => {
    messageListeners.add(handler);
    return () => messageListeners.delete(handler);
  };

  return {
    connect,
    disconnect,
    send,
    onMessage,
  };
}
