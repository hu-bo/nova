# @nova/harness

Static, trusted `AgentModule` composition for Nova. `createHarness()` resolves and freezes tools, prompts, guards, and observers once; each Agent still receives its model, stream, storage, decision function, and Remote Runner `ToolContext` from its Host.

The Server event boundary is the returned Agent's `subscribe(listener)`. The Server owns any `AgentEvent → HTTP/SSE/UI` projection. Cancellation remains `Agent.abort() → AbortSignal → ToolContext → runner-sdk → Remote Runner`.

Chat UI does not consume Harness or Agent state directly. It consumes a future Server projection; the only planned render extension is an instance-level `renderers?: BlockRenderers` input, with controlled callbacks back to the Host and no global renderer registry.
