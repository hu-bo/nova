import { describe, expect, it } from "vitest";
import { linuxRunnerCommand, npxRunnerCommand, windowsRunnerInstallerUrl } from "./commands.js";

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
