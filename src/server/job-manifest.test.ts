import { describe, it, expect } from "vitest";
import { buildJobManifest, type JobBuildInput } from "./job-manifest.js";

const mockSelfPod: JobBuildInput["selfPod"] = {
  namespace: "paperclip",
  image: "paperclip/paperclip:latest",
  imagePullSecrets: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
  pvcClaimName: null,
  dnsConfig: undefined,
  secretVolumes: [],
};

const mockCtx: JobBuildInput["ctx"] = {
  runId: "run123456",
  agent: { id: "agent-abc", name: "Test Agent", companyId: "co123", adapterType: null, adapterConfig: null },
  runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: null },
  config: {},
  context: {
    taskId: null,
    issueId: null,
    paperclipWorkspace: null,
    issueIds: null,
    paperclipWorkspaces: null,
    paperclipRuntimeServiceIntents: null,
    paperclipRuntimeServices: null,
  },
  onLog: async () => {},
};

describe("buildJobManifest", () => {
  it("creates job with agent-opencode- prefix in name", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.jobName).toMatch(/^agent-opencode-/);
  });

  it("uses default image from selfPod", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe("paperclip/paperclip:latest");
  });

  it("sets fsGroupChangePolicy to OnRootMismatch", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const securityContext = result.job.spec?.template?.spec?.securityContext;
    expect(securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });

  it("sets runAsNonRoot and runAsUser 1000", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const securityContext = result.job.spec?.template?.spec?.securityContext;
    expect(securityContext?.runAsNonRoot).toBe(true);
    expect(securityContext?.runAsUser).toBe(1000);
    expect(securityContext?.runAsGroup).toBe(1000);
    expect(securityContext?.fsGroup).toBe(1000);
  });

  it("maps labels to job metadata", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("paperclip");
    expect(result.job.metadata?.labels?.["paperclip.io/adapter-type"]).toBe("opencode_k8s");
    expect(result.job.metadata?.labels?.["paperclip.io/agent-id"]).toBe("agent-abc");
    expect(result.job.metadata?.labels?.["paperclip.io/run-id"]).toBe("run123456");
  });

  it("creates init container for prompt", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const initContainers = result.job.spec?.template?.spec?.initContainers;
    expect(initContainers?.length).toBe(1);
    expect(initContainers?.[0].name).toBe("write-prompt");
    expect(initContainers?.[0].image).toBe("busybox:1.36");
  });

  it("sets HOME to /paperclip", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const homeEnv = env.find((e) => e.name === "HOME");
    expect(homeEnv?.value).toBe("/paperclip");
  });

  it("sets OPENCODE_DISABLE_PROJECT_CONFIG=true", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const opencodeEnv = env.find((e) => e.name === "OPENCODE_DISABLE_PROJECT_CONFIG");
    expect(opencodeEnv?.value).toBe("true");
  });

  it("applies default ttlSecondsAfterFinished of 300", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.ttlSecondsAfterFinished).toBe(300);
  });

  it("sets backoffLimit to 0", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.backoffLimit).toBe(0);
  });

  it("uses job template restartPolicy Never", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.restartPolicy).toBe("Never");
  });

  it("applies nodeSelector from key=value textarea string", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: "kubernetes.io/arch=amd64\nkubernetes.io/os=linux" } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({
      "kubernetes.io/arch": "amd64",
      "kubernetes.io/os": "linux",
    });
  });

  it("applies nodeSelector from JSON object string", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: '{"node-type":"gpu"}' } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ "node-type": "gpu" });
  });

  it("applies nodeSelector from plain object config", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: { "zone": "us-east-1" } } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ zone: "us-east-1" });
  });

  it("ignores blank lines and comments in nodeSelector textarea", () => {
    const ctx = {
      ...mockCtx,
      config: { nodeSelector: "# comment\n\nkubernetes.io/arch=amd64\n" },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64" });
  });

  it("forwards inheritedEnvValueFrom entries onto the opencode container env", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnvValueFrom: [
        { name: "MY_SECRET", valueFrom: { secretKeyRef: { name: "my-secret", key: "token" } } },
      ],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const secretEnv = env.find((e) => e.name === "MY_SECRET");
    expect(secretEnv?.valueFrom?.secretKeyRef?.name).toBe("my-secret");
    expect(secretEnv?.valueFrom?.secretKeyRef?.key).toBe("token");
  });

  it("does not duplicate an inheritedEnvValueFrom entry if the name is already set as a literal", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnv: { HOME: "/custom" },
      inheritedEnvValueFrom: [
        { name: "HOME", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
      ],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const homeEntries = env.filter((e) => e.name === "HOME");
    // HOME is overridden by merged (HOME=/paperclip hardcoded last), so valueFrom must not appear
    expect(homeEntries.every((e) => e.value !== undefined)).toBe(true);
  });

  it("forwards inheritedEnvFrom onto the opencode container envFrom", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnvFrom: [{ secretRef: { name: "my-config-secret" } }],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.envFrom).toEqual([{ secretRef: { name: "my-config-secret" } }]);
  });

  it("omits envFrom when inheritedEnvFrom is empty", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.envFrom).toBeUndefined();
  });
});
