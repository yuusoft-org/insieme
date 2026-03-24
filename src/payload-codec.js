const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isByteNumber = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 255;

const toUint8Array = (value) => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "Buffer" &&
    Array.isArray(value.data) &&
    value.data.every(isByteNumber)
  ) {
    return Uint8Array.from(value.data);
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray(value.bytes) &&
    value.bytes.every(isByteNumber)
  ) {
    return Uint8Array.from(value.bytes);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.length > 0 &&
      keys.every((key) => /^\d+$/.test(key)) &&
      keys.every((key) => isByteNumber(value[key]))
    ) {
      return Uint8Array.from(
        keys
          .map((key) => Number(key))
          .sort((a, b) => a - b)
          .map((key) => value[key]),
      );
    }
  }
  throw new Error("payload must be stored as text or bytes");
};

const decodePossiblySerializedBytes = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  try {
    const bytes = toUint8Array(parsed);
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
};

export const serializePayload = (value) => {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("payload must be JSON-serializable");
  }

  const bytes = encoder.encode(json);
  return typeof Buffer === "function" ? Buffer.from(bytes) : bytes;
};

export const deserializePayload = (value) => {
  if (typeof value === "string") {
    const decodedBytesValue = decodePossiblySerializedBytes(value);
    if (decodedBytesValue !== null) {
      return decodedBytesValue;
    }
    return JSON.parse(value);
  }
  return JSON.parse(decoder.decode(toUint8Array(value)));
};
