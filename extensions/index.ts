import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const mergedNotifications = new Set<string>();
  let lastHerdrRename: string | undefined;

  async function tryExec(command: string, args: string[], cwd: string) {
    try {
      return await pi.exec(command, args, { cwd, timeout: COMMAND_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }

  async function findMergeRequest(cwd: string): Promise<MergeRequest | undefined> {
    const gh = await tryExec("gh", ["pr", "view", "--json", "number,state,url,baseRefName"], cwd);
    if (gh?.code === 0) {
      const result = JSON.parse(gh.stdout) as { number: number; state: string; url?: string; baseRefName?: string };
      return { kind: "PR", number: result.number, state: result.state, url: result.url, baseRef: result.baseRefName };
    }

    const glab = await tryExec("glab", ["mr", "view", "--output", "json"], cwd);
    if (glab?.code === 0) {
      const result = JSON.parse(glab.stdout) as { iid: number; state: string; web_url?: string; target_branch?: string };
      return { kind: "MR", number: result.iid, state: result.state, url: result.web_url, baseRef: result.target_branch };
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
      const result = JSON.parse(listed.stdout) as { MergeRequests?: Array<{ Number: number; Status: string; SourceBranchName: string; TargetBranchName?: string; URL?: string }> };
      const mr = result.MergeRequests?.find((item) => item.SourceBranchName === sourceBranch);
      if (mr) return { kind: "MR", number: mr.Number, state: mr.Status, url: mr.URL, baseRef: mr.TargetBranchName };
    }
    return undefined;
  }

  async function setSessionNameForMergeRequest(mr: MergeRequest, cwd: string): Promise<string> {
    const prefix = mr.kind === "PR" ? `#${mr.number}` : `!${mr.number}`;
    const remote = await tryExec("git", ["remote", "get-url", "origin"], cwd);
    const originName = remote?.code === 0
      ? remote.stdout.trim().replace(/\.git$/, "").split(/[/:]/).pop()
      : undefined;
    const sessionName = `${prefix}-${originName || "origin"}`;
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
      try {
        const instructions = await readFile(babysit.sourceInfo.path, "utf8");
        return `Inspect the current branch's merge request first. If none exists, create one now: inspect the relevant diff and remote, generate a concise conventional-commit title and factual Markdown body, push the branch, and create the MR without waiting for optional manual acceptance or unrelated full-suite failures. Once an MR exists, execute it using the available babysit skill below. Follow its instructions as the working mode. The mr-sentinel extension independently watches MR state, so do not implement a separate watcher.\n\n${instructions}`;
      } catch {
        // Fall back to the built-in mode if a discovered skill can no longer be read.
      }
    }

    return "Prepare and keep the current repository's merge request merge-ready. Inspect git status, the relevant diff, and git remote -v first. Select the command-line client appropriate for the remote host: prefer gh for GitHub; for any other host, discover an already-installed suitable client with command -v and --help. Do not install software, alter credentials, expose tokens, or assume a platform-specific client. First check whether this branch already has a merge request. If it does not, generate a concise conventional-commit title and a factual Markdown body without asking me for a title, then commit, push, and create the merge request without asking for confirmation. If an MR exists, resolve clear merge conflicts, valid unresolved comments, and CI failures caused by this branch; push scoped fixes and recheck until it is mergeable, green, and comments are triaged. Do not change CI workflows merely to make checks pass. The extension monitors the merge request after this command starts.";
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
          const sessionName = await setSessionNameForMergeRequest(mr, ctx.cwd);
          void syncHerdrSessionName(sessionName, ctx.cwd);
          if (["MERGED", "CLOSED", "merged", "closed"].includes(mr.state)) {
            ctx.ui.setStatus("mr-sentinel", `MR monitor: ${mr.state.toLowerCase()}`);
            if (["MERGED", "merged"].includes(mr.state)) notifyMerged(mr);
            monitorTimer = undefined;
            return;
          }
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
    if (/(?:^|[;&|]\s*)(?:gh\s+(?:pr|repo)|glab\s+mr|bitscli\s+codebase\s+mr)\s+create\b/m.test(command)) startMonitor(ctx);
  });

  pi.registerCommand("mr-sentinel", {
    description: "Inspect the current Git change and create/watch a merge request using the host-appropriate CLI",
    handler: async (_args, ctx) => {
      startMonitor(ctx);
      pi.sendUserMessage(await executorPrompt());
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
