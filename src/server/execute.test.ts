import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi } from "./k8s-client.js";
import { buildJobManifest } from "./job-manifest.js";

vi.mock("./k8s-client.js", () => ({
  getSelfPodInfo: vi.fn(),
  getBatchApi: vi.fn(),
  getCoreApi: vi.fn(),
  getLogApi: vi.fn(),
}));

vi.mock("./job-manifest.js", () => ({
  buildJobManifest: vi.fn(),
  LARGE_PROMPT_THRESHOLD_BYTES: 256 * 1024,
}));

const MOCK_SELF_POD = {
  namespace: "test-ns",
  image: "test-image:latest",
  imagePullSecrets: [],
  dnsConfig: undefined,
  pvcClaimName: null,
  secretVolumes: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
};

const MOCK_JOB = {
  spec: {
    template: {
      spec: {
        containers: [{ image: "test-image:latest" }],
      },
    },
  },
};

const JOB_NAME = "agent-opencode-testjob";
const NAMESPACE = "test-ns";
const POD_NAME = "agent-opencode-testjob-abcde";

const HAPPY_JSONL = [
  JSON.stringify({ type: "text", part: { text: "Task complete" }, sessionID: "ses_happy" }),
  JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50, cache: { read: 20 } }, cost: 0.002 } }),
].join("\n");

function makeCtx(configOverrides: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-123",
    agent: { id: "agent-id-test", name: "Test Agent", companyId: "co-1", adapterType: null, adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: null },
    config: configOverrides,
    context: {
      taskId: null,
      issueId: null,
      paperclipWorkspace: null,
      issueIds: null,
      paperclipWorkspaces: null,
      paperclipRuntimeServiceIntents: null,
      paperclipRuntimeServices: null,
    },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdapterExecutionContext;
}

function makeBatchApi(runningJobItems: unknown[] = []) {
  return {
    listNamespacedJob: vi.fn().mockResolvedValue({ items: runningJobItems }),
    createNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "test-job-uid" } }),
    readNamespacedJob: vi.fn().mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    }),
    deleteNamespacedJob: vi.fn().mockResolvedValue({}),
  };
}

function makeCoreApi(
  jsonl = HAPPY_JSONL,
  exitCode: number | null = 0,
  terminatedReason: string | null = null,
) {
  const exitCodePod =
    exitCode === null
      ? { items: [] }
      : {
          items: [
            {
              status: {
                containerStatuses: [
                  {
                    name: "opencode",
                    state: {
                      terminated: {
                        exitCode,
                        ...(terminatedReason ? { reason: terminatedReason } : {}),
                      },
                    },
                  },
                ],
              },
            },
          ],
        };

  return {
    listNamespacedPod: vi.fn()
      .mockResolvedValueOnce({
        items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
      })
      .mockResolvedValueOnce(exitCodePod),
    readNamespacedPodLog: vi.fn().mockResolvedValue(jsonl),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
  };
}

function makeLogApi() {
  return { log: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getSelfPodInfo).mockResolvedValue(MOCK_SELF_POD as ReturnType<typeof getSelfPodInfo> extends Promise<infer T> ? T : never);
  vi.mocked(buildJobManifest).mockReturnValue({
    job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
    jobName: JOB_NAME,
    namespace: NAMESPACE,
    prompt: "Test prompt",
    opencodeArgs: [],
    promptMetrics: null,
  } as unknown as ReturnType<typeof buildJobManifest>);

  const batchApi = makeBatchApi();
  const coreApi = makeCoreApi();
  const logApi = makeLogApi();

  vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
  vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
  vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);
});

describe("execute — concurrency guard", () => {
  it("blocks when a running job already exists for the agent", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "old-job" },
        status: { conditions: [] }, // no Complete/Failed → still running
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.exitCode).toBeNull();
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("proceeds when existing job has Complete condition", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "finished-job" },
        status: { conditions: [{ type: "Complete", status: "True" }] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it("proceeds when existing job has Failed condition", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "failed-job" },
        status: { conditions: [{ type: "Failed", status: "True" }] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it("proceeds when no running jobs exist", async () => {
    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(getBatchApi)().createNamespacedJob).toHaveBeenCalled();
  });

  it("proceeds when concurrency check throws (best-effort)", async () => {
    const batchApi = makeBatchApi();
    batchApi.listNamespacedJob.mockRejectedValue(new Error("RBAC denied"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    // Should have proceeded to create a job
    expect(batchApi.createNamespacedJob).toHaveBeenCalled();
  });
});

describe("execute — job creation failure", () => {
  it("returns k8s_job_create_failed when createNamespacedJob throws", async () => {
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockRejectedValue(new Error("Namespace not found"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.exitCode).toBeNull();
  });
});

describe("execute — pod scheduling failure", () => {
  it("returns k8s_pod_schedule_failed when init container fails", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              initContainerStatuses: [
                { name: "write-prompt", state: { terminated: { exitCode: 1, reason: "Error" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.exitCode).toBeNull();
  });

  it("returns k8s_pod_schedule_failed when image pull fails", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              containerStatuses: [
                { name: "opencode", state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
  });

  it("returns k8s_pod_schedule_failed when pod is unschedulable", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              conditions: [
                { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes available" },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
  });
});

describe("execute — happy path", () => {
  it("returns success with sessionId and usage metrics", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe("ses_happy");
    expect(result.summary).toBe("Task complete");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cachedInputTokens).toBe(20);
    expect(result.costUsd).toBeCloseTo(0.002);
    expect(result.errorMessage).toBeNull();
    expect(result.clearSession).toBe(false);
  });

  it("cleans up the job after completion", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: JOB_NAME, namespace: NAMESPACE }),
    );
  });

  it("creates job in the correct namespace", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NAMESPACE }),
    );
  });

  it("calls onMeta when provided", async () => {
    const onMeta = vi.fn().mockResolvedValue(undefined);
    const ctx = { ...makeCtx(), onMeta } as unknown as AdapterExecutionContext;

    await execute(ctx);

    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "opencode_k8s" }),
    );
  });
});

describe("execute — session unavailable (reattach classification)", () => {
  it("returns clearSession=true and session_unavailable code for unknown session error", async () => {
    const sessionErrorJsonl = JSON.stringify({ type: "error", error: { message: "unknown session abc" } });
    const coreApi = makeCoreApi(sessionErrorJsonl, 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("session_unavailable");
  });

  it("returns clearSession=true for 'session not found' error", async () => {
    const coreApi = makeCoreApi("session not found\n", 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
  });

  it("does not set clearSession for unrelated errors", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "rate limit exceeded" } }),
      1,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(false);
  });
});

describe("execute — timeout", () => {
  it("returns timedOut=true when job reports DeadlineExceeded", async () => {
    const batchApi = makeBatchApi();
    batchApi.readNamespacedJob.mockResolvedValue({
      status: { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] },
    });
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({ timeoutSec: 300 });
    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });
});

describe("execute — retainJobs config", () => {
  it("does not delete job when retainJobs=true", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({ retainJobs: true });
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("deletes job when retainJobs=false (default)", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).toHaveBeenCalled();
  });
});

describe("execute — exit code handling", () => {
  it("propagates non-zero exit code from pod", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "Task failed" } }),
      2,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toBeTruthy();
  });

  it("synthesizes exitCode=1 when error message exists but pod reported exitCode=0", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "API rate limit" } }),
      0,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // Exit code should be synthesized to 1 because errorMessage is non-empty
    expect(result.exitCode).toBe(1);
  });

  it("handles null exit code gracefully (pod not found — 404 tolerance)", async () => {
    const coreApi = makeCoreApi(HAPPY_JSONL, null);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // null exitCode with no error → synthesized to null (no forced failure)
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});

describe("execute — pod failure classification", () => {
  it("includes pod terminated reason in errorMessage when reason is OOMKilled", async () => {
    // OOMKilled: process is killed by kernel — no JSONL error event, just empty output
    const coreApi = makeCoreApi("", 137, "OOMKilled");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(137);
    expect(result.errorMessage).toContain("OOMKilled");
  });

  it("includes pod terminated reason for Error exit", async () => {
    const coreApi = makeCoreApi("", 1, "Error");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("Error");
    expect(result.errorMessage).toContain("exit 1");
  });

  it("falls back gracefully when no terminated reason is available", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "boom" } }),
      1,
      null,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("execute — partial stdout fallback", () => {
  it("fetches pod logs when stdout has content but no session result", async () => {
    const partialJsonl = JSON.stringify({ type: "text", part: { text: "thinking..." } }); // no sessionID
    const completeJsonl = [
      JSON.stringify({ type: "text", part: { text: "Done" }, sessionID: "ses_complete" }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 30, cache: {} }, cost: 0.001 } }),
    ].join("\n");

    const coreApi = makeCoreApi(completeJsonl, 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    // Make log stream return partial content with no sessionID
    const logApi = {
      log: vi.fn(async (_ns: string, _pod: string, _container: string, writable: NodeJS.WritableStream) => {
        writable.write(Buffer.from(partialJsonl + "\n"));
      }),
    };
    vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // readNamespacedPodLog should have been called as the partial-stdout fallback
    expect(coreApi.readNamespacedPodLog).toHaveBeenCalled();
    // Result should use the complete log with sessionId
    expect(result.sessionId).toBe("ses_complete");
  });

  it("does not call readPodLogs when stdout has a valid session result", async () => {
    const completeJsonl = [
      JSON.stringify({ type: "text", part: { text: "Done" }, sessionID: "ses_stream" }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 30, cache: {} }, cost: 0.001 } }),
    ].join("\n");

    const coreApi = makeCoreApi(completeJsonl, 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const logApi = {
      log: vi.fn(async (_ns: string, _pod: string, _container: string, writable: NodeJS.WritableStream) => {
        writable.write(Buffer.from(completeJsonl + "\n"));
      }),
    };
    vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // readNamespacedPodLog should NOT be called (stream provided complete output)
    expect(coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("ses_stream");
  });
});

describe("execute — llm_api_error signal", () => {
  it("returns llm_api_error when session exists but LLM produced no output tokens", async () => {
    // JSONL has a sessionID but no step_finish tokens and no text messages
    const emptyOutputJsonl = JSON.stringify({ sessionID: "ses_empty", type: "step_finish", part: { tokens: { input: 100, output: 0, cache: {} }, cost: 0 } });
    const coreApi = makeCoreApi(emptyOutputJsonl, 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("llm_api_error");
    expect(result.errorMessage).toMatch(/empty response/i);
  });

  it("does not emit llm_api_error when there are output tokens", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("does not emit llm_api_error when there is an explicit error event", async () => {
    const errorJsonl = [
      JSON.stringify({ sessionID: "ses_err", type: "error", error: { message: "API quota exceeded" } }),
    ].join("\n");
    const coreApi = makeCoreApi(errorJsonl, 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).not.toBe("llm_api_error");
    expect(result.errorMessage).toContain("quota");
  });

  it("does not emit llm_api_error when sessionId is null", async () => {
    const coreApi = makeCoreApi("", 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
  });
});

describe("execute — log dedup (waitForPod status dedup)", () => {
  it("logs pod Running status only once when pod is immediately Running", async () => {
    const logMessages: string[] = [];
    const ctx = {
      ...makeCtx(),
      onLog: vi.fn(async (_type: string, msg: string) => {
        logMessages.push(msg);
      }),
    } as unknown as AdapterExecutionContext;

    await execute(ctx);

    // "Pod running: <name>" should appear at most once
    const runningMsgs = logMessages.filter((m) => m.includes(`Pod running: ${POD_NAME}`));
    expect(runningMsgs.length).toBeLessThanOrEqual(1);
  });

  it("logs each distinct pod phase transition exactly once", async () => {
    const logMessages: string[] = [];
    const coreApi = {
      listNamespacedPod: vi.fn()
        .mockResolvedValueOnce({
          items: [{ metadata: { name: POD_NAME }, status: { phase: "Pending" } }],
        })
        .mockResolvedValueOnce({
          // Same Pending state — should NOT produce duplicate log
          items: [{ metadata: { name: POD_NAME }, status: { phase: "Pending" } }],
        })
        .mockResolvedValueOnce({
          items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
        })
        .mockResolvedValueOnce({
          // getPodExitCode call
          items: [{
            status: { containerStatuses: [{ name: "opencode", state: { terminated: { exitCode: 0 } } }] },
          }],
        }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(HAPPY_JSONL),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = {
      ...makeCtx(),
      onLog: vi.fn(async (_type: string, msg: string) => {
        logMessages.push(msg);
      }),
    } as unknown as AdapterExecutionContext;

    await execute(ctx);

    // Pending status should appear exactly once even though listNamespacedPod was called twice
    const pendingMsgs = logMessages.filter((m) => m.includes("phase=Pending"));
    expect(pendingMsgs.length).toBe(1);
  });
});

describe("execute — large-prompt Secret path", () => {
  const LARGE_PROMPT = "x".repeat(300 * 1024); // 300 KiB > 256 KiB threshold

  function mockLargePrompt() {
    vi.mocked(buildJobManifest).mockReturnValue({
      job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
      jobName: JOB_NAME,
      namespace: NAMESPACE,
      prompt: LARGE_PROMPT,
      opencodeArgs: [],
      promptMetrics: null,
    } as unknown as ReturnType<typeof buildJobManifest>);
  }

  it("calls buildJobManifest twice and passes promptSecretName on second call", async () => {
    mockLargePrompt();

    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(buildJobManifest)).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(buildJobManifest).mock.calls[1][0];
    expect(secondCall.promptSecretName).toBe(`${JOB_NAME}-prompt`);
  });

  it("creates a Secret with the prompt content before creating the Job", async () => {
    mockLargePrompt();
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(coreApi.createNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: NAMESPACE,
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: `${JOB_NAME}-prompt` }),
          stringData: expect.objectContaining({ prompt: LARGE_PROMPT }),
        }),
      }),
    );
    // Secret must be created before Job
    const secretOrder = coreApi.createNamespacedSecret.mock.invocationCallOrder[0];
    const jobOrder = batchApi.createNamespacedJob.mock.invocationCallOrder[0];
    expect(secretOrder).toBeLessThan(jobOrder);
  });

  it("patches the Secret with a Job ownerReference after Job creation", async () => {
    mockLargePrompt();
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockResolvedValue({ metadata: { uid: "uid-abc-123" } });
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${JOB_NAME}-prompt`,
        namespace: NAMESPACE,
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            ownerReferences: [
              expect.objectContaining({
                kind: "Job",
                name: JOB_NAME,
                uid: "uid-abc-123",
                controller: true,
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("cleans up the Secret in the finally block", async () => {
    mockLargePrompt();
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${JOB_NAME}-prompt`, namespace: NAMESPACE }),
    );
  });

  it("cleans up the Secret when Job creation fails", async () => {
    mockLargePrompt();
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockRejectedValue(new Error("quota exceeded"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${JOB_NAME}-prompt` }),
    );
  });

  it("does not create a Secret for prompts within threshold", async () => {
    // Default beforeEach mock returns "Test prompt" (11 bytes < 256 KiB)
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(buildJobManifest)).toHaveBeenCalledTimes(1);
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
  });
});
