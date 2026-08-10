import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  formatSize,
  isToolCallEventType,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_LINES = 400;
const COMMAND_TIMEOUT_MS = 120_000;
const SAFE_EXECUTABLE = /^[A-Za-z0-9._+-]+$/;

const BrowserParams = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 2048, description: "http(s) page to accept" }),
  steps: Type.Optional(Type.Array(Type.Object({
    action: StringEnum(["snapshot", "click", "fill", "press"] as const),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    value: Type.Optional(Type.String({ maxLength: 4096 })),
  }), { maxItems: 40 })),
  evidenceName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});

function requireHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a valid absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  return url.toString();
}

function safeEvidenceName(value: string | undefined): string {
  const normalized = (value ?? "acceptance").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("evidenceName must contain a letter or number");
  return normalized.slice(0, 80);
}

function configuredPlaywright(): string {
  const configured = process.env.PI_MR_SENTINEL_PLAYWRIGHT_CLI?.trim() || "playwright-cli";
  if (isAbsolute(configured)) return configured;
  if (!SAFE_EXECUTABLE.test(configured) || basename(configured) !== configured) {
    throw new Error("PI_MR_SENTINEL_PLAYWRIGHT_CLI must be an absolute executable path or a simple PATH executable name");
  }
  return configured;
}

function evidenceRoot(): string {
  const configured = process.env.PI_MR_SENTINEL_EVIDENCE_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("PI_MR_SENTINEL_EVIDENCE_DIR must be an absolute path");
    return resolve(configured);
  }
  return join(homedir(), ".pi", "agent", "mr-sentinel", "evidence");
}

async function run(pi: ExtensionAPI, command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await pi.exec(command, args, { cwd, signal, timeout: COMMAND_TIMEOUT_MS });
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
  if (result.code !== 0) throw new Error(`${command} failed (exit ${result.code}): ${truncate(output)}`);
  return output || "(no output)";
}

function truncate(output: string): string {
  const result = truncateHead(output, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES });
  return result.truncated
    ? `${result.content}\n\n[Output truncated to ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}.]`
    : result.content;
}

export default function mrSentinel(pi: ExtensionAPI) {
  pi.registerCommand("mr-sentinel", {
    description: "Inspect the current Git change and create/watch a merge request using the host-appropriate CLI",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/mr-sentinel requires interactive mode for side-effect confirmations", "error");
        return;
      }
      pi.sendUserMessage(
        "Prepare a merge request for the current repository. Inspect git status, the relevant diff, and git remote -v first. Generate a concise conventional-commit title and a factual Markdown body without asking me for a title. Select the command-line client appropriate for the remote host: prefer gh for GitHub; for any other host, discover an already-installed suitable client with command -v and --help. Do not install software, alter credentials, expose tokens, or assume a platform-specific client. Before any commit, push, or merge-request creation, state the exact planned action and wait for the extension confirmation prompt. After creation, use the same detected client to query or watch the merge request when that client supports it; otherwise report the created URL and the manual watch command.",
      );
    },
  });

  // The extension remains host-neutral. It gates common local and GitHub write
  // commands, while an unfamiliar hosting client is selected by the model only
  // after it has inspected the repository remote and available executables.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command ?? "";
    const isWrite = /(?:^|[;&|]\s*)git\s+(?:commit|push)\b/m.test(command)
      || /(?:^|[;&|]\s*)gh\s+(?:pr|repo)\s+(?:create|fork)\b/m.test(command)
      || /(?:^|[;&|]\s*)glab\s+mr\s+create\b/m.test(command);
    if (!isWrite) return;
    if (!ctx.hasUI) return { block: true, reason: "Blocked merge-request side effect without an interactive confirmation" };
    const confirmed = await ctx.ui.confirm(
      "Allow merge-request side effect?",
      `The agent wants to run:\n${truncate(command)}\n\nAllow this commit, push, or merge-request creation?`,
    );
    if (!confirmed) return { block: true, reason: "Merge-request side effect cancelled by user" };
  });

  pi.registerTool({
    name: "mr_browser_acceptance",
    label: "MR browser acceptance",
    description: "Run a bounded Playwright CLI acceptance flow and save a final PNG screenshot plus command log under ~/.pi/agent/mr-sentinel/evidence (or PI_MR_SENTINEL_EVIDENCE_DIR). Output is truncated to 400 lines or 16KB.",
    promptSnippet: "Run a bounded browser acceptance flow and preserve screenshot evidence",
    promptGuidelines: ["Use mr_browser_acceptance for browser acceptance that needs persisted screenshot evidence."],
    parameters: BrowserParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const url = requireHttpUrl(params.url);
      const directory = join(evidenceRoot(), new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(directory, { recursive: true });
      const evidenceName = safeEvidenceName(params.evidenceName);
      const session = `mr-sentinel-${evidenceName}-${Date.now()}`;
      const cli = configuredPlaywright();
      const withSession = (args: string[]) => [`-s=${session}`, ...args];
      const logs: string[] = [];
      onUpdate?.({ content: [{ type: "text", text: "Running browser acceptance…" }] });
      logs.push(`$ ${cli} -s=${session} open ${url}\n${await run(pi, cli, withSession(["open", url]), directory, signal)}`);
      for (const step of params.steps ?? []) {
        if ((step.action === "click" || step.action === "fill") && !step.ref) throw new Error(`${step.action} requires ref`);
        if ((step.action === "fill" || step.action === "press") && step.value === undefined) throw new Error(`${step.action} requires value`);
        const args = step.action === "snapshot" ? ["snapshot"]
          : step.action === "click" ? ["click", step.ref!]
          : step.action === "fill" ? ["fill", step.ref!, step.value!]
          : ["press", step.value!];
        logs.push(`$ ${cli} -s=${session} ${args.join(" ")}\n${await run(pi, cli, withSession(args), directory, signal)}`);
      }
      const screenshotOutput = await run(pi, cli, withSession(["screenshot"]), directory, signal);
      logs.push(`$ ${cli} -s=${session} screenshot\n${screenshotOutput}`);
      const match = screenshotOutput.match(/\[Screenshot[^\]]*\]\(([^)]+\.png)\)/i);
      if (!match) throw new Error("Playwright CLI did not report a saved PNG screenshot path");
      const screenshot = resolve(directory, match[1]);
      if (!screenshot.startsWith(`${directory}/`)) throw new Error("Playwright CLI reported a screenshot outside the evidence directory");
      await access(screenshot);
      logs.push(`$ ${cli} -s=${session} close\n${await run(pi, cli, withSession(["close"]), directory, signal)}`);
      const logPath = join(directory, `${evidenceName}-playwright.log`);
      await writeFile(logPath, logs.join("\n\n"), "utf8");
      return {
        content: [{ type: "text", text: `Evidence screenshot: ${screenshot}\nCommand log: ${logPath}\n\n${truncate(logs.join("\n\n"))}` }],
        details: { screenshot, logPath, directory },
      };
    },
  });
}
