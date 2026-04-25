import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureAgentDbPvc } from "./execute.js";
import { getPvc, createPvc } from "./k8s-client.js";

vi.mock("./k8s-client.js", () => ({
  getSelfPodInfo: vi.fn(),
  getBatchApi: vi.fn(),
  getCoreApi: vi.fn(),
  getLogApi: vi.fn(),
  getPvc: vi.fn(),
  createPvc: vi.fn(),
}));

const AGENT_ID = "623c5ffa-9486-4ddd-8ac4-35747f13069c";
const NAMESPACE = "paperclip";
const STORAGE_CLASS = "standard";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ensureAgentDbPvc", () => {
  it("returns null in ephemeral mode without calling K8s", async () => {
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "ephemeral" });
    expect(result).toBeNull();
    expect(getPvc).not.toHaveBeenCalled();
    expect(createPvc).not.toHaveBeenCalled();
  });

  it("returns the PVC name when it already exists (dedicated_pvc)", async () => {
    vi.mocked(getPvc).mockResolvedValue({ metadata: { name: `opencode-db-${AGENT_ID}` } } as never);
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: STORAGE_CLASS,
    });
    expect(result).toBe(`opencode-db-${AGENT_ID}`);
    expect(createPvc).not.toHaveBeenCalled();
  });

  it("creates PVC when it does not exist and returns the name", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({} as never);
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: STORAGE_CLASS,
      agentDbStorageCapacity: "2Gi",
    });
    expect(result).toBe(`opencode-db-${AGENT_ID}`);
    expect(createPvc).toHaveBeenCalledOnce();
    const [ns, spec] = vi.mocked(createPvc).mock.calls[0];
    expect(ns).toBe(NAMESPACE);
    expect(spec.spec?.storageClassName).toBe(STORAGE_CLASS);
    expect(spec.spec?.resources?.requests?.storage).toBe("2Gi");
    expect(spec.spec?.accessModes).toContain("ReadWriteOnce");
    expect(spec.metadata?.labels?.["paperclip.io/agent-id"]).toBe(AGENT_ID);
  });

  it("defaults to dedicated_pvc mode when agentDbMode is not set", async () => {
    vi.mocked(getPvc).mockResolvedValue({ metadata: { name: `opencode-db-${AGENT_ID}` } } as never);
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbStorageClass: STORAGE_CLASS });
    expect(result).toBe(`opencode-db-${AGENT_ID}`);
  });

  it("defaults storage capacity to 1Gi when agentDbStorageCapacity is not set", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({} as never);
    await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: STORAGE_CLASS,
    });
    const [, spec] = vi.mocked(createPvc).mock.calls[0];
    expect(spec.spec?.resources?.requests?.storage).toBe("1Gi");
  });

  it("throws when agentDbStorageClass is missing in dedicated_pvc mode", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    await expect(
      ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "dedicated_pvc" }),
    ).rejects.toThrow("agentDbStorageClass is required");
  });

  it("sanitizes agent ID in PVC name (strips non-alphanumeric except hyphens)", async () => {
    const weirdId = "Agent/ID:with@special!chars";
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({} as never);
    const result = await ensureAgentDbPvc(weirdId, NAMESPACE, {
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: STORAGE_CLASS,
    });
    expect(result).toMatch(/^opencode-db-[a-z0-9-]+$/);
    expect(result).not.toContain("/");
    expect(result).not.toContain("@");
  });
});
