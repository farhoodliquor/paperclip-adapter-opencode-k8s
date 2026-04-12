import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

function joinPromptSections(sections: string[], separator = "\n\n"): string {
  return sections.filter((s) => s.trim().length > 0).join(separator);
}

function stringifyPaperclipWakePayload(wake: unknown): string | null {
  if (!wake || typeof wake !== "object") return null;
  try {
    const json = JSON.stringify(wake);
    return json === "{}" ? null : json;
  } catch {
    return null;
  }
}

function renderPaperclipWakePrompt(wake: unknown, _opts?: { resumedSession?: boolean }): string {
  if (!wake || typeof wake !== "object") return "";
  const w = wake as Record<string, unknown>;
  const reason = typeof w.reason === "string" ? w.reason.trim() : "";
  const comments = Array.isArray(w.comments) ? w.comments : [];
  if (!reason && comments.length === 0) return "";
  const parts: string[] = [];
  if (reason) parts.push(`Wake reason: ${reason}`);
  for (const c of comments) {
    if (typeof c === "object" && c !== null) {
      const comment = c as Record<string, unknown>;
      const body = typeof comment.body === "string" ? comment.body.trim() : "";
      if (body) parts.push(`Comment: ${body}`);
    }
  }
  return parts.join("\n\n");
}
import type { SelfPodInfo } from "./k8s-client.js";

export interface JobBuildInput {
  ctx: AdapterExecutionContext;
  selfPod: SelfPodInfo;
}

export interface JobBuildResult {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  prompt: string;
  opencodeArgs: string[];
  promptMetrics: Record<string, number>;
}

function sanitizeForK8sName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8);
}

function buildEnvVars(
  ctx: AdapterExecutionContext,
  selfPod: SelfPodInfo,
  config: Record<string, unknown>,
): k8s.V1EnvVar[] {
  const { runId, agent, context } = ctx;
  const envConfig = parseObject(config.env);

  // Layer 1: PAPERCLIP_* base vars
  const paperclipEnv = buildPaperclipEnv(agent);
  paperclipEnv.PAPERCLIP_RUN_ID = runId;

  const setIfPresent = (envKey: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      paperclipEnv[envKey] = value.trim();
    }
  };

  setIfPresent("PAPERCLIP_TASK_ID", context.taskId ?? context.issueId);
  setIfPresent("PAPERCLIP_WAKE_REASON", context.wakeReason);
  setIfPresent("PAPERCLIP_WAKE_COMMENT_ID", context.wakeCommentId ?? context.commentId);
  setIfPresent("PAPERCLIP_APPROVAL_ID", context.approvalId);
  setIfPresent("PAPERCLIP_APPROVAL_STATUS", context.approvalStatus);

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) {
    paperclipEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  setIfPresent("PAPERCLIP_WORKSPACE_CWD", workspaceContext.cwd);
  setIfPresent("PAPERCLIP_WORKSPACE_SOURCE", workspaceContext.source);
  setIfPresent("PAPERCLIP_WORKSPACE_STRATEGY", workspaceContext.strategy);
  setIfPresent("PAPERCLIP_WORKSPACE_ID", workspaceContext.workspaceId);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_URL", workspaceContext.repoUrl);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_REF", workspaceContext.repoRef);
  setIfPresent("PAPERCLIP_WORKSPACE_BRANCH", workspaceContext.branchName);
  setIfPresent("PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspaceContext.worktreePath);
  setIfPresent("AGENT_HOME", workspaceContext.agentHome);

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (Array.isArray(context.paperclipWorkspaces) && context.paperclipWorkspaces.length > 0) {
    paperclipEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(context.paperclipWorkspaces);
  }
  if (Array.isArray(context.paperclipRuntimeServiceIntents) && context.paperclipRuntimeServiceIntents.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(context.paperclipRuntimeServiceIntents);
  }
  if (Array.isArray(context.paperclipRuntimeServices) && context.paperclipRuntimeServices.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(context.paperclipRuntimeServices);
  }
  setIfPresent("PAPERCLIP_RUNTIME_PRIMARY_URL", context.paperclipRuntimePrimaryUrl);

  if (ctx.authToken) {
    paperclipEnv.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // Inherit PAPERCLIP_API_URL from Deployment env (in-cluster service URL)
  if (selfPod.inheritedEnv.PAPERCLIP_API_URL) {
    paperclipEnv.PAPERCLIP_API_URL = selfPod.inheritedEnv.PAPERCLIP_API_URL;
  }

  // Layer 3: Inherited from Deployment (Bedrock, API keys, etc.)
  const merged: Record<string, string> = {
    ...selfPod.inheritedEnv,
    ...paperclipEnv,
  };

  // Layer 4: User-defined overrides from adapterConfig.env
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") merged[key] = value;
  }

  // OpenCode-specific: prevent project config pollution, always set after user overrides
  merged.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  merged.HOME = "/paperclip";

  // Convert to V1EnvVar array
  const envVars: k8s.V1EnvVar[] = Object.entries(merged).map(([name, value]) => ({
    name,
    value,
  }));

  return envVars;
}

/**
 * Build the OpenCode runtime config JSON for permission.external_directory=allow.
 * Returned as a string to be written inside the Job container.
 */
function buildRuntimeConfigJson(config: Record<string, unknown>): string | null {
  const skipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  if (!skipPermissions) return null;
  return JSON.stringify({ permission: { external_directory: "allow" } }, null, 2);
}

export function buildJobManifest(input: JobBuildInput): JobBuildResult {
  const { ctx, selfPod } = input;
  const { runId, agent, runtime, config: rawConfig, context } = ctx;
  const config = parseObject(rawConfig);

  const namespace = asString(config.namespace, "") || selfPod.namespace;
  const image = asString(config.image, "") || selfPod.image;
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();
  const extraArgs = asStringArray(config.extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const ttlSeconds = asNumber(config.ttlSecondsAfterFinished, 300);
  const resources = parseObject(config.resources);
  const nodeSelector = parseObject(config.nodeSelector);
  const tolerations = Array.isArray(config.tolerations) ? config.tolerations : [];
  const extraLabels = parseObject(config.labels);

  // Resolve working directory
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const workingDir = workspaceCwd || configuredCwd || "/paperclip";

  // Job naming
  const agentSlug = sanitizeForK8sName(agent.id);
  const runSlug = sanitizeForK8sName(runId);
  const jobName = `agent-${agentSlug}-${runSlug}`;

  // Build prompt
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !runtimeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(runtimeSessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(runtimeSessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Build opencode CLI args
  const opencodeArgs = ["run", "--format", "json"];
  if (runtimeSessionId) opencodeArgs.push("--session", runtimeSessionId);
  if (model) opencodeArgs.push("--model", model);
  if (variant) opencodeArgs.push("--variant", variant);
  if (extraArgs.length > 0) opencodeArgs.push(...extraArgs);

  // Build env vars
  const envVars = buildEnvVars(ctx, selfPod, config);

  // Runtime config for permissions
  const runtimeConfigJson = buildRuntimeConfigJson(config);

  // Resource defaults
  const resourceRequests = parseObject(resources.requests);
  const resourceLimits = parseObject(resources.limits);
  const containerResources: k8s.V1ResourceRequirements = {
    requests: {
      cpu: asString(resourceRequests.cpu, "1000m"),
      memory: asString(resourceRequests.memory, "2Gi"),
    },
    limits: {
      cpu: asString(resourceLimits.cpu, "4000m"),
      memory: asString(resourceLimits.memory, "8Gi"),
    },
  };

  // Labels
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "paperclip",
    "app.kubernetes.io/component": "agent-job",
    "paperclip.io/agent-id": agent.id,
    "paperclip.io/run-id": runId,
    "paperclip.io/company-id": agent.companyId,
    "paperclip.io/adapter-type": "opencode_k8s",
  };
  for (const [key, value] of Object.entries(extraLabels)) {
    if (typeof value === "string") labels[key] = value;
  }

  // Volumes
  const volumes: k8s.V1Volume[] = [{ name: "prompt", emptyDir: {} }];
  const volumeMounts: k8s.V1VolumeMount[] = [{ name: "prompt", mountPath: "/tmp/prompt" }];

  if (selfPod.pvcClaimName) {
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: selfPod.pvcClaimName },
    });
    volumeMounts.push({ name: "data", mountPath: "/paperclip" });
  }

  // Mount secret volumes inherited from the Deployment pod
  for (const sv of selfPod.secretVolumes) {
    volumes.push({
      name: sv.volumeName,
      secret: { secretName: sv.secretName, defaultMode: sv.defaultMode, optional: true },
    });
    volumeMounts.push({
      name: sv.volumeName,
      mountPath: sv.mountPath,
      readOnly: true,
    });
  }

  const securityContext: k8s.V1SecurityContext = {
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: false,
    runAsNonRoot: true,
    runAsUser: 1000,
    allowPrivilegeEscalation: false,
  };

  const podSecurityContext: k8s.V1PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
  };

  // Build the main container command
  // 1. Optionally write opencode runtime config for permission bypass
  // 2. Pipe prompt into opencode
  const opencodeArgsEscaped = opencodeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const configSetup = runtimeConfigJson
    ? `mkdir -p ~/.config/opencode && echo '${runtimeConfigJson.replace(/'/g, "'\\''")}' > ~/.config/opencode/opencode.json && `
    : "";
  const mainCommand = `${configSetup}cat /tmp/prompt/prompt.txt | opencode ${opencodeArgsEscaped}`;

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels,
      annotations: {
        "paperclip.io/adapter-type": "opencode_k8s",
        "paperclip.io/agent-name": agent.name,
      },
    },
    spec: {
      backoffLimit: 0,
      ...(timeoutSec > 0 ? { activeDeadlineSeconds: timeoutSec } : {}),
      ttlSecondsAfterFinished: ttlSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: asString(config.serviceAccountName, "") || undefined,
          securityContext: podSecurityContext,
          ...(selfPod.imagePullSecrets.length > 0 ? { imagePullSecrets: selfPod.imagePullSecrets } : {}),
          ...(selfPod.dnsConfig ? { dnsConfig: selfPod.dnsConfig } : {}),
          ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector: nodeSelector as Record<string, string> } : {}),
          ...(tolerations.length > 0 ? { tolerations: tolerations as k8s.V1Toleration[] } : {}),
          initContainers: [
            {
              name: "write-prompt",
              image: "busybox:1.36",
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "echo \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt"],
              env: [{ name: "PROMPT_CONTENT", value: prompt }],
              volumeMounts: [{ name: "prompt", mountPath: "/tmp/prompt" }],
              securityContext,
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "100m", memory: "64Mi" },
              },
            },
          ],
          containers: [
            {
              name: "opencode",
              image,
              imagePullPolicy: asString(config.imagePullPolicy, "IfNotPresent"),
              workingDir,
              command: ["sh", "-c", mainCommand],
              env: envVars,
              volumeMounts,
              securityContext,
              resources: containerResources,
            },
          ],
          volumes,
        },
      },
    },
  };

  return { job, jobName, namespace, prompt, opencodeArgs, promptMetrics };
}
