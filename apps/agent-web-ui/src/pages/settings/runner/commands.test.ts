import { describe, expect, it, vi } from "vitest";
import type { RunnerToken } from "@nova/protocol";
import { linuxRunnerCommand, npxRunnerCommand, projectRunnerCommand, windowsRunnerInstallerUrl } from "./commands.js";

describe("runner install commands", () => {
  it("publishes the stable Windows setup asset", () => {
    expect(windowsRunnerInstallerUrl).toMatch(/\/releases\/latest\/download\/nova-runner-setup\.exe$/);
  });

  it("keeps connection values shell-safe in the Linux command", () => {
    const command = linuxRunnerCommand("https://runner.example.com/a'b", "token'value", "desktop'1");

    expect(command).toContain("install-runner.sh");
    expect(command).toContain("'https://runner.example.com/a'\\''b'");
    expect(command).toContain("'token'\\''value'");
    expect(command).toContain("'desktop'\\''1'");
  });

  it("offers the npm package as an explicit quick-run option", () => {
    expect(npxRunnerCommand("https://runner.example.com", "token", "desktop-1")).toBe(
      'npx --yes --package @nnova/runner nova-runner --server "https://runner.example.com" --token "token" --runner-id "desktop-1"',
    );
  });
});

describe("project runner setup", () => {
  const token = (id: string, boundRunnerIds: string[] = []): RunnerToken => ({
    id,
    token: `test-token-${id}`,
    boundRunnerIds,
    createdAt: 0,
  });
  function client(tokens: RunnerToken[] = []) {
    return {
      getRunnerConnectionInfo: vi.fn().mockResolvedValue({ endpoint: "https://runner.example.com" }),
      listRunnerTokens: vi.fn().mockResolvedValue(tokens),
      createRunnerToken: vi.fn().mockResolvedValue(token("new")),
    };
  }

  it("reuses an existing token and uses the directory where the command is run", async () => {
    const api = client([token("existing")]);
    const command = await projectRunnerCommand(api);
    expect(command).toContain('--token "test-token-existing"');
    expect(command).toContain("--workspace .");
    expect(command).not.toContain("--runner-id");
    expect(api.createRunnerToken).not.toHaveBeenCalled();
  });

  it("creates a token when the user has none", async () => {
    const api = client();
    expect(await projectRunnerCommand(api)).toContain('--token "test-token-new"');
    expect(api.createRunnerToken).toHaveBeenCalledOnce();
  });

  it("reconnects the original runner with its own token, regardless of token order", async () => {
    const api = client([token("unrelated"), token("bound", ["desktop-1"])]);
    const command = await projectRunnerCommand(api, "desktop-1");
    expect(command).toContain('--token "test-token-bound" --runner-id "desktop-1"');
    expect(api.createRunnerToken).not.toHaveBeenCalled();
  });

  it("does not reconnect a bound runner with another token or create a replacement", async () => {
    const api = client([token("unrelated")]);
    await expect(projectRunnerCommand(api, "desktop-1")).rejects.toThrow("原 Runner 的 Token 已不可用");
    expect(api.createRunnerToken).not.toHaveBeenCalled();
  });

  it.each(["getRunnerConnectionInfo", "listRunnerTokens"] as const)(
    "does not create a token when %s fails",
    async (method) => {
      const api = client();
      api[method].mockRejectedValue(new Error("unavailable"));
      await expect(projectRunnerCommand(api)).rejects.toThrow("unavailable");
      expect(api.createRunnerToken).not.toHaveBeenCalled();
    },
  );

  it("allows a fresh attempt after token creation fails", async () => {
    const api = client();
    api.createRunnerToken.mockRejectedValueOnce(new Error("unavailable"));
    await expect(projectRunnerCommand(api)).rejects.toThrow("unavailable");
    expect(await projectRunnerCommand(api)).toContain('--token "test-token-new"');
  });
});
