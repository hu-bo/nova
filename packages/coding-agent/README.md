# @nova/coding-agent

Exports only `codingAgentModule`: the Coding workflow prompt plus Nova's eight existing Coding tools. It does not create Agents, read project instructions, connect to a Runner, or project UI blocks. The Host supplies project instructions as instance prompts and creates `ToolContext` through `@nova/runner-sdk`.
