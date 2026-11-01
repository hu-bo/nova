# @nova/runner-sdk

Node.js bridge to a remote `nova-runner`. The SDK owns the WebSocket protocol, admission handshake, operation IDs, bounded queues, cancellation, output acknowledgements, and same-boot reconnect reconciliation. It does not register projects or schedule business work; the host decides whether each `RunnerSessionCandidate` is trusted and which stable `principalId` owns it.

```ts
import { createRunnerSdk, toToolContext } from "@nova/runner-sdk";

const sdk = createRunnerSdk({ host: "127.0.0.1", port: 0 });
sdk.onSession(async (candidate) => {
  if (!(await verifyRunner(candidate.token, candidate.identity))) {
    candidate.reject("DENIED", "Runner credentials are invalid.");
    return;
  }
  const session = await candidate.accept({ principalId: "workspace-runner-42" });
  const ctx = toToolContext(session, {
    workspaceId: "project-42",
    cwd: ".",
    signal: new AbortController().signal,
    executionId: "tool-execution-1",
    idempotencyKey: "session/run/tool-execution-1",
  });
  const result = await ctx.fs.read("README.md", { offset: 1, limit: 100 });
  if (result.ok) console.log(result.value.text);
});
await sdk.listen();
```

Every `ctx.fs` and `ctx.exec` method returns `Promise<Result<T>>`. Expected Runner failures retain their code, operation ID, known/unknown outcome, and partial command output when available. A non-zero process exit is a successful execution result with its exit code and stdout/stderr; the caller decides how to interpret it. Once an operation is dispatched, the SDK reconciles it after reconnect and never sends it again.

The SDK can listen on its own HTTP server or attach to an existing Node HTTP server with `createRunnerSdk({ server, path })`. Defaults are a 10-second heartbeat, 10-second Runner handshake timeout, and 30-second admission timeout.

## npm releases

The `runner-sdk-release` GitHub Actions workflow publishes `@nova/runner-protocol` and
`@nova/runner-sdk` to npm, in dependency order, when a `runner-sdk-v*` tag is pushed.
Both packages receive the version from the tag. Stable versions use the `latest`
dist-tag; prereleases such as `runner-sdk-v0.2.0-beta.1` use `next`.

Configure the repository Actions secret `NPM_TOKEN` with a granular npm token that
can publish both packages under the `@nova` scope and has bypass 2FA enabled. Then
push a release tag on the commit to release:

```sh
git tag runner-sdk-v0.1.0
git push origin runner-sdk-v0.1.0
```

The workflow installs from the frozen lockfile, typechecks both packages, runs the
protocol tests, builds, and performs a publish dry run before publishing. pnpm
replaces the SDK's `workspace:*` dependency with the exact protocol version when
packing. Published protocol exports point to compiled JavaScript and declarations;
workspace consumers continue to use its TypeScript source. Already published
versions are skipped, so a partially completed release can be rerun.
