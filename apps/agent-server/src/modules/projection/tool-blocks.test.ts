import { expect, it } from "vitest";
import { projectToolDetails } from "./tool-blocks.js";

it("keeps directory results as plain text rather than file blocks", () => {
  expect(
    projectToolDetails("list_dir", {
      entries: [
        { name: "build.rs", kind: "file" },
        { name: "src", kind: "dir" },
      ],
    }),
  ).toEqual([
    {
      type: "text",
      text: '{\n  "entries": [\n    {\n      "name": "build.rs",\n      "kind": "file"\n    },\n    {\n      "name": "src",\n      "kind": "dir"\n    }\n  ]\n}',
    },
  ]);
});
