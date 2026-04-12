import { describe, it, expect } from "vitest";
import { getConfigSchema } from "./config-schema.js";

interface ConfigFieldSchema {
  key: string;
  label: string;
  type: string;
  default?: unknown;
  options?: { label: string; value: string }[];
  required?: boolean;
  group?: string;
}

describe("getConfigSchema", () => {
  it("returns a schema with expected field groups", () => {
    const schema = getConfigSchema();
    expect(schema.fields.length).toBeGreaterThan(0);

    const groups = schema.fields.map((f: ConfigFieldSchema) => f.group);
    const uniqueGroups = [...new Set(groups)];

    expect(uniqueGroups).toContain("Core");
    expect(uniqueGroups).toContain("Kubernetes");
    expect(uniqueGroups).toContain("Operational");
  });

  it("has model as required text field", () => {
    const schema = getConfigSchema();
    const modelField = schema.fields.find((f: ConfigFieldSchema) => f.key === "model");
    expect(modelField).toBeDefined();
    expect(modelField!.type).toBe("text");
    expect(modelField!.required).toBe(true);
  });

  it("has imagePullPolicy as select with correct options", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "imagePullPolicy");
    expect(field).toBeDefined();
    expect(field!.type).toBe("select");
    expect(field!.options).toEqual([
      { label: "IfNotPresent", value: "IfNotPresent" },
      { label: "Always", value: "Always" },
      { label: "Never", value: "Never" },
    ]);
  });

  it("dangerouslySkipPermissions defaults to true", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "dangerouslySkipPermissions");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(true);
  });

  it("ttlSecondsAfterFinished defaults to 300", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "ttlSecondsAfterFinished");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(300);
  });

  it("timeoutSec defaults to 0", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "timeoutSec");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(0);
  });

  it("graceSec defaults to 60", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "graceSec");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(60);
  });

  it("retainJobs is a toggle", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "retainJobs");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
  });

  it("has all kubernetes resource fields", () => {
    const schema = getConfigSchema();
    const resourceKeys = [
      "resources.requests.cpu",
      "resources.requests.memory",
      "resources.limits.cpu",
      "resources.limits.memory",
    ];
    for (const key of resourceKeys) {
      const field = schema.fields.find((f: ConfigFieldSchema) => f.key === key);
      expect(field).toBeDefined();
      expect(field!.type).toBe("text");
    }
  });

  it("has env and extraArgs as textarea", () => {
    const schema = getConfigSchema();
    const envField = schema.fields.find((f: ConfigFieldSchema) => f.key === "env");
    expect(envField).toBeDefined();
    expect(envField!.type).toBe("textarea");

    const extraArgsField = schema.fields.find((f: ConfigFieldSchema) => f.key === "extraArgs");
    expect(extraArgsField).toBeDefined();
    expect(extraArgsField!.type).toBe("textarea");
  });
});