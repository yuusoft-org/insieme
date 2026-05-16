import { createInMemorySyncStore, createSyncServer } from "../../src/index.js";

export const createTestServer = ({
  validate = async () => {},
  authorize = async () => true,
  verifyToken = async (token) => ({ clientId: token, claims: {} }),
  validateSession,
  nowStart = 1000,
  logger = () => {},
  limits,
} = {}) => {
  let _nowValue = nowStart;
  const now = () => { _nowValue += 1; return _nowValue; };
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: { verifyToken, validateSession },
    authz: { authorizeProject: authorize },
    validation: { validate },
    store, clock: { now }, logger, limits,
  });
  return { server, store, now };
};
