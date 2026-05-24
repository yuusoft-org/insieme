import { describe, expect, it } from "vitest";
import {
  buildCommittedEventFromDraft,
  cloneObject,
  isNonEmptyString,
  isObject,
  normalizeClientTs,
  normalizeMeta,
  normalizeSubmitEventInput,
  toFiniteNumberOrNull,
  toPositiveIntegerOrNull,
} from "../../../src/event-record.js";

describe("src event-record helpers", () => {
  it("classifies object and scalar inputs", () => {
    expect(isObject({ ok: true })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
  });

  it("normalizes numeric fields with safe fallbacks", () => {
    expect(toFiniteNumberOrNull("42.5")).toBe(42.5);
    expect(toFiniteNumberOrNull("not-a-number")).toBe(null);
    expect(toPositiveIntegerOrNull(3)).toBe(3);
    expect(toPositiveIntegerOrNull(3.2)).toBe(null);
    expect(toPositiveIntegerOrNull("3")).toBe(null);
    expect(normalizeClientTs("10", { defaultClientTs: 20 })).toBe(10);
    expect(normalizeClientTs(undefined, { defaultClientTs: 20 })).toBe(20);
    expect(normalizeClientTs("bad")).toBeUndefined();
  });

  it("normalizes metadata without mutating the input", () => {
    const meta = { clientId: "", clientTs: "bad", extra: { keep: true } };
    const normalized = normalizeMeta(meta, {
      defaultClientId: "C1",
      defaultClientTs: 100,
    });

    expect(normalized).toEqual({
      clientId: "C1",
      clientTs: 100,
      extra: { keep: true },
    });
    expect(meta).toEqual({ clientId: "", clientTs: "bad", extra: { keep: true } });
    expect(normalizeMeta({}, {})).toEqual({});
  });

  it("clones only plain objects and otherwise returns fallback", () => {
    const source = { nested: { value: 1 } };
    const cloned = cloneObject(source);
    cloned.nested.value = 2;
    expect(source.nested.value).toBe(1);
    expect(cloneObject([], { fallback: true })).toEqual({ fallback: true });
  });

  it("normalizes direct and nested submit event input shapes", () => {
    expect(
      normalizeSubmitEventInput(
        {
          event: {
            type: "nested.created",
            schemaVersion: 2,
            payload: { id: "n1" },
          },
          meta: { clientTs: "123" },
        },
        {
          defaultId: "evt-1",
          defaultProjectId: "proj-1",
          defaultClientId: "C1",
        },
      ),
    ).toEqual({
      id: "evt-1",
      partition: undefined,
      projectId: "proj-1",
      userId: undefined,
      type: "nested.created",
      schemaVersion: 2,
      payload: { id: "n1" },
      clientTs: 123,
      meta: { clientId: "C1", clientTs: 123 },
    });

    expect(
      normalizeSubmitEventInput({
        id: "evt-direct",
        partition: "P1",
        projectId: "proj-2",
        userId: "U1",
        type: "direct.created",
        schemaVersion: 1,
        payload: { id: "d1" },
        clientTs: "456",
        meta: { clientId: "C2" },
      }),
    ).toMatchObject({
      id: "evt-direct",
      partition: "P1",
      projectId: "proj-2",
      userId: "U1",
      type: "direct.created",
      schemaVersion: 1,
      payload: { id: "d1" },
      clientTs: 456,
      meta: { clientId: "C2" },
    });
  });

  it("builds committed events from drafts with timestamp fallback", () => {
    expect(
      buildCommittedEventFromDraft({
        draft: {
          id: "evt-1",
          projectId: "proj-1",
          userId: "U1",
          partition: "P1",
          type: "created",
          schemaVersion: 1,
          payload: { ok: true },
          payloadCompression: null,
          meta: { clientTs: 111 },
        },
        committedId: 10,
        serverTs: 200,
      }),
    ).toEqual({
      committedId: 10,
      id: "evt-1",
      projectId: "proj-1",
      userId: "U1",
      partition: "P1",
      type: "created",
      schemaVersion: 1,
      payload: { ok: true },
      payloadCompression: null,
      clientTs: 111,
      serverTs: 200,
    });
  });
});
