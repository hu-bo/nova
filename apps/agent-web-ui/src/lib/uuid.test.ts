import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid.js";

describe("createUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an RFC 4122 version 4 UUID", () => {
    expect(createUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("works when Web Crypto does not implement randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes });

    expect(createUuid()).toBe("00000000-0000-4000-8000-000000000000");
  });
});
