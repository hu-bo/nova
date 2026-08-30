import { describe, expect, it } from "vitest";
import { displayWorkspacePath } from "./workspace-path.js";

describe("displayWorkspacePath", () => {
  it("removes a Windows extended-length prefix", () => {
    expect(displayWorkspacePath("\\\\?\\E:\\Project\\nova")).toBe("E:\\Project\\nova");
  });

  it("turns an extended UNC path back into a regular UNC path", () => {
    expect(displayWorkspacePath("\\\\?\\UNC\\server\\share\\nova")).toBe("\\\\server\\share\\nova");
  });

  it("keeps regular Windows and POSIX paths unchanged", () => {
    expect(displayWorkspacePath("E:\\Project\\nova")).toBe("E:\\Project\\nova");
    expect(displayWorkspacePath("/srv/nova")).toBe("/srv/nova");
  });
});
