import { produce } from "immer";

const cloneValue = (value) => structuredClone(value);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeStateRoot = (state) => (isObject(state) ? state : {});

const ensureTargetContainer = (state, target) => {
  const current = state[target];
  const container = isObject(current) ? current : {};
  container.items = isObject(container.items) ? container.items : {};
  container.tree = Array.isArray(container.tree) ? container.tree : [];
  state[target] = container;
  return container;
};

const collectNodeIds = (node, ids = []) => {
  ids.push(node.id);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    collectNodeIds(child, ids);
  }
  return ids;
};

const findNode = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const childFound = findNode(children, id);
    if (childFound) return childFound;
  }
  return null;
};

const removeNodeById = (nodes, id) => {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.id === id) {
      nodes.splice(index, 1);
      return {
        removed: node,
        removedIds: collectNodeIds(node, []),
      };
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const removedFromChildren = removeNodeById(children, id);
    if (removedFromChildren) return removedFromChildren;
  }
  return null;
};

const insertNodeByPosition = (nodes, node, position) => {
  if (position === "last") {
    nodes.push(node);
    return;
  }

  if (isObject(position) && typeof position.after === "string") {
    const index = nodes.findIndex((entry) => entry.id === position.after);
    if (index >= 0) {
      nodes.splice(index + 1, 0, node);
      return;
    }
  }

  if (isObject(position) && typeof position.before === "string") {
    const index = nodes.findIndex((entry) => entry.id === position.before);
    if (index >= 0) {
      nodes.splice(index, 0, node);
      return;
    }
  }

  nodes.unshift(node);
};

const applySet = ({ state, payload }) => {
  if (!isObject(payload) || typeof payload.target !== "string") return;
  state[payload.target] = cloneValue(payload.value);
};

const applyUnset = ({ state, payload }) => {
  if (!isObject(payload) || typeof payload.target !== "string") return;
  delete state[payload.target];
};

const applyTreePush = ({ state, payload }) => {
  if (
    !isObject(payload) ||
    typeof payload.target !== "string" ||
    !isObject(payload.value) ||
    typeof payload.value.id !== "string"
  ) {
    return;
  }

  const targetState = ensureTargetContainer(state, payload.target);
  const options = isObject(payload.options) ? payload.options : {};
  const parentId =
    typeof options.parent === "string" ? options.parent : "_root";
  const position = options.position ?? "first";
  const node = { id: payload.value.id, children: [] };

  targetState.items[payload.value.id] = cloneValue(payload.value);

  // Keep id uniqueness if same id gets pushed again.
  removeNodeById(targetState.tree, payload.value.id);

  if (parentId === "_root") {
    insertNodeByPosition(targetState.tree, node, position);
    return;
  }

  const parentNode = findNode(targetState.tree, parentId);
  if (!parentNode) {
    // Missing parent keeps item as orphan.
    return;
  }

  if (!Array.isArray(parentNode.children)) {
    parentNode.children = [];
  }
  insertNodeByPosition(parentNode.children, node, position);
};

const applyTreeDelete = ({ state, payload }) => {
  if (
    !isObject(payload) ||
    typeof payload.target !== "string" ||
    !isObject(payload.options) ||
    typeof payload.options.id !== "string"
  ) {
    return;
  }

  const targetState = ensureTargetContainer(state, payload.target);
  const removed = removeNodeById(targetState.tree, payload.options.id);
  if (!removed) return;

  for (const id of removed.removedIds) {
    delete targetState.items[id];
  }
};

const applyTreeUpdate = ({ state, payload }) => {
  if (
    !isObject(payload) ||
    typeof payload.target !== "string" ||
    !isObject(payload.options) ||
    typeof payload.options.id !== "string" ||
    !isObject(payload.value)
  ) {
    return;
  }

  const targetState = ensureTargetContainer(state, payload.target);
  const itemId = payload.options.id;
  const replace = payload.options.replace === true;
  const existing = targetState.items[itemId];
  targetState.items[itemId] = replace
    ? cloneValue(payload.value)
    : { ...(isObject(existing) ? existing : {}), ...cloneValue(payload.value) };
};

const applyTreeMove = ({ state, payload }) => {
  if (
    !isObject(payload) ||
    typeof payload.target !== "string" ||
    !isObject(payload.options) ||
    typeof payload.options.id !== "string"
  ) {
    return;
  }

  const targetState = ensureTargetContainer(state, payload.target);
  const itemId = payload.options.id;

  if (!Object.prototype.hasOwnProperty.call(targetState.items, itemId)) {
    // Nonexistent item is a strict no-op.
    return;
  }

  const removed = removeNodeById(targetState.tree, itemId);
  if (!removed) {
    // Missing tree node is treated as no-op.
    return;
  }

  const parentId =
    typeof payload.options.parent === "string"
      ? payload.options.parent
      : "_root";
  const position = payload.options.position ?? "first";

  if (parentId === "_root") {
    insertNodeByPosition(targetState.tree, removed.removed, position);
    return;
  }

  const parentNode = findNode(targetState.tree, parentId);
  if (!parentNode) {
    // Node disappears from tree, but item entry remains as orphan.
    return;
  }

  if (!Array.isArray(parentNode.children)) {
    parentNode.children = [];
  }
  insertNodeByPosition(parentNode.children, removed.removed, position);
};

const DEFAULT_HANDLERS = {
  set: applySet,
  unset: applyUnset,
  treePush: applyTreePush,
  treeDelete: applyTreeDelete,
  treeUpdate: applyTreeUpdate,
  treeMove: applyTreeMove,
};

const runWithImmer = ({ state, handler, context }) =>
  produce(normalizeStateRoot(state), (draft) => {
    const next = handler({ ...context, state: draft });
    if (next !== undefined) return next;
    return undefined;
  });

/**
 * Reducer factory for committed events.
 *
 * Handlers are keyed by committed event `event.type`.
 * `schemaHandlers` are keyed by `event.payload.schema` when `event.type === "event"`.
 * Handler args: `{ state, event, payload, partition, schema?, data? }`
 */
export const createReducer = ({
  handlers = {},
  schemaHandlers = {},
  fallback = ({ state }) => state,
} = {}) => {
  const mergedHandlers = {
    ...DEFAULT_HANDLERS,
    ...handlers,
  };

  return ({ state, event, partition }) => {
    const type = event?.event?.type;
    const payload = event?.event?.payload;
    const baseContext = {
      event,
      payload,
      partition,
    };

    if (typeof type !== "string" || type.length === 0) {
      return runWithImmer({
        state,
        handler: fallback,
        context: baseContext,
      });
    }

    if (
      type === "event" &&
      isObject(payload) &&
      typeof payload.schema === "string"
    ) {
      const schemaHandler = schemaHandlers[payload.schema];
      if (typeof schemaHandler === "function") {
        return runWithImmer({
          state,
          handler: schemaHandler,
          context: {
            ...baseContext,
            schema: payload.schema,
            data: payload.data,
          },
        });
      }
    }

    const handler = mergedHandlers[type];
    if (typeof handler === "function") {
      return runWithImmer({
        state,
        handler,
        context: baseContext,
      });
    }

    return runWithImmer({
      state,
      handler: fallback,
      context: baseContext,
    });
  };
};

export const reduceEvent = createReducer();
