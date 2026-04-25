import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for FAR-85: the @kubernetes/client-node v1.x ApiException
 * exposes the HTTP status as `code`, not `statusCode`. The previous `isNotFound`
 * predicate only checked `statusCode`/`response.statusCode`, so real 404s were
 * never recognized — `getPvc` re-threw the 404 instead of returning null, and
 * `ensureAgentDbPvc`'s existence check died before the create path ran.
 *
 * These tests mock the underlying k8s SDK and feed `getPvc`/`deletePvc` errors
 * shaped exactly like the real ApiException so the predicate is exercised
 * end-to-end, not in isolation.
 */

vi.mock("@kubernetes/client-node", () => {
  // Reproduces the real @kubernetes/client-node v1.x ApiException shape:
  // HTTP status under `code`, plus `body` and `headers`. Defined inside the
  // factory because vi.mock() is hoisted above any module-level declarations.
  class ApiException<T> extends Error {
    code: number;
    body: T;
    headers: Record<string, string>;
    constructor(code: number, message: string, body: T, headers: Record<string, string> = {}) {
      super(`HTTP-Code: ${code}\nMessage: ${message}\nBody: ${JSON.stringify(body)}`);
      this.code = code;
      this.body = body;
      this.headers = headers;
    }
  }
  class KubeConfig {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient() {
      return {
        readNamespacedPersistentVolumeClaim: mockReadNamespacedPVC,
        deleteNamespacedPersistentVolumeClaim: mockDeleteNamespacedPVC,
        createNamespacedPersistentVolumeClaim: mockCreateNamespacedPVC,
      };
    }
  }
  return {
    KubeConfig,
    CoreV1Api: class {},
    BatchV1Api: class {},
    AuthorizationV1Api: class {},
    Log: class {},
    ApiException,
  };
});

const mockReadNamespacedPVC = vi.fn();
const mockDeleteNamespacedPVC = vi.fn();
const mockCreateNamespacedPVC = vi.fn();

import * as k8s from "@kubernetes/client-node";
import { getPvc, createPvc, deletePvc, resetCache } from "./k8s-client.js";

const ApiException = (k8s as unknown as { ApiException: new <T>(code: number, message: string, body: T, headers?: Record<string, string>) => Error & { code: number; body: T } }).ApiException;

beforeEach(() => {
  resetCache();
  vi.resetAllMocks();
});

describe("getPvc — 404 detection (FAR-85 regression)", () => {
  const NAMESPACE = "paperclip";
  const NAME = "opencode-db-test";

  it("returns the PVC on success", async () => {
    const pvc = { metadata: { name: NAME, namespace: NAMESPACE } };
    mockReadNamespacedPVC.mockResolvedValue(pvc);
    const result = await getPvc(NAMESPACE, NAME);
    expect(result).toEqual(pvc);
    expect(mockReadNamespacedPVC).toHaveBeenCalledWith({ name: NAME, namespace: NAMESPACE });
  });

  it("returns null when the SDK throws ApiException with code=404 (v1.x shape)", async () => {
    mockReadNamespacedPVC.mockRejectedValue(
      new ApiException(404, "Unknown API Status Code!", {
        kind: "Status",
        status: "Failure",
        message: `persistentvolumeclaims "${NAME}" not found`,
        reason: "NotFound",
        code: 404,
      }),
    );
    const result = await getPvc(NAMESPACE, NAME);
    expect(result).toBeNull();
  });

  it("returns null for legacy errors with statusCode=404", async () => {
    mockReadNamespacedPVC.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    expect(await getPvc(NAMESPACE, NAME)).toBeNull();
  });

  it("returns null for legacy errors with response.statusCode=404", async () => {
    mockReadNamespacedPVC.mockRejectedValue(Object.assign(new Error("not found"), { response: { statusCode: 404 } }));
    expect(await getPvc(NAMESPACE, NAME)).toBeNull();
  });

  it("re-throws non-404 ApiException (e.g. 500)", async () => {
    const err = new ApiException(500, "Internal Error", { message: "boom" });
    mockReadNamespacedPVC.mockRejectedValue(err);
    await expect(getPvc(NAMESPACE, NAME)).rejects.toBe(err);
  });

  it("re-throws 403 (Forbidden) — must not be silently masked as missing", async () => {
    const err = new ApiException(403, "Forbidden", { message: "rbac denied" });
    mockReadNamespacedPVC.mockRejectedValue(err);
    await expect(getPvc(NAMESPACE, NAME)).rejects.toBe(err);
  });
});

describe("deletePvc — 404 detection", () => {
  const NAMESPACE = "paperclip";
  const NAME = "opencode-db-test";

  it("swallows ApiException with code=404 (already gone)", async () => {
    mockDeleteNamespacedPVC.mockRejectedValue(
      new ApiException(404, "Unknown API Status Code!", { reason: "NotFound" }),
    );
    await expect(deletePvc(NAMESPACE, NAME)).resolves.toBeUndefined();
  });

  it("re-throws non-404 errors", async () => {
    const err = new ApiException(409, "Conflict", { reason: "Conflict" });
    mockDeleteNamespacedPVC.mockRejectedValue(err);
    await expect(deletePvc(NAMESPACE, NAME)).rejects.toBe(err);
  });
});

describe("createPvc — passes through to SDK", () => {
  it("forwards the spec to createNamespacedPersistentVolumeClaim", async () => {
    const spec = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "opencode-db-x", namespace: "paperclip" },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
    };
    mockCreateNamespacedPVC.mockResolvedValue(spec);
    const result = await createPvc("paperclip", spec as never);
    expect(result).toEqual(spec);
    expect(mockCreateNamespacedPVC).toHaveBeenCalledWith({ namespace: "paperclip", body: spec });
  });
});
