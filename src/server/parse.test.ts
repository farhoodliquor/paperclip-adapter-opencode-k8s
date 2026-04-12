import { describe, it, expect } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses text messages", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "Hello" }, sessionID: "ses_123" }),
      JSON.stringify({ type: "text", part: { text: "World" }, sessionID: "ses_123" }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.sessionId).toBe("ses_123");
    expect(result.summary).toBe("Hello\n\nWorld");
    expect(result.errorMessage).toBeNull();
  });

  it("accumulates usage from step_finish events", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 80 } }, cost: 0.001 },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(70);
    expect(result.costUsd).toBeCloseTo(0.001);
  });

  it("captures text from step_finish message field", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: { message: "Final response text", tokens: { input: 10, output: 5 } },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.summary).toBe("Final response text");
  });

  it("captures errors from error type events", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { message: "Something went wrong" } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("captures tool_use errors with error state", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        part: { state: { status: "error", error: "Tool failed" } },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Tool failed");
  });

  it("extracts sessionId from any event", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "Hi" }, sessionID: "ses_abc" }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.sessionId).toBe("ses_abc");
  });

  it("handles empty stdout", () => {
    const result = parseOpenCodeJsonl("");

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.errorMessage).toBeNull();
  });

  it("skips malformed JSON lines", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ type: "text", part: { text: "Valid" }, sessionID: "ses_1" }),
      "",
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.summary).toBe("Valid");
  });

  it("combines multiple errors", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { message: "Error 1" } }),
      JSON.stringify({ type: "error", error: { message: "Error 2" } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Error 1\nError 2");
  });

  it("parses nested error message in data field", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { data: { message: "Nested error" } } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Nested error");
  });
});

describe("isOpenCodeUnknownSessionError", () => {
  it("detects 'unknown session' in stdout", () => {
    const stdout = "Error: unknown session";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'session not found' in stdout", () => {
    const stdout = "session not found";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'resource not found' with session path in stdout", () => {
    const stdout = "resource not found: /session/abc.json";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'no session' in combined output", () => {
    const stdout = "";
    const stderr = "no session available";
    expect(isOpenCodeUnknownSessionError(stdout, stderr)).toBe(true);
  });

  it("returns false for normal errors", () => {
    const stdout = "Something went wrong";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(false);
  });

  it("handles case insensitivity", () => {
    const stdout = "UNKNOWN SESSION";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });
});
