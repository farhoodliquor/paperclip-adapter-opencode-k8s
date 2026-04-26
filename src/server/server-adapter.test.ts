import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";
import { STATIC_MODELS } from "./models.js";

describe("createServerAdapter", () => {
  it("declares the opencode_k8s type", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("opencode_k8s");
  });

  it("exposes a non-empty static models list so the UI never renders zero models", () => {
    const adapter = createServerAdapter();
    expect(Array.isArray(adapter.models)).toBe(true);
    expect(adapter.models!.length).toBeGreaterThan(0);
    expect(adapter.models).toBe(STATIC_MODELS);
    for (const m of adapter.models!) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it("also exposes listModels for dynamic refresh", () => {
    const adapter = createServerAdapter();
    expect(typeof adapter.listModels).toBe("function");
  });
});
