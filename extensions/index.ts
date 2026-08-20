import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  formatSize,
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

type MergeRequest = {
  kind: "PR" | "MR";
  number: number;
  state: string;
  title?: string;
  url?: string;
  baseRef?: string;
};

type HerdrResponse<T> = { result: T };

type HerdrPane = { pane_id: string; tab_id: string; workspace_id: string };
type HerdrWorkspace = { workspace_id: string };
type HerdrTab = { tab_id: string };

const MONITOR_INTERVAL_MS = 5 * 60_000;

export default function mrSentinel(pi: ExtensionAPI) {
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let maintenanceQueued = false;
  let conflictResolutionQueued = false;
  let currentMergeRequest: MergeRequest | undefined;
  const mergedNotifications = new Set<string>();
  const namedSessions = new Map<string, string>();
  const namingRequested = new Set<string>();
  let lastHerdrRename: string | undefined;

  async function tryExec(command: string, args: string[], cwd: string) {
    try {
      return await pi.exec(command, args, { cwd, timeout: COMMAND_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }

  async function findMergeRequest(cwd: string): Promise<MergeRequest | undefined> {
    const gh = await tryExec("gh", ["pr", "view", "--json", "number,state,title,url,baseRefName"], cwd);
    if (gh?.code === 0) {
      const result = JSON.parse(gh.stdout) as { number: number; state: string; title?: string; url?: string; baseRefName?: string };
      return { kind: "PR", number: result.number, state: result.state, title: result.title, url: result.url, baseRef: result.baseRefName };
    }

    const glab = await tryExec("glab", ["mr", "view", "--output", "json"], cwd);
    if (glab?.code === 0) {
      const result = JSON.parse(glab.stdout) as { iid: number; state: string; title?: string; web_url?: string; target_branch?: string };
      return { kind: "MR", number: result.iid, state: result.state, title: result.title, url: result.web_url, baseRef: result.target_branch };
    }

    const [remote, branch] = await Promise.all([
      tryExec("git", ["remote", "get-url", "origin"], cwd),
      tryExec("git", ["branch", "--show-current"], cwd),
    ]);
    const repo = remote?.code === 0 && remote.stdout.trim().match(/(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?\s*$/)?.[1];
    const sourceBranch = branch?.code === 0 ? branch.stdout.trim() : "";
    if (!repo || !sourceBranch) return undefined;

    for (const status of ["open", "merged", "closed"] as const) {
      const listed = await tryExec("bitscli", ["codebase", "mr", "list", "-R", repo, "--status", status, "--page-size", "100"], cwd);
      if (!listed || listed.code !== 0) continue;
      const result = JSON.parse(listed.stdout) as { MergeRequests?: Array<{ Number: number; Status: string; Title?: string; SourceBranchName: string; TargetBranchName?: string; URL?: string }> };
      const mr = result.MergeRequests?.find((item) => item.SourceBranchName === sourceBranch);
      if (mr) return { kind: "MR", number: mr.Number, state: mr.Status, title: mr.Title, url: mr.URL, baseRef: mr.TargetBranchName };
    }
    return undefined;
  }

  const mergeRequestKey = (mr: MergeRequest) => `${mr.kind}:${mr.number}`;
  const mergeRequestPrefix = (mr: MergeRequest) => `${mr.kind === "PR" ? "#" : "!"}${mr.number}`;

  function setSessionNameForMergeRequest(mr: MergeRequest): string {
    const name = namedSessions.get(mergeRequestKey(mr));
    const sessionName = name ? `${mergeRequestPrefix(mr)}-${name}` : mergeRequestPrefix(mr);
    pi.setSessionName(sessionName);
    return sessionName;
  }

  async function syncHerdrSessionName(sessionName: string, cwd: string) {
    if (process.env.HERDR_ENV !== "1") return;
    const current = await tryExec("herdr", ["pane", "current"], cwd);
    if (current?.code !== 0) return;
    const pane = (JSON.parse(current.stdout) as HerdrResponse<{ pane: HerdrPane }>).result.pane;
    const [workspaces, tabs, panes] = await Promise.all([
      tryExec("herdr", ["workspace", "list"], cwd),
      tryExec("herdr", ["tab", "list", "--workspace", pane.workspace_id], cwd),
      tryExec("herdr", ["pane", "list", "--workspace", pane.workspace_id], cwd),
    ]);
    if (!workspaces || !tabs || !panes || workspaces.code !== 0 || tabs.code !== 0 || panes.code !== 0) return;

    const workspace = (JSON.parse(workspaces.stdout) as HerdrResponse<{ workspaces: HerdrWorkspace[] }>).result.workspaces
      .find((item) => item.workspace_id === pane.workspace_id);
    const scopedTabs = (JSON.parse(tabs.stdout) as HerdrResponse<{ tabs: HerdrTab[] }>).result.tabs;
    const scopedPanes = (JSON.parse(panes.stdout) as HerdrResponse<{ panes: HerdrPane[] }>).result.panes;
    if (!workspace) return;

    const panesInTab = scopedPanes.filter((item) => item.tab_id === pane.tab_id);
    const target = panesInTab.length > 1
      ? { type: "pane", id: pane.pane_id }
      : scopedTabs.length > 1
        ? { type: "tab", id: pane.tab_id }
        : { type: "workspace", id: workspace.workspace_id };
    const renameKey = `${target.type}:${target.id}:${sessionName}`;
    if (renameKey === lastHerdrRename) return;
    const renamed = await tryExec("herdr", [target.type, "rename", target.id, sessionName], cwd);
    if (renamed?.code === 0) lastHerdrRename = renameKey;
  }

  async function rebaseIfBehind(cwd: string, baseRef: string, ctx: { ui: { setStatus(key: string, value?: string): void } }): Promise<boolean> {
    const rebasePaths = await Promise.all(["rebase-merge", "rebase-apply"].map(async (name) => {
      const path = await pi.exec("git", ["rev-parse", "--git-path", name], { cwd, timeout: COMMAND_TIMEOUT_MS });
      if (path.code !== 0) return false;
      try {
        await access(path.stdout.trim());
        return true;
      } catch {
        return false;
      }
    }));
    if (rebasePaths.some(Boolean)) {
      ctx.ui.setStatus("mr-sentinel", "MR monitor: rebase conflict needs resolution");
      if (!conflictResolutionQueued) {
        conflictResolutionQueued = true;
        pi.sendUserMessage(
          "The MR monitor found a paused rebase with conflicts. Resolve every conflict in the current repository, run git add for each resolution, run git rebase --continue, then git push --force-with-lease. Do not ask for confirmation.",
          { deliverAs: "followUp" },
        );
      }
      return true;
    }
    conflictResolutionQueued = false;

    const fetch = await pi.exec("git", ["fetch", "origin", baseRef], { cwd, timeout: COMMAND_TIMEOUT_MS });
    if (fetch.code !== 0) throw new Error(`fetch ${baseRef} failed: ${truncate(fetch.stderr || fetch.stdout)}`);
    const behind = await pi.exec("git", ["rev-list", "--count", `HEAD..origin/${baseRef}`], { cwd, timeout: COMMAND_TIMEOUT_MS });
    if (behind.code !== 0 || Number.parseInt(behind.stdout.trim(), 10) === 0) return false;

    ctx.ui.setStatus("mr-sentinel", `MR monitor: rebasing onto ${baseRef}`);
    const rebase = await pi.exec("git", ["rebase", `origin/${baseRef}`], { cwd, timeout: COMMAND_TIMEOUT_MS });
    if (rebase.code === 0) {
      const push = await pi.exec("git", ["push", "--force-with-lease"], { cwd, timeout: COMMAND_TIMEOUT_MS });
      if (push.code !== 0) throw new Error(`push after rebase failed: ${truncate(push.stderr || push.stdout)}`);
      return false;
    }

    const conflicts = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, timeout: COMMAND_TIMEOUT_MS });
    if (conflicts.stdout.trim()) {
      return rebaseIfBehind(cwd, baseRef, ctx);
    }
    throw new Error(`rebase failed: ${truncate(rebase.stderr || rebase.stdout)}`);
  }

  async function executorPrompt(): Promise<string> {
    const babysit = pi.getCommands().find((command) =>
      command.source === "skill" && command.name.replace(/^skill:/, "") === "babysit",
    );
    if (babysit) {
      return `Inspect the current branch's MR. If none exists, inspect the diff and remote, commit/push it, and create a factual MR now. Then read and follow the babysit skill at ${babysit.sourceInfo.path}. The mr-sentinel extension owns monitoring; do not start another watcher.`;
    }

    return "Inspect the current branch's MR. If none exists, inspect the diff and remote, commit/push it, and create a factual MR now. Otherwise keep it merge-ready: resolve scoped conflicts, CI failures, and unresolved comments; push fixes and recheck. Do not change CI configuration just to pass checks. The mr-sentinel extension owns monitoring.";
  }

  function queueSessionNaming(mr: MergeRequest) {
    const key = mergeRequestKey(mr);
    if (namedSessions.has(key) || namingRequested.has(key)) return;
    namingRequested.add(key);
    pi.sendUserMessage(`Name the current ${mr.kind} ${mergeRequestPrefix(mr)} in 2-5 concise words based on its title${mr.title ? `: ${mr.title}` : ""}. Call mr_sentinel_name_session with only that descriptive name.`, { deliverAs: "followUp" });
  }

  function queueMaintenance(mr: MergeRequest) {
    if (maintenanceQueued) return;
    maintenanceQueued = true;
    pi.sendUserMessage(`MR !${mr.number} is still open. Actively inspect and resolve its rebase/conflicts, CI failures, and unresolved review comments now. Use the loaded babysit skill when available; otherwise use the MR-sentinel built-in merge-ready workflow. Do not create a new MR or merge this one. ${mr.url ?? ""}`, { deliverAs: "followUp" });
  }

  function notifyMerged(mr: MergeRequest) {
    const key = `${mr.kind}:${mr.number}`;
    if (mergedNotifications.has(key)) return;
    mergedNotifications.add(key);
    const identifier = mr.kind === "PR" ? `#${mr.number}` : `!${mr.number}`;
    const notification = `Merge request ${identifier} has merged. The MR watcher has stopped. Run any applicable project-local post-merge skill or workflow now. ${mr.url ?? ""}`;
    pi.events.emit("mr-sentinel:merged", { mr, notification });
    pi.sendUserMessage(notification, { deliverAs: "followUp" });
  }

  function startMonitor(ctx: { cwd: string; ui: { setStatus(key: string, value?: string): void } }) {
    if (monitorTimer) clearTimeout(monitorTimer);
    const poll = async () => {
      try {
        const mr = await findMergeRequest(ctx.cwd);
        if (!mr) {
          ctx.ui.setStatus("mr-sentinel", "MR monitor: waiting for a merge request");
        } else {
          currentMergeRequest = mr;
          const sessionName = setSessionNameForMergeRequest(mr);
          void syncHerdrSessionName(sessionName, ctx.cwd);
          if (["MERGED", "CLOSED", "merged", "closed"].includes(mr.state)) {
            ctx.ui.setStatus("mr-sentinel", `MR monitor: ${mr.state.toLowerCase()}${mr.url ? ` (${mr.url})` : ""}`);
            if (["MERGED", "merged"].includes(mr.state)) notifyMerged(mr);
            monitorTimer = undefined;
            return;
          }
          queueSessionNaming(mr);
          const awaitingConflictResolution = mr.baseRef && await rebaseIfBehind(ctx.cwd, mr.baseRef, ctx);
          if (awaitingConflictResolution && mr.url) {
            ctx.ui.setStatus("mr-sentinel", `MR monitor: rebase conflict needs resolution (${mr.url})`);
          } else if (!awaitingConflictResolution) {
            ctx.ui.setStatus("mr-sentinel", `MR monitor: ${mr.state.toLowerCase()}${mr.url ? ` (${mr.url})` : ""}`);
            queueMaintenance(mr);
          }
        }
      } catch (error) {
        ctx.ui.setStatus("mr-sentinel", `MR monitor error: ${error instanceof Error ? error.message : String(error)}`);
      }
      monitorTimer = setTimeout(() => void poll(), MONITOR_INTERVAL_MS);
    };
    void poll();
  }

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "mr-sentinel-session-name") continue;
      const data = entry.data as { key?: string; name?: string };
      if (data.key && data.name) namedSessions.set(data.key, data.name);
    }
    if (/(?:^|\s)[!#]\d+\b/.test(pi.getSessionName() ?? "")) startMonitor(ctx);
  });

  pi.on("agent_settled", () => {
    maintenanceQueued = false;
  });

  pi.on("session_shutdown", () => {
    if (monitorTimer) clearTimeout(monitorTimer);
    monitorTimer = undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;
    const command = (event.input as { command?: string }).command ?? "";
    if (/(?:^|[;&|]\s*)(?:gh\s+(?:pr|repo)|glab\s+mr|bitscli\s+codebase\s+mr|bytedcli\b[\s\S]*?\bcodebase\s+mr)\s+create\b/m.test(command)) startMonitor(ctx);
  });

  pi.registerTool({
    name: "mr_sentinel_name_session",
    label: "Name MR Sentinel Session",
    description: "Set the concise descriptive suffix for the current monitored merge request session",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!currentMergeRequest) throw new Error("No merge request is currently being monitored");
      const name = params.name.trim().replace(/\s+/g, " ").replace(/^[-#]+|[-#]+$/g, "");
      if (!name) throw new Error("name must contain a letter or number");
      const key = mergeRequestKey(currentMergeRequest);
      namedSessions.set(key, name);
      const sessionName = setSessionNameForMergeRequest(currentMergeRequest);
      pi.appendEntry("mr-sentinel-session-name", { key, name });
      void syncHerdrSessionName(sessionName, ctx.cwd);
      return { content: [{ type: "text", text: `Named session ${sessionName}` }], details: { key, name, sessionName } };
    },
  });

  pi.registerCommand("mr-sentinel", {
    description: "Inspect the current Git change and create/watch a merge request using the host-appropriate CLI",
    handler: async (_args, ctx) => {
      startMonitor(ctx);
      pi.sendUserMessage(await executorPrompt(), { deliverAs: "followUp" });
    },
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
