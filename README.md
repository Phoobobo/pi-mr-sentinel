# MR Sentinel for Pi

`pi-mr-sentinel` is a host-neutral Pi package for preparing merge requests and preserving browser acceptance evidence. It works from the current Git remote rather than a repository-specific integration.

## Install

```bash
pi install npm:pi-mr-sentinel
```

Install from the source repository:

```bash
pi install git:github.com/Phoobobo/pi-mr-sentinel
```

For local development:

```bash
pi install "$HOME/.pi/agent/packages/pi-mr-sentinel"
```

Restart Pi or run `/reload` after installation.

## Interface

- `/mr-sentinel` inspects Git status, diff, and remote; then selects a suitable already-installed client for the hosting platform. It prefers `gh` for GitHub and discovers another client for other remotes. If a loaded `babysit` skill is available, it uses that skill as its MR executor; otherwise it uses its built-in merge-ready workflow. While Pi remains open, it polls an existing or newly created GitHub/GitLab/Codebase merge request immediately and every five minutes until it is merged or closed. On each open-MR poll, it actively queues handling for CI failures and unresolved comments, rebases the branch onto the MR target branch if behind, pushes the rebase with `--force-with-lease`, and queues the agent to resolve any rebase conflicts. When an MR merges, it emits `mr-sentinel:merged` for other extensions and adds a session message so project-local post-merge skills can respond. It makes one model request to name the session from the MR title, then uses `!<mr-number>-<descriptive-name>` (or `#<pr-number>-<descriptive-name>`). In Herdr, it applies that session name to the current pane when its tab has multiple panes, otherwise to the current tab when its workspace has multiple tabs, otherwise to the workspace.
- `mr_browser_acceptance` performs bounded Playwright CLI actions and preserves a PNG screenshot plus command log.

The command does not install clients, change authentication, or expose credentials. It does not request extension confirmations for Git commits, pushes, merge-request creation, rebases, or force-with-lease pushes.

## Browser configuration

```bash
export PI_MR_SENTINEL_PLAYWRIGHT_CLI=/path/to/playwright-cli
export PI_MR_SENTINEL_EVIDENCE_DIR="$HOME/.pi/agent/mr-sentinel/evidence"
```

Both variables are optional. The CLI defaults to `playwright-cli` on `PATH`; evidence defaults to `~/.pi/agent/mr-sentinel/evidence`.

## Publishing and package managers

The package has no runtime dependencies beyond Pi's bundled extension APIs. It can be published with either npm or pnpm. For pnpm-based Pi package installation, configure Pi's global `npmCommand` as:

```json
{ "npmCommand": ["pnpm"] }
```

Use scope-to-registry routing in `.npmrc` when packages come from more than one registry.

## Check

```bash
npm run check
node --check extensions/index.ts
```
