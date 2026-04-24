import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { inferOpenAiCompatibleBiller, redactHomePathUserSegments } from "@paperclipai/adapter-utils";
import { asString, asNumber, asBoolean, parseObject, readPaperclipRuntimeSkillEntries, resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { readFile } from "node:fs/promises";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeStepLimitResult,
} from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi } from "./k8s-client.js";
import { buildJobManifest } from "./job-manifest.js";
import type * as k8s from "@kubernetes/client-node";
import { Writable } from "node:stream";

const POLL_INTERVAL_MS = 2000;
const LOG_EXIT_COMPLETION_GRACE_MS = parseInt(process.env.LOG_EXIT_COMPLETION_GRACE_MS ?? "30000", 10);

export function isK8s404(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const asAny = err as unknown as Record<string, unknown>;
  if (typeof asAny.statusCode === "number" && asAny.statusCode === 404) return true;
  const resp = asAny.response as Record<string, unknown> | undefined;
  if (typeof resp?.statusCode === "number" && resp.statusCode === 404) return true;
  return false;
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

async function waitForPod(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  const deadline = Date.now() + timeoutMs;
  const labelSelector = `job-name=${jobName}`;

  await onLog("stdout", `[paperclip] Waiting for pod to be scheduled (job: ${jobName})...\n`);

  let lastStatus = "";
  while (Date.now() < deadline) {
    const podList = await coreApi.listNamespacedPod({
      namespace,
      labelSelector,
    });
    const pod = podList.items[0];

    if (!pod) {
      if (lastStatus !== "no-pod") {
        await onLog("stdout", `[paperclip] Waiting for Job controller to create pod...\n`);
        lastStatus = "no-pod";
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    const podName = pod.metadata?.name ?? "unknown";
    const phase = pod.status?.phase ?? "Unknown";
    const initStatuses = pod.status?.initContainerStatuses ?? [];
    const containerStatuses = pod.status?.containerStatuses ?? [];

    const statusKey = `${phase}:${initStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.terminated?.reason ?? "ok").join(",")}:${containerStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.running ? "running" : "waiting").join(",")}`;
    if (statusKey !== lastStatus) {
      const details: string[] = [`phase=${phase}`];
      for (const init of initStatuses) {
        if (init.state?.waiting) details.push(`init/${init.name}: waiting (${init.state.waiting.reason ?? "unknown"})`);
        else if (init.state?.running) details.push(`init/${init.name}: running`);
        else if (init.state?.terminated) details.push(`init/${init.name}: done (exit ${init.state.terminated.exitCode})`);
      }
      for (const cs of containerStatuses) {
        if (cs.state?.waiting) details.push(`${cs.name}: waiting (${cs.state.waiting.reason ?? "unknown"})`);
        else if (cs.state?.running) details.push(`${cs.name}: running`);
      }
      await onLog("stdout", `[paperclip] Pod ${podName}: ${details.join(", ")}\n`);
      lastStatus = statusKey;
    }

    if (phase === "Running" || phase === "Succeeded" || phase === "Failed") {
      return podName;
    }

    const allInitsDone = initStatuses.length > 0 && initStatuses.every(
      (s) => s.state?.terminated?.exitCode === 0,
    );
    const mainRunning = containerStatuses.some((s) => s.state?.running);
    if (allInitsDone && mainRunning) {
      return podName;
    }

    for (const init of initStatuses) {
      const terminated = init.state?.terminated;
      if (terminated && (terminated.exitCode ?? 0) !== 0) {
        throw new Error(`Init container "${init.name}" failed with exit code ${terminated.exitCode}: ${terminated.reason ?? terminated.message ?? "unknown"}`);
      }
      const waiting = init.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Init container "${init.name}" image pull failed: ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Init container "${init.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
    }

    const conditions = pod.status?.conditions ?? [];
    const unschedulable = conditions.find(
      (c) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable",
    );
    if (unschedulable) {
      throw new Error(`Pod unschedulable: ${unschedulable.message ?? "insufficient resources"}`);
    }

    for (const cs of containerStatuses) {
      const waiting = cs.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Image pull failed for "${cs.name}": ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Container "${cs.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for pod to be scheduled (${Math.round(timeoutMs / 1000)}s)`);
}

async function streamPodLogs(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<string> {
  const logApi = getLogApi(kubeconfigPath);
  const parts: string[] = [];
  let lineBuffer = "";

  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const incoming = lineBuffer + chunk.toString("utf-8");
      const nlIdx = incoming.lastIndexOf("\n");
      if (nlIdx === -1) {
        // No complete line yet — buffer until newline arrives
        lineBuffer = incoming;
        callback();
        return;
      }
      lineBuffer = incoming.slice(nlIdx + 1);
      // Redact each complete line individually to avoid path splits across chunk boundaries
      const redacted = incoming
        .slice(0, nlIdx + 1)
        .split("\n")
        .map((line) => redactHomePathUserSegments(line))
        .join("\n");
      parts.push(redacted);
      void onLog("stdout", redacted).then(() => callback(), callback);
    },
  });

  try {
    await logApi.log(namespace, podName, "opencode", writable, {
      follow: true,
      pretty: false,
    });
  } catch {
    // follow may fail if the container already exited
  }

  // Flush any partial line that never received a trailing newline
  if (lineBuffer) {
    const redacted = redactHomePathUserSegments(lineBuffer);
    parts.push(redacted);
    await onLog("stdout", redacted);
  }

  return parts.join("");
}

async function readPodLogs(
  namespace: string,
  podName: string,
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  try {
    const log = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace,
      container: "opencode",
    });
    return typeof log === "string" ? log : "";
  } catch {
    return "";
  }
}

type JobCompletionResult = { succeeded: boolean; timedOut: boolean; jobGone: boolean };

async function waitForJobCompletion(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  kubeconfigPath?: string,
): Promise<JobCompletionResult> {
  const batchApi = getBatchApi(kubeconfigPath);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  while (deadline === 0 || Date.now() < deadline) {
    let job: Awaited<ReturnType<typeof batchApi.readNamespacedJob>>;
    try {
      job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    } catch (err) {
      if (isK8s404(err)) return { succeeded: false, timedOut: false, jobGone: true };
      throw err;
    }
    const conditions = job.status?.conditions ?? [];

    const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
    if (complete) return { succeeded: true, timedOut: false, jobGone: false };

    const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
    if (failed) {
      const isDeadlineExceeded = failed.reason === "DeadlineExceeded";
      return { succeeded: false, timedOut: isDeadlineExceeded, jobGone: false };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { succeeded: false, timedOut: true, jobGone: false };
}

export async function completionWithGrace(
  completionPromise: Promise<JobCompletionResult>,
  graceMs: number,
): Promise<JobCompletionResult> {
  const graceExpired = new Promise<JobCompletionResult>(
    (resolve) => setTimeout(() => resolve({ succeeded: false, timedOut: true, jobGone: false }), graceMs),
  );
  try {
    return await Promise.race([completionPromise, graceExpired]);
  } catch {
    return { succeeded: false, timedOut: true, jobGone: false };
  }
}

async function getPodTerminatedInfo(
  namespace: string,
  jobName: string,
  kubeconfigPath?: string,
): Promise<{ exitCode: number | null; reason: string | null }> {
  const coreApi = getCoreApi(kubeconfigPath);
  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod) return { exitCode: null, reason: null };
  const containerStatus = pod.status?.containerStatuses?.find((s) => s.name === "opencode");
  const terminated = containerStatus?.state?.terminated;
  return {
    exitCode: terminated?.exitCode ?? null,
    reason: terminated?.reason ?? terminated?.message ?? null,
  };
}

async function cleanupJob(
  namespace: string,
  jobName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<void> {
  try {
    const batchApi = getBatchApi(kubeconfigPath);
    await batchApi.deleteNamespacedJob({
      name: jobName,
      namespace,
      body: { propagationPolicy: "Background" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: failed to cleanup job ${jobName}: ${msg}\n`);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, runtime, config: rawConfig, onLog, onMeta } = ctx;
  const config = parseObject(rawConfig);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 60);
  const retainJobs = asBoolean(config.retainJobs, false);
  const kubeconfigPath = asString(config.kubeconfig, "") || undefined;
  const model = asString(config.model, "").trim();

  // Guard: single concurrency per agent (shared PVC/session)
  const agentId = ctx.agent.id;
  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
  try {
    const batchApi = getBatchApi(kubeconfigPath);
    const existing = await batchApi.listNamespacedJob({
      namespace: guardNamespace,
      labelSelector: `paperclip.io/agent-id=${agentId},paperclip.io/adapter-type=opencode_k8s`,
    });
    const running = existing.items.filter(
      (j) => !j.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True"),
    );
    if (running.length > 0) {
      const names = running.map((j) => j.metadata?.name).join(", ");
      await onLog("stderr", `[paperclip] Concurrent run blocked: existing Job(s) still running for this agent: ${names}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Concurrent run blocked: Job ${names} is still running for this agent`,
        errorCode: "k8s_concurrent_run_blocked",
      };
    }
  } catch {
    // If we can't check, proceed — heartbeat service enforces concurrency too
  }

  // Read agent instructions file (instructionsFilePath config field → system prompt prepend)
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsContent = "";
  if (instructionsFilePath) {
    try {
      instructionsContent = (await readFile(instructionsFilePath, "utf-8")).trim();
    } catch {
      await onLog("stderr", `[paperclip] Warning: instructionsFilePath not readable: ${instructionsFilePath}\n`);
    }
  }

  // Resolve and read desired skill content (injected into prompt bundle)
  let skillsBundleContent = "";
  try {
    const moduleDir = import.meta.dirname;
    const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
    const desiredSkillKeys = resolvePaperclipDesiredSkillNames(config, availableEntries);
    const skillTexts: string[] = [];
    for (const key of desiredSkillKeys) {
      const entry = availableEntries.find((e) => e.key === key);
      if (entry?.source) {
        try {
          const text = (await readFile(entry.source, "utf-8")).trim();
          if (text) skillTexts.push(text);
        } catch {
          // skip unreadable skill files — non-fatal
        }
      }
    }
    if (skillTexts.length > 0) skillsBundleContent = skillTexts.join("\n\n---\n\n");
  } catch {
    // non-fatal: skill bundle is optional
  }

  const { job, jobName, namespace, prompt, opencodeArgs, promptMetrics } = buildJobManifest({
    ctx,
    selfPod,
    instructionsContent: instructionsContent || undefined,
    skillsBundleContent: skillsBundleContent || undefined,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "opencode_k8s",
      command: `kubectl job/${jobName}`,
      cwd: namespace,
      commandArgs: opencodeArgs,
      commandNotes: [
        `Image: ${job.spec?.template.spec?.containers[0]?.image ?? "unknown"}`,
        `Namespace: ${namespace}`,
        `Timeout: ${timeoutSec}s`,
      ],
      prompt,
      ...(promptMetrics ? { promptMetrics } : {}),
      context: ctx.context,
    } as Parameters<typeof onMeta>[0]);
  }

  const batchApi = getBatchApi(kubeconfigPath);
  try {
    await batchApi.createNamespacedJob({ namespace, body: job });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Failed to create K8s Job: ${msg}\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to create Kubernetes Job: ${msg}`,
      errorCode: "k8s_job_create_failed",
    };
  }

  await onLog("stdout", `[paperclip] Created K8s Job: ${jobName} in namespace ${namespace} (deadline: ${timeoutSec > 0 ? `${timeoutSec}s` : "none"})\n`);

  let stdout = "";
  let exitCode: number | null = null;
  let jobTimedOut = false;
  let podTerminatedReason: string | null = null;

  try {
    const scheduleTimeoutMs = 120_000;
    let podName: string;
    try {
      podName = await waitForPod(namespace, jobName, scheduleTimeoutMs, onLog, kubeconfigPath);
      await onLog("stdout", `[paperclip] Pod running: ${podName}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Pod scheduling failed: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Pod scheduling failed: ${msg}`,
        errorCode: "k8s_pod_schedule_failed",
      };
    }

    const completionTimeoutMs = timeoutSec > 0 ? (timeoutSec + graceSec) * 1000 : 0;

    // Start completion poller in parallel with log streaming
    const completionPromise = waitForJobCompletion(namespace, jobName, completionTimeoutMs, kubeconfigPath);

    stdout = await streamPodLogs(namespace, podName, onLog, kubeconfigPath);

    if (!stdout.trim()) {
      await onLog("stdout", `[paperclip] Log stream returned empty — reading pod logs directly...\n`);
      stdout = await readPodLogs(namespace, podName, kubeconfigPath);
      if (stdout.trim()) {
        await onLog("stdout", stdout);
      }
    } else if (!parseOpenCodeJsonl(stdout).sessionId) {
      // Stdout is non-empty but missing a valid session result — try one-shot fallback
      await onLog("stdout", `[paperclip] Partial stdout missing session result — reading pod logs directly...\n`);
      const fallbackLogs = await readPodLogs(namespace, podName, kubeconfigPath);
      if (fallbackLogs.trim()) {
        stdout = fallbackLogs;
        await onLog("stdout", fallbackLogs);
      }
    }

    // After log stream exits, wait at most LOG_EXIT_COMPLETION_GRACE_MS for the job
    // condition to settle — avoids racing TTL cleanup vs condition update lag
    const completion = await completionWithGrace(completionPromise, LOG_EXIT_COMPLETION_GRACE_MS);
    jobTimedOut = completion.timedOut;

    if (completion.jobGone) {
      await onLog("stdout", `[paperclip] Job ${jobName} not found (likely TTL-cleaned after completion).\n`);
    }

    const terminatedInfo = await getPodTerminatedInfo(namespace, jobName, kubeconfigPath);
    exitCode = terminatedInfo.exitCode;
    podTerminatedReason = terminatedInfo.reason;
  } finally {
    if (!retainJobs) {
      await cleanupJob(namespace, jobName, onLog, kubeconfigPath);
    } else {
      await onLog("stdout", `[paperclip] Retaining job ${jobName} for debugging (retainJobs=true)\n`);
    }
  }

  if (jobTimedOut) {
    return {
      exitCode,
      signal: null,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  // Parse OpenCode JSONL output
  const parsed = parseOpenCodeJsonl(stdout);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const fallbackSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const workspaceContext = parseObject(ctx.context.paperclipWorkspace);
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const cwd = asString(workspaceContext.cwd, "");

  const resolvedSessionId = parsed.sessionId ?? (fallbackSessionId || null);
  const resolvedSessionParams = resolvedSessionId
    ? {
        sessionId: resolvedSessionId,
        ...(cwd ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>
    : null;

  const provider = parseModelProvider(model);
  const biller = inferOpenAiCompatibleBiller(process.env, null) ?? provider ?? "unknown";

  const parsedError = typeof parsed.errorMessage === "string" ? parsed.errorMessage.trim() : "";
  const rawExitCode = exitCode;
  const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
  const failed = (synthesizedExitCode ?? 0) !== 0;

  // If the session was stale, clear it so the next heartbeat starts fresh
  if (failed && isOpenCodeUnknownSessionError(stdout, parsedError)) {
    await onLog("stdout", `[paperclip] OpenCode session is unavailable; clearing for next run.\n`);
    return {
      exitCode: synthesizedExitCode,
      signal: null,
      timedOut: false,
      errorMessage: parsedError || "Session unavailable",
      errorCode: "session_unavailable",
      clearSession: true,
      resultJson: { stdout },
    };
  }

  // If OpenCode hit its step limit, clear the session so the next run starts fresh
  // rather than resuming into an already-exhausted turn sequence.
  const stepLimitReached = isOpenCodeStepLimitResult(stdout);
  if (stepLimitReached) {
    await onLog("stdout", `[paperclip] OpenCode step limit reached; clearing session for next run.\n`);
  }

  // Detect empty LLM response: session started but LLM returned no tokens or messages
  const hasLlmOutput = parsed.usage.outputTokens > 0 || !!parsed.summary;
  if (!jobTimedOut && parsed.sessionId !== null && !hasLlmOutput && !parsedError) {
    await onLog("stderr", `[paperclip] LLM returned empty response (0 output tokens).\n`);
    return {
      exitCode: synthesizedExitCode ?? 1,
      signal: null,
      timedOut: false,
      errorMessage: "LLM API returned empty response",
      errorCode: "llm_api_error",
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      resultJson: { stdout },
    };
  }

  const firstStderrLine = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const podFailureDescription = podTerminatedReason
    ? `Pod exited: ${podTerminatedReason}${synthesizedExitCode != null ? ` (exit ${synthesizedExitCode})` : ""}`
    : null;
  const fallbackErrorMessage =
    parsedError || podFailureDescription || firstStderrLine || `OpenCode exited with code ${synthesizedExitCode ?? -1}`;

  return {
    exitCode: synthesizedExitCode,
    signal: null,
    timedOut: false,
    errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
    usage: {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cachedInputTokens: parsed.usage.cachedInputTokens,
    },
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider,
    model: model || null,
    billingType: "unknown",
    costUsd: parsed.costUsd,
    resultJson: { stdout },
    summary: parsed.summary,
    clearSession: stepLimitReached,
  } as AdapterExecutionResult;
}
