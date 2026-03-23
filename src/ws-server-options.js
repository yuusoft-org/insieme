const DEFAULT_WS_SERVER_DEFLATE_OPTIONS = Object.freeze({
  threshold: 256,
  concurrencyLimit: 10,
  zlibDeflateOptions: Object.freeze({
    level: 3,
    memLevel: 7,
  }),
  zlibInflateOptions: Object.freeze({
    chunkSize: 10 * 1024,
  }),
});

export const DEFAULT_WS_SERVER_PER_MESSAGE_DEFLATE =
  DEFAULT_WS_SERVER_DEFLATE_OPTIONS;

export const DEFAULT_WS_SERVER_OPTIONS = Object.freeze({
  noServer: true,
  perMessageDeflate: DEFAULT_WS_SERVER_DEFLATE_OPTIONS,
});

const mergePerMessageDeflate = (perMessageDeflate) => {
  if (perMessageDeflate === false || perMessageDeflate === true) {
    return perMessageDeflate;
  }

  const {
    zlibDeflateOptions,
    zlibInflateOptions,
    ...overrides
  } = perMessageDeflate ?? {};

  return {
    ...DEFAULT_WS_SERVER_DEFLATE_OPTIONS,
    ...overrides,
    zlibDeflateOptions: {
      ...DEFAULT_WS_SERVER_DEFLATE_OPTIONS.zlibDeflateOptions,
      ...zlibDeflateOptions,
    },
    zlibInflateOptions: {
      ...DEFAULT_WS_SERVER_DEFLATE_OPTIONS.zlibInflateOptions,
      ...zlibInflateOptions,
    },
  };
};

/**
 * Build recommended `ws` server options for Insieme server runtimes.
 *
 * Callers still create their own `WebSocketServer`; this helper only provides
 * stable defaults plus override handling for `perMessageDeflate`.
 *
 * @param {{
 *   noServer?: boolean,
 *   perMessageDeflate?: boolean | {
 *     threshold?: number,
 *     concurrencyLimit?: number,
 *     serverNoContextTakeover?: boolean,
 *     clientNoContextTakeover?: boolean,
 *     serverMaxWindowBits?: number,
 *     clientMaxWindowBits?: number,
 *     zlibDeflateOptions?: Record<string, unknown>,
 *     zlibInflateOptions?: Record<string, unknown>,
 *   },
 *   [key: string]: unknown,
 * }} [options]
 */
export const createWsServerOptions = (options = {}) => {
  const {
    noServer = DEFAULT_WS_SERVER_OPTIONS.noServer,
    perMessageDeflate = DEFAULT_WS_SERVER_OPTIONS.perMessageDeflate,
    ...rest
  } = options;

  return {
    noServer,
    ...rest,
    perMessageDeflate: mergePerMessageDeflate(perMessageDeflate),
  };
};
