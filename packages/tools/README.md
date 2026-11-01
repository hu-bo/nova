# @nova/tools

Remote coding tools for `@nnova/harness`: `list_dir`, `read_file`, `write_file`, `edit_file`, `grep`, `bash`, and `git_diff`.

The package has no Runner transport, protocol, process, or filesystem implementation. It receives a narrow context factory and calls only the asynchronous `ctx.fs` and `ctx.exec` methods provided by `@nova/runner-sdk`.

```ts
import { createRemoteTools } from "@nova/tools/harness";

const tools = createRemoteTools({
  createContext: (harnessContext) => session.createToolContext({
    workspaceId: "project-42",
    cwd: ".",
    signal: harnessContext.signal,
    executionId: harnessContext.executionId,
    idempotencyKey: harnessContext.idempotencyKey,
  }),
});
```

`edit_file` uses the digest from its read and an atomic Runner patch. Full-file writes use create-only semantics or compare-and-swap with the observed digest. Writes to the same path are serialized by the Harness resource key. `bash` is a compatibility name: `command` is one executable and each flag or argument belongs in `args`; the host's policy decides whether to authorize its side effects.
