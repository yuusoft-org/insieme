export const createClosedResourceError = (
  label = "resource",
  code = "resource_closed",
) => {
  const error = new Error(`${label} is closed`);
  error.code = code;
  return error;
};

export const throwIfClosed = (
  closed,
  label = "resource",
  code = "resource_closed",
) => {
  if (closed) {
    throw createClosedResourceError(label, code);
  }
};

export const isPromiseLike = (value) =>
  value != null && typeof value.then === "function";
