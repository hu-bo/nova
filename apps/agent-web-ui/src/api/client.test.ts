import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachment upload client", () => {
  it("gets signed URLs from Nova and PUTs the file directly to MinIO", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            upload: "https://storage.example.com/file.txt?upload=1",
            download: "https://storage.example.com/file.txt?download=1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "nova-token"),
    });

    const file = new File(["hello"], "file.txt", { type: "text/plain" });
    const uploaded = await createApiClient({ accessToken: "nova-token" }).uploadFile(file);

    expect(uploaded).toEqual({
      url: "https://storage.example.com/file.txt?download=1",
      name: "file.txt",
      size: 5,
      mimeType: "text/plain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/uploads");
    const policyRequest = fetchMock.mock.calls[0]?.[1];
    expect(policyRequest?.headers).toBeInstanceOf(Headers);
    expect((policyRequest?.headers as Headers).get("Authorization")).toBe("Bearer nova-token");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://storage.example.com/file.txt?upload=1");
    const storageRequest = fetchMock.mock.calls[1]?.[1];
    expect(storageRequest).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: file,
    });
  });

  it("asks Nova to upload a file from the selected runner", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: "https://storage.example.com/source.ts?download=1",
          name: "source.ts",
          size: 42,
          mimeType: "text/typescript",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "nova-token") });

    const uploaded = await createApiClient({ accessToken: "nova-token" }).uploadRunnerFile({
      runnerId: "runner-1",
      path: "/workspace/src/source.ts",
    });

    expect(uploaded).toEqual({
      url: "https://storage.example.com/source.ts?download=1",
      name: "source.ts",
      size: 42,
      mimeType: "text/typescript",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/uploads/runner");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ runnerId: "runner-1", path: "/workspace/src/source.ts" }),
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request?.headers as Headers).get("Authorization")).toBe("Bearer nova-token");
    expect((request?.headers as Headers).get("Content-Type")).toBe("application/json");
  });
});
