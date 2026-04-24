import { customAlphabet } from "nanoid";

export const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const DEFAULT_ID_LENGTH = 12;

const generateBase58Id = customAlphabet(BASE58_ALPHABET, DEFAULT_ID_LENGTH);

export const generateId = () => generateBase58Id();
