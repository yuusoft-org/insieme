import { createTestServer } from "./create-test-server.js";
import { createTestClient } from "./create-test-client.js";
export const createPartitionedWorld = ({ clientCount, projectId = "proj-1", serverOptions = {} }) => {
  const { server, store: serverStore, now } = createTestServer(serverOptions);
  const clients = [];
  for (let i = 0; i < clientCount; i++) {
    clients.push(createTestClient({ server, clientId: `C${i + 1}`, projectId, now }));
  }
  return { server, serverStore, clients, now };
};
