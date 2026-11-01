import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { createRunnerSdk, toToolContext, type RunnerSession } from "@nova/runner-sdk";
import { createCodingHarness, dashboardProfile } from "../src/index.js";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const continuationRunId = requestedContinuation();
const runId = continuationRunId ?? randomUUID();
const workspace = join(repositoryRoot, "output", "coding-dashboard", runId);
const playwrightArtifacts = join(repositoryRoot, "output", "playwright", `coding-dashboard-${runId}`);
const workspaceId = "coding-dashboard";
const token = randomUUID() + randomUUID();
const controller = new AbortController();
// The agent itself is capped at 15 minutes; keep a five-minute host-validation grace period.
const overallTimeout = setTimeout(() => controller.abort(new Error("Coding dashboard run exceeded its 20-minute end-to-end deadline.")), 20 * 60_000);
overallTimeout.unref();
let runnerProcess: ReturnType<typeof spawn> | undefined;
let runnerProxy: RunnerTcpProxy | undefined;
let previewServer: HttpServer | undefined;
let previewUrl: string | undefined;
let acceptedSession: RunnerSession | undefined;
let harness: Awaited<ReturnType<typeof createCodingHarness>> | undefined;
let sdk: ReturnType<typeof createRunnerSdk> | undefined;

async function main(): Promise<void> {
  try {
  try { process.loadEnvFile(join(repositoryRoot, ".env")); } catch { /* Environment may be supplied by the invoking shell. */ }
  const model = requestedModel() ?? process.env.OPENAI_MODEL;
  if (!model) throw new Error("Set OPENAI_MODEL or pass --model <model-id>; a concrete OpenAI model is required.");
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Set OPENAI_API_KEY and OPENAI_BASE_URL in the environment or repository .env file.");

  if (continuationRunId) {
    await stat(join(workspace, "plan.md"));
    await stat(join(workspace, "index.html"));
  }
  await mkdir(workspace, { recursive: true });
  await mkdir(playwrightArtifacts, { recursive: true });
  await startPreviewServer();
  const runnerBinary = await ensureRunnerBinary();
  sdk = createRunnerSdk({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 10_000, admissionTimeoutMs: 30_000 });
  const sessionPromise = new Promise<RunnerSession>((resolveSession, rejectSession) => {
    const admissionTimeout = setTimeout(() => rejectSession(new Error("Runner Session was not admitted within 30 seconds.")), 30_000);
    sdk!.onSession(async (candidate) => {
      if (!sameSecret(candidate.token, token)) {
        candidate.reject("DENIED", "Runner credentials were not accepted.");
        return;
      }
      if (candidate.identity.workspaces.length !== 1 || candidate.identity.workspaces[0]?.workspaceId !== workspaceId || candidate.identity.workspaces[0]?.permission !== "READ_WRITE") {
        candidate.reject("DENIED", "Runner workspace registration did not match the example.");
        return;
      }
      try {
        const session = await candidate.accept({ principalId: `coding-dashboard:${runId}` });
        clearTimeout(admissionTimeout);
        resolveSession(session);
      } catch (error) {
        clearTimeout(admissionTimeout);
        rejectSession(error instanceof Error ? error : new Error("Runner session admission failed."));
      }
    });
  });
  await sdk.listen();
  runnerProxy = new RunnerTcpProxy(sdk.endpoint);
  await runnerProxy.listen();

  const runnerEnv: NodeJS.ProcessEnv = { ...process.env, NOVA_RUNNER_SERVER: runnerProxy.endpoint, NOVA_RUNNER_TOKEN: token, NOVA_RUNNER_WORKSPACE: workspace, NOVA_RUNNER_WORKSPACE_ID: workspaceId, NOVA_RUNNER_ID: `coding-dashboard:${runId}` };
  delete runnerEnv.OPENAI_API_KEY;
  delete runnerEnv.OPENAI_BASE_URL;
  delete runnerEnv.OPENAI_MODEL;
  runnerProcess = spawn(runnerBinary, [], { env: runnerEnv, stdio: ["ignore", "pipe", "pipe"] });
  runnerProcess.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[runner] ${chunk.toString()}`));
  runnerProcess.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[runner] ${chunk.toString()}`));
  runnerProcess.once("error", (error) => console.error(`Runner process failed: ${error.message}`));
  runnerProcess.once("exit", (code) => {
    if (!acceptedSession) console.error(`Runner exited before admission (code ${code ?? "unknown"}).`);
  });
  acceptedSession = await sessionPromise;
  console.info(`Runner connected: ${acceptedSession.identity.runnerId} (${acceptedSession.bootId}).`);
  if (!continuationRunId) await verifyRunnerTransport(acceptedSession, runnerProxy);

  harness = await createCodingHarness({
    session: acceptedSession,
    workspaceId,
    cwd: ".",
    model: { baseURL, apiKey, model, contextWindow: 128_000, maxOutputTokens: 32_768 },
    sessionId: `coding-dashboard-${runId}`,
    maxRunMs: 15 * 60_000,
    profile: { ...dashboardProfile, plan: { path: "plan.md", alreadyWritten: continuationRunId !== undefined } },
    onEvent(event) {
      if (event.type === "assistant.delta") process.stdout.write(event.text);
      else if (event.type === "tool.started") console.info(`\n[tool] ${event.name}`);
      else if (event.type === "tool.finished") console.info(`[tool ${event.status}] ${event.name}`);
    },
  });

  let findings: string[] = [];
  let remainingMs = 15 * 60_000;
  let retryMode: "normal" | "skeleton" | "finish" | "repair" = continuationRunId ? "repair" : "normal";
  if (continuationRunId) {
    const syntaxFinding = await validateDashboardSource(acceptedSession, controller.signal);
    if (syntaxFinding) findings.push(syntaxFinding);
    if (!findings.length) {
      try { findings.push(...await inspectBrowser()); }
      catch (error) { findings.push(`Playwright CLI inspection failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
    if (!findings.length) {
      console.info(`\nValidated output: ${workspace}`);
      console.info(`Playwright screenshots and session logs: ${playwrightArtifacts}`);
      return;
    }
    console.warn(`Existing workspace validation findings:\n${findings.map((item) => `- ${item}`).join("\n")}`);
    console.warn("\nValidation found issues; asking the Harness session to repair the existing planned workspace.");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = Date.now();
    const request = retryMode === "skeleton"
      ? stagedImplementationStart
      : retryMode === "finish"
        ? stagedImplementationFinish
        : retryMode === "repair" || attempt > 0
          ? repairRequest(findings)
          : dashboardRequest;
    const result = await harness.run(request, {
      signal: controller.signal,
      timeoutMs: remainingMs,
    });
    remainingMs = Math.max(0, remainingMs - (Date.now() - started));
    if (result.status !== "succeeded") {
      const unknown = result.toolCalls.some((call) => call.outcome === "unknown");
      if (!unknown && ["MODEL_REQUEST_FAILED", "MODEL_LENGTH"].includes(result.error?.code ?? "") && attempt < 3) {
        if (retryMode === "normal") retryMode = "skeleton";
        if (retryMode !== "repair")
          findings = ["The previous model response did not complete. plan.md is accepted. Continue using small, staged index.html edits; do not repeat a dispatched tool operation."];
        console.warn("Model response did not complete; continuing with staged index.html edits in the same Harness session.");
        continue;
      }
      throw new Error(`Coding Harness ended ${result.status}${unknown ? " with an unknown remote tool outcome" : ""}: ${result.error?.message ?? result.text}`);
    }
    if (retryMode === "skeleton") {
      retryMode = "finish";
      findings = [];
      continue;
    }
    if (retryMode === "finish") retryMode = "repair";
    findings = [];
    const syntaxFinding = await validateDashboardSource(acceptedSession, controller.signal);
    if (syntaxFinding) findings.push(syntaxFinding);
    if (!findings.length) {
      try {
        findings.push(...await inspectBrowser());
      } catch (error) {
        findings.push(`Playwright CLI inspection failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (findings.length === 0) {
      console.info(`\nValidated output: ${workspace}`);
      console.info(`Playwright screenshots and session logs: ${playwrightArtifacts}`);
      return;
    }
    console.warn(`Browser validation findings:\n${findings.map((item) => `- ${item}`).join("\n")}`);
    console.warn("\nValidation found issues; asking the same Harness session to repair index.html.");
    if (attempt === 3 || remainingMs <= 0) throw new Error(findings.join("\n"));
    retryMode = "repair";
  }
  } finally {
    clearTimeout(overallTimeout);
    await harness?.close();
    if (previewServer?.listening) await new Promise<void>((resolveClose) => previewServer!.close(() => resolveClose()));
    if (runnerProcess && runnerProcess.exitCode === null) {
      const runnerExit = new Promise<void>((resolveExit) => runnerProcess!.once("exit", () => resolveExit()));
      runnerProcess.kill();
      await runnerExit;
    }
    await runnerProxy?.close();
    await sdk?.close();
  }
}

const dashboardRequest = `Build the planned coding dashboard now. Follow plan.md, and create only index.html.

Product brief:
- Create a polished “Northstar Commerce” operations dashboard with a premium editorial look: warm paper background, deep ink text, coral and teal accents, restrained shadows, rounded but not pill-heavy cards, clear spacing, and a strong type scale.
- Use a fixed seeded dataset of at least 60 realistic e-commerce orders covering at least 6 categories, multiple regions, payment methods, statuses, and dates. Derive every KPI, chart, filter count, and table row from this one dataset.
- KPI cards: gross revenue, orders, average order value, and refund rate, each with a comparison to the previous period.
- Show revenue over time and category mix in native SVG or Canvas charts with useful labels and an accessible text summary.
- Add a date range selector, category selector, live text search, sortable columns, 10-row pagination with a result count, and a reset-filters control.
- An order-details action on each row opens an accessible dialog with order, customer, location, items, payment, and status; support Escape and close button.
- Add an accessible light/dark theme toggle and persist its choice locally.
- Ensure every control works without network access. Use semantic HTML, visible focus, reduced-motion support, and responsive mobile layout with no page-level horizontal overflow.
- Stable DOM hooks required for host inspection: #themeToggle, #dateRange, #categoryFilter, #searchInput, #sortSelect, #resetFilters, #tableBody, #pageInfo, #nextPage, #prevPage, #detailsDialog, #revenueChart, and #categoryChart. Give the per-row details buttons data-action="details".
- Keep the complete source concise (under 24 KiB) and generate seeded data rather than enumerating order rows. If needed, write a small HTML skeleton with unique style/script markers, then replace those markers using separate edit_file calls. Wait for each successful tool result; the host will run checks.`;

const stagedImplementationStart = `Continue from the accepted plan.md. Create a compact, accessible index.html skeleton under 4 KiB using one write_file call. Include the Northstar title, semantic sections, every required hook (#themeToggle, #dateRange, #categoryFilter, #searchInput, #sortSelect, #resetFilters, #tableBody, #pageInfo, #nextPage, #prevPage, #detailsDialog, #revenueChart, #categoryChart), and exactly these unique placeholders: /* DASHBOARD_STYLE */ inside one inline style element and /* DASHBOARD_SCRIPT */ inside one inline script element. Include table headers and empty chart containers. Wait for the successful write result. Do not attempt the complete dashboard in this response.`;

const stagedImplementationFinish = `Complete the dashboard in the existing index.html only. Use edit_file to replace the unique /* DASHBOARD_STYLE */ marker with compact polished responsive CSS, then wait for its successful result. In a separate tool call replace /* DASHBOARD_SCRIPT */ with compact native JavaScript that deterministically generates at least 72 seeded e-commerce orders and derives all KPIs, previous-period comparisons, date/category/search filters, sorting, 10-row pagination, detail dialog, theme persistence, and accessible SVG revenue/category charts from that array. Keep each edit under 8 KiB, all controls functional, no network dependencies, and do not run commands; the host validates the page.`;

function repairRequest(findings: string[]): string {
  return `Repair the existing index.html in place using edit_file where possible. Keep plan.md unchanged and do not create another file. Keep the complete UTF-8 source below 24 KiB (24,576 bytes) while preserving all required dashboard features. These real validation findings need fixing:\n${findings.map((item) => `- ${item}`).join("\n")}\nAfter repairs, rerun the inline script syntax check with bash (a direct node -e command and args array) and report the result. Do not claim browser results; the host will inspect the page again.`;
}

async function remoteInlineScriptCheck(session: RunnerSession, signal: AbortSignal) {
  const validationId = randomUUID();
  const context = toToolContext(session, { workspaceId, cwd: ".", signal, executionId: validationId, idempotencyKey: validationId });
  const source = "const fs=require('node:fs');const html=fs.readFileSync('index.html','utf8');const bytes=Buffer.byteLength(html,'utf8');if(bytes>24576)throw Error('HTML_SOURCE_BYTES='+bytes+' exceeds 24576');const scripts=[...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(Boolean);if(!scripts.length)throw Error('no inline scripts');for(const script of scripts)new Function(script);console.log('INLINE_JS_SYNTAX_OK '+scripts.length+' HTML_BYTES '+bytes);";
  return context.exec("node", { args: ["-e", source], cwd: ".", timeoutMs: 30_000, signal });
}

async function validateDashboardSource(session: RunnerSession, signal: AbortSignal): Promise<string | undefined> {
  let result = await remoteInlineScriptCheck(session, signal);
  if (result.ok && result.value.exitCode === 0) return undefined;
  let details = result.ok ? result.value.stderr || result.value.stdout : result.error.message;
  if (details.includes("HTML_SOURCE_BYTES=")) {
    try {
      const bytesBefore = await compactDashboardSource(session, signal);
      console.info(`Reduced dashboard source to ${bytesBefore} UTF-8 bytes using a Runner-verified atomic patch.`);
      result = await remoteInlineScriptCheck(session, signal);
      if (result.ok && result.value.exitCode === 0) return undefined;
      details = result.ok ? result.value.stderr || result.value.stdout : result.error.message;
    } catch (error) {
      details = error instanceof Error ? error.message : "unknown compaction error";
    }
  }
  return `Remote inline JavaScript syntax/size check failed: ${details}`;
}

async function compactDashboardSource(session: RunnerSession, signal: AbortSignal): Promise<number> {
  const operationId = randomUUID();
  const context = toToolContext(session, { workspaceId, cwd: ".", signal, executionId: operationId, idempotencyKey: operationId });
  const current = await context.fs.read("index.html", { offset: 1, limit: 1_000, signal });
  if (!current.ok) throw new Error(`Could not read index.html for compacting: ${current.error.code} ${current.error.message}`);
  if (current.value.truncated) throw new Error("Runner returned a truncated index.html; refusing to compact partial source.");

  const temporaryInput = join(playwrightArtifacts, `.dashboard-${operationId}.html`);
  const temporaryOutput = join(playwrightArtifacts, `.dashboard-${operationId}.min.html`);
  try {
    await writeFile(temporaryInput, current.value.text, "utf8");
    const npxCli = await locateNpxCli();
    await execFileAsync(process.execPath, [
      npxCli,
      "--yes",
      "--package",
      "html-minifier-terser",
      "html-minifier-terser",
      temporaryInput,
      "--collapse-whitespace",
      "--collapse-boolean-attributes",
      "--remove-comments",
      "--remove-attribute-quotes",
      "--remove-redundant-attributes",
      "--remove-optional-tags",
      "--minify-css",
      "true",
      "--minify-js",
      "true",
      "--output",
      temporaryOutput,
    ], { cwd: repositoryRoot, timeout: 120_000, maxBuffer: 1_048_576 });
    let compact = await readFile(temporaryOutput, "utf8");
    compact = compact.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/i, "");
    compact = compact.replace("table{width:100%;max-width:100%;table-layout:fixed;", "table{width:100%;table-layout:fixed;");
    compact = compact.replace(".site-footer{text-align:center;color:var(--muted);font-size:12px;padding:0 16px 28px}", "");
    const sizeBytes = Buffer.byteLength(compact, "utf8");
    if (sizeBytes > 24 * 1_024) throw new Error(`Compacted index.html is still ${sizeBytes} bytes; limit is 24576.`);
    const patched = await context.fs.patch("index.html", [{ oldText: current.value.text, newText: compact }], {
      expectedSha256: current.value.sha256,
      signal,
    });
    if (!patched.ok) throw new Error(`Runner rejected the compacted index.html patch: ${patched.error.code} ${patched.error.message}`);
    if (patched.value.sizeBytes > 24 * 1_024) throw new Error(`Runner committed ${patched.value.sizeBytes} bytes, above the 24576-byte limit.`);
    return patched.value.sizeBytes;
  } finally {
    await Promise.all([unlink(temporaryInput).catch(() => undefined), unlink(temporaryOutput).catch(() => undefined)]);
  }
}

async function locateNpxCli(): Promise<string> {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npx-cli.js"),
  ];
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* Try the next Node installation layout. */ }
  }
  throw new Error("Could not locate the npm npx launcher.");
}

async function verifyRunnerTransport(session: RunnerSession, proxy: RunnerTcpProxy): Promise<void> {
  const validationId = randomUUID();
  const context = toToolContext(session, {
    workspaceId,
    cwd: ".",
    signal: controller.signal,
    executionId: validationId,
    idempotencyKey: validationId,
  });
  const markerPath = join(process.env.TEMP ?? process.env.TMP ?? ".", `nova-runner-reconcile-${runId}`);
  const reconnectScript = [
    "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');",
    `const marker=${JSON.stringify(markerPath)},lock=marker+'.lock';`,
    "const wait=new Int32Array(new SharedArrayBuffer(4));",
    "while(true){try{fs.mkdirSync(lock);break}catch(e){if(e.code!=='EEXIST')throw e;Atomics.wait(wait,0,0,10)}}",
    "const count=(fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8')):0)+1;",
    "fs.writeFileSync(marker,String(count));fs.rmdirSync(lock);console.log('RECONNECT_COUNT='+count);console.log('RECONNECT_STARTED');",
    "setTimeout(()=>{console.log('RECONNECT_FINISHED');fs.rmSync(marker,{force:true})},2800);",
  ].join("");
  let reconnectOutput = "";
  const reconnectOperation = context.exec("node", {
    args: ["-e", reconnectScript],
    cwd: ".",
    timeoutMs: 20_000,
    signal: controller.signal,
    onOutput(chunk) { reconnectOutput += chunk.text; },
  });
  try {
    await waitUntil(() => reconnectOutput.includes("RECONNECT_STARTED"), 5_000, "Runner command did not start before the reconnect check.");
    proxy.disconnectActive();
    const result = await reconnectOperation;
    if (!result.ok || result.value.exitCode !== 0 || !result.value.stdout.includes("RECONNECT_COUNT=1"))
      throw new Error(`Same-boot reconnect did not recover one completed operation: ${result.ok ? JSON.stringify({ exitCode: result.value.exitCode, durationMs: result.value.durationMs, stdout: result.value.stdout, stderr: result.value.stderr, outputGap: result.value.outputGap, truncated: result.value.truncated }) : JSON.stringify(result.error)}`);
    await waitUntil(() => session.connected, 5_000, "Runner did not reconnect after the transport was interrupted.");
    console.info("Runner recovery verified: work continued through disconnect, terminal status reconciled, and the side effect ran once.");
  } catch (error) {
    await reconnectOperation.catch(() => undefined);
    throw error;
  }

  const floodSource = "const chunk=Buffer.alloc(65536,'x');let left=20*1024*1024;function write(){while(left>0){const n=Math.min(left,chunk.length);left-=n;if(!process.stdout.write(chunk.subarray(0,n))){process.stdout.once('drain',write);return}}}write();";
  const floodPromise = context.exec("node", { args: ["-e", floodSource], cwd: ".", timeoutMs: 30_000, signal: controller.signal });
  await delay(50);
  const cancellationPromise = verifyChildCleanup(context, "CANCELLED", 15_000, true);
  const [, flood] = await Promise.all([cancellationPromise, floodPromise]);
  if (!flood.ok || flood.value.exitCode !== 0 || !flood.value.truncated || !flood.value.outputGap)
    throw new Error(`Output pressure did not stay bounded: ${flood.ok ? JSON.stringify({ exitCode: flood.value.exitCode, truncated: flood.value.truncated, outputGap: flood.value.outputGap }) : flood.error.message}`);
  console.info("Output pressure verified: 20 MiB of command output stayed bounded while a cancellation control message completed.");

  await verifyChildCleanup(context, "TIMEOUT", 1_500, false);
  console.info("Process cleanup verified for both explicit cancellation and command timeout.");
}

async function verifyChildCleanup(
  context: ReturnType<typeof toToolContext>,
  expectedCode: "CANCELLED" | "TIMEOUT",
  timeoutMs: number,
  abort: boolean,
): Promise<void> {
  const childSource = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('CHILD_PID='+child.pid);setInterval(()=>{},1000);";
  const aborter = new AbortController();
  let output = "";
  const operation = context.exec("node", {
    args: ["-e", childSource],
    cwd: ".",
    timeoutMs,
    signal: abort ? aborter.signal : controller.signal,
    onOutput(chunk) { output += chunk.text; },
  });
  if (abort) {
    await waitUntil(() => output.includes("CHILD_PID="), 5_000, "Child process did not report its PID before cancellation.");
    aborter.abort(new Error("Manual remote Runner cancellation check."));
  }
  const result = await operation;
  const pidMatch = `${output}${!result.ok && typeof result.error.details?.stdout === "string" ? result.error.details.stdout : ""}`.match(/CHILD_PID=(\d+)/);
  if (!pidMatch) throw new Error("Could not read the child PID needed to verify process cleanup.");
  if (result.ok || result.error.code !== expectedCode)
    throw new Error(`Expected ${expectedCode} from Runner, received ${result.ok ? `exit ${result.value.exitCode}` : result.error.code}.`);
  const pid = Number(pidMatch[1]);
  const cleanup = await context.exec("node", {
    args: ["-e", `try{process.kill(${pid},0);process.exit(9)}catch(error){if(error.code==='ESRCH')process.exit(0);process.exit(8)}`],
    cwd: ".",
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  if (!cleanup.ok || cleanup.value.exitCode !== 0)
    throw new Error(`Runner did not clean up process ${pid} after ${expectedCode.toLowerCase()}.`);
}

async function startPreviewServer(): Promise<void> {
  previewServer = createServer((request, response) => {
    if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (request.url !== "/" && request.url !== "/index.html") { response.writeHead(404).end("Not found"); return; }
    void readFile(join(workspace, "index.html")).then((html) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    }, () => response.writeHead(404).end("Dashboard has not been created yet."));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    previewServer!.once("error", rejectListen);
    previewServer!.listen(0, "127.0.0.1", () => { previewServer!.off("error", rejectListen); resolveListen(); });
  });
  const address = previewServer.address();
  if (!address || typeof address === "string") throw new Error("Coding dashboard preview server did not bind to a TCP port.");
  previewUrl = `http://127.0.0.1:${address.port}/index.html`;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class RunnerTcpProxy {
  endpoint: string;
  readonly #server: TcpServer;
  readonly #sockets = new Set<Socket>();

  constructor(endpoint: string) {
    const target = new URL(endpoint);
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1) throw new Error("Runner SDK endpoint does not expose a TCP port.");
    this.#server = createTcpServer((client) => {
      const upstream = connectTcp(port, target.hostname.replace(/^\[|\]$/g, ""));
      this.#sockets.add(client);
      this.#sockets.add(upstream);
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      const closePair = () => { client.destroy(); upstream.destroy(); };
      client.on("error", closePair);
      upstream.on("error", closePair);
      client.on("close", () => { this.#sockets.delete(client); if (!upstream.destroyed) upstream.destroy(); });
      upstream.on("close", () => { this.#sockets.delete(upstream); if (!client.destroyed) client.destroy(); });
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.endpoint = `ws://127.0.0.1:0${target.pathname}`;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolveListen, rejectListen) => {
      this.#server.once("error", rejectListen);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", rejectListen);
        const address = this.#server.address();
        if (!address || typeof address === "string") { rejectListen(new Error("Runner proxy did not bind to a TCP port.")); return; }
        this.endpoint = `ws://127.0.0.1:${address.port}${new URL(this.endpoint).pathname}`;
        resolveListen();
      });
    });
  }

  disconnectActive(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.disconnectActive();
    if (this.#server.listening) await new Promise<void>((resolveClose) => this.#server.close(() => resolveClose()));
  }
}

async function inspectBrowser(): Promise<string[]> {
  if (!previewUrl) throw new Error("Coding dashboard preview server has not started.");
  const htmlUrl = previewUrl;
  const env = { ...process.env, PLAYWRIGHT_CLI_SESSION: `coding-dashboard-${runId}-${randomUUID()}` };
  await runPlaywright(["open", htmlUrl], env);
  const findings: string[] = [];
  await runPlaywright(["resize", "1440", "1000"], env);
  const desktopSnapshot = await runPlaywright(["snapshot"], env);
  if (!desktopSnapshot.includes("Northstar")) findings.push("Desktop accessibility snapshot is missing the Northstar dashboard title.");
    await runPlaywright(["screenshot", "--filename", "desktop.png"], env);
    const desktop = await runPlaywright(["eval", "({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rows:document.querySelectorAll('#tableBody tr').length,title:document.title})"], env);
    console.info(`Desktop viewport check: ${desktop.trim()}`);
  if (hasPageOverflow(desktop)) findings.push("Desktop page has horizontal overflow or no rendered table rows.");

  const interactions = "(() => { const q=(s)=>document.querySelector(s); const required=['#themeToggle','#dateRange','#categoryFilter','#searchInput','#sortSelect','#resetFilters','#tableBody','#pageInfo','#nextPage','#prevPage','#detailsDialog','#revenueChart','#categoryChart']; const missing=required.filter(s=>!q(s)); if(missing.length) return {error:'missing controls '+missing.join(',')}; const theme=q('#themeToggle'); const old=document.documentElement.dataset.theme||getComputedStyle(document.body).color; theme.click(); const themeChanged=(document.documentElement.dataset.theme||getComputedStyle(document.body).color)!==old; const search=q('#searchInput'); search.value='north'; search.dispatchEvent(new Event('input',{bubbles:true})); const filtered=q('#tableBody').rows.length; q('#resetFilters').click(); const category=q('#categoryFilter'); if(category.options.length>1){category.selectedIndex=1;category.dispatchEvent(new Event('change',{bubbles:true}));} const sort=q('#sortSelect'); if(sort.options.length>1){sort.selectedIndex=1;sort.dispatchEvent(new Event('change',{bubbles:true}));} q('#resetFilters').click(); q('#nextPage').click(); const page=q('#pageInfo').textContent; q('#prevPage').click(); const detail=q('#tableBody [data-action=\"details\"]'); if(detail)detail.click(); const dialog=q('#detailsDialog'); const dialogOpened=!!dialog.open; if(dialogOpened)dialog.close(); return {themeChanged,filtered,page,dialogOpened,chartRevenue:!!q('#revenueChart').children.length,chartCategory:!!q('#categoryChart').children.length}; })()";
  const interactionResult = await runPlaywright(["eval", interactions], env);
  if (/"error"\s*:/.test(interactionResult) || !/"themeChanged"\s*:\s*true/.test(interactionResult) || !/"dialogOpened"\s*:\s*true/.test(interactionResult))
    findings.push(`Dashboard interactions did not pass: ${interactionResult}`);

  await runPlaywright(["resize", "390", "844"], env);
    const mobile = await runPlaywright(["eval", "({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rows:document.querySelectorAll('#tableBody tr').length})"], env);
    console.info(`Mobile viewport check: ${mobile.trim()}`);
  if (hasPageOverflow(mobile)) findings.push("Mobile page overflows the viewport or lost its table rows.");
    await runPlaywright(["screenshot", "--filename", "mobile.png"], env);
    const errors = await runPlaywright(["console", "error"], env);
    const errorCount = errors.match(/\bErrors:\s*(\d+)\b/i)?.[1];
    if (errors.trim() && !/No console errors/i.test(errors) && (errorCount === undefined || Number(errorCount) > 0))
      findings.push(`Browser console reports errors: ${errors.slice(0, 2_000)}`);
  await runPlaywright(["close"], env);
  return findings;
}

async function runPlaywright(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npx-cli.js"),
  ];
  const npxCli = candidates.find((candidate) => candidate.length > 0);
  let cliPath: string | undefined;
  for (const candidate of candidates) {
    try { await stat(candidate); cliPath = candidate; break; } catch { /* Try the next Node installation layout. */ }
  }
  if (!cliPath || !npxCli) throw new Error("Could not locate the npm npx launcher required by Playwright CLI.");
  const cliArgs = ["--yes", "--package", "@playwright/cli", "playwright-cli", ...args];
  return await new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], { cwd: playwrightArtifacts, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectOutput);
    child.once("exit", (code) => code === 0 ? resolveOutput(stdout + stderr) : rejectOutput(new Error(`playwright-cli ${args[0]} exited ${code}: ${(stderr || stdout).slice(0, 2_000)}`)));
  });
}

function hasPageOverflow(output: string): boolean {
  const resultStart = output.indexOf("### Result");
  const match = resultStart < 0 ? null : output.slice(resultStart).match(/\{[^{}]*\}/);
  if (!match) return true;
  try {
    const data = JSON.parse(match[0]) as { width?: number; bodyWidth?: number; rows?: number };
    // Ignore documentElement.scrollWidth: a table that scrolls inside .table-wrap
    // contributes its intrinsic width there without creating page-level scrolling.
    return (data.bodyWidth ?? data.width ?? Infinity) > (data.width ?? -1) + 1 || (data.rows ?? 0) < 1;
  } catch { return true; }
}

async function ensureRunnerBinary(): Promise<string> {
  const binary = join(repositoryRoot, "target", "debug", process.platform === "win32" ? "nova-runner.exe" : "nova-runner");
  try { await stat(binary); return binary; }
  catch { await execFileAsync("cargo", ["build", "-p", "nova-runner"], { cwd: repositoryRoot, timeout: 5 * 60_000 }); return binary; }
}

function requestedModel(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (item === "--model") return args[index + 1];
    if (item.startsWith("--model=")) return item.slice("--model=".length);
  }
  return undefined;
}

function requestedContinuation(): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf("--continue");
  if (index < 0) return undefined;
  const candidate = args[index + 1];
  if (!candidate || !/^[0-9a-f-]{36}$/i.test(candidate)) throw new Error("--continue requires a coding-dashboard run UUID.");
  return candidate;
}

function sameSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Coding dashboard example failed.");
  process.exitCode = 1;
});
