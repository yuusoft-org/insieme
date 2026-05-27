import { createInMemoryClientStore, createSyncClient } from "../../src/index.js";
import { createLoopbackTransport } from "./create-loopback-transport.js";
let uuidCounter = 0;
export const createTestClient = ({ server, clientId, projectId = "proj-1", now, validateLocalEvent, reconnect, faults }) => {
  const store = createInMemoryClientStore();
  let _nowValue = 1000;
  const _now = now || (() => { _nowValue += 1; return _nowValue; });
  const uuid = () => `evt-${clientId}-${++uuidCounter}`;
  const transport = createLoopbackTransport({ server, connectionId: `conn-${clientId}`, faults });
  const client = createSyncClient({
    transport, store, token: clientId, clientId, projectId,
    now: _now, uuid, validateLocalEvent: validateLocalEvent || (() => {}),
    reconnect: reconnect || {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return { client, store, transport, clientId, projectId };
};
