# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build, Lint, and Test Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run typecheck  # Type-check without emitting
npm test           # Run vitest tests (run mode)
npm run test:watch # Run vitest in watch mode
```

Run a single test file: `npx vitest run src/server/parse.test.ts`

## Architecture

This is a Paperclip adapter plugin that runs OpenCode agents as isolated Kubernetes Job pods. It exposes three entry points:

- `.` → `src/index.ts` — main ServerAdapterModule factory
- `./server` → `src/server/index.ts` — server adapter internals
- `./ui-parser` → `src/ui-parser.ts` — real-time stdout line parser for the Paperclip UI

### Execution Flow (`src/server/execute.ts`)

1. **Concurrency guard** — checks for existing running Jobs for the same agent (shared PVC/session enforcement)
2. **Self-pod introspection** (`getSelfPodInfo`) — queries own pod to inherit image, imagePullSecrets, DNS config, PVC mount, and all env vars from the Deployment
3. **Job manifest build** (`buildJobManifest`) — constructs a K8s Job with:
   - Init container (busybox) that writes the prompt to an emptyDir volume
   - Main opencode container that pipes the prompt via stdin
   - Inherited env vars layered: Deployment env → PAPERCLIP_* vars → user overrides
   - Resource requests/limits, security contexts, tolerations, nodeSelector applied from config
4. **Job creation** — creates the Job in the target namespace
5. **Pod scheduling wait** — polls for the pod to be scheduled, checking init container states and image pull issues
6. **Log streaming + completion wait** — streams pod logs to the Paperclip UI while waiting for Job completion (with configurable timeout)
7. **JSONL parsing** (`parseOpenCodeJsonl`) — extracts session ID, usage tokens, cost, summary, and errors from OpenCode JSONL output
8. **Result synthesis** — returns exit code, usage metrics, session params for resume, and billing type inference

### Key State: SelfPodInfo (`src/server/k8s-client.ts`)

Queried once on first `execute()` call, then cached for all subsequent Job builds in the same process. Contains:
- Namespace, container image, imagePullSecrets, dnsConfig
- PVC claim name mounted at `/paperclip` (for session resume)
- All env vars from the pod spec (forwarded without an allowlist)
- Secret volume mounts (re-mounted into Job pods)

### Session Management (`src/server/session.ts`)

The `sessionCodec` maps between canonical session params (`sessionId`, `cwd`, `workspaceId`, `repoUrl`, `repoRef`) and multiple legacy field names (`session_id`, `workdir`, `folder`, `workspace_id`, `repo_url`, `repo_ref`). Handles deserialization for session resume handoffs.

### UI Parser (`src/ui-parser.ts`)

Zero-dependency stdout line parser for OpenCode JSONL events. Maps raw JSON lines to structured `TranscriptEntry` kinds (`assistant`, `tool_call`, `tool_result`, `result`, `system`, `stderr`, `stdout`) so the Paperclip UI renders rich chat bubbles instead of plain text.

### Environment Health Checks (`src/server/test.ts`)

Validates on startup: K8s API reachability, target namespace existence, RBAC permissions (create/get/delete Jobs, list Pods, get Pod logs), secret presence, and PVC access mode (must be ReadWriteMany for Job pods to share the volume).

## Project Structure

```
src/
  index.ts            — exports createServerAdapter() as default, type = "opencode_k8s"
  ui-parser.ts        — parseStdoutLine() for real-time UI rendering
  cli/
    index.ts          — CLI adapter module (formatStdoutEvent)
    format-event.ts   — console output formatter for CLI mode
  server/
    index.ts          — createServerAdapter() implementation
    execute.ts        — main execute() function (Job lifecycle)
    k8s-client.ts     — KubeConfig cache, BatchV1Api/CoreV1Api/Log factories, self-pod introspection
    job-manifest.ts   — buildJobManifest() (K8s Job manifest builder)
    parse.ts          — parseOpenCodeJsonl(), isOpenCodeUnknownSessionError()
    session.ts        — sessionCodec (serialize/deserialize session params)
    config-schema.ts  — getConfigSchema() (adapter UI config fields)
    test.ts           — testEnvironment() (K8s environment health checks)
    *.test.ts         — vitest unit tests
```
