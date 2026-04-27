import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";

describe("createServerAdapter", () => {
  it("declares the opencode_k8s type", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("opencode_k8s");
  });

  it("exposes listModels for dynamic model discovery", () => {
    const adapter = createServerAdapter();
    expect(typeof adapter.listModels).toBe("function");
  });
});
