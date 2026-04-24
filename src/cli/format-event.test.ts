import { describe, it, expect } from "vitest";
import { formatEvent } from "./format-event.js";

describe("formatEvent", () => {
  describe("empty / non-JSON input", () => {
    it("returns empty string for empty line", () => {
      expect(formatEvent("", false)).toBe("");
    });

    it("returns empty string for whitespace-only line", () => {
      expect(formatEvent("   ", false)).toBe("");
    });

    it("returns non-JSON line as-is (trimmed)", () => {
      expect(formatEvent("plain text output", false)).toBe("plain text output");
    });

    it("trims whitespace from non-JSON lines", () => {
      expect(formatEvent("  trimmed  ", false)).toBe("trimmed");
    });
  });

  describe("step_start", () => {
    it("returns empty string in normal mode", () => {
      const line = JSON.stringify({ type: "step_start", sessionID: "ses_1" });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns [step_start] with session in debug mode", () => {
      const line = JSON.stringify({ type: "step_start", sessionID: "ses_1" });
      expect(formatEvent(line, true)).toBe("[step_start] session=ses_1");
    });

    it("returns [step_start] without session suffix when sessionID absent in debug mode", () => {
      const line = JSON.stringify({ type: "step_start" });
      expect(formatEvent(line, true)).toBe("[step_start]");
    });
  });

  describe("text", () => {
    it("returns text content", () => {
      const line = JSON.stringify({ type: "text", part: { text: "Hello world" } });
      expect(formatEvent(line, false)).toBe("Hello world");
    });

    it("returns trimmed text", () => {
      const line = JSON.stringify({ type: "text", part: { text: "  trimmed  " } });
      expect(formatEvent(line, false)).toBe("trimmed");
    });

    it("returns empty string for empty text field", () => {
      const line = JSON.stringify({ type: "text", part: { text: "" } });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns same output in debug mode", () => {
      const line = JSON.stringify({ type: "text", part: { text: "Debug output" } });
      expect(formatEvent(line, true)).toBe("Debug output");
    });
  });

  describe("tool_use", () => {
    it("returns empty for normal tool_use in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "pending", description: "ls" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns empty for completed tool_use in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "completed", output: "result" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns warning with ⚠ prefix for tool error in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "Command failed" } },
      });
      expect(formatEvent(line, false)).toBe("⚠ Command failed");
    });

    it("returns empty for tool error with empty error field in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns debug info including tool name and status in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "grep", state: { status: "completed", description: "search files" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("[tool:grep]");
      expect(result).toContain("completed");
      expect(result).toContain("search files");
    });

    it("appends output snippet in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "completed", output: "output result here" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("output result here");
    });

    it("appends error in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "exit code 1" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("✗ exit code 1");
    });
  });

  describe("step_finish", () => {
    it("returns message when provided", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Task complete", reason: "end_turn" },
      });
      expect(formatEvent(line, false)).toBe("Task complete");
    });

    it("returns fallback with reason when message is empty", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { reason: "end_turn", message: "" },
      });
      expect(formatEvent(line, false)).toBe("[step_finish] end_turn");
    });

    it("returns fallback with empty reason when both message and reason absent", () => {
      const line = JSON.stringify({ type: "step_finish", part: {} });
      expect(formatEvent(line, false)).toBe("[step_finish] ");
    });

    it("appends token count when non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 500 }, cost: 0 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("tokens=500");
    });

    it("appends cost when non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 0 }, cost: 0.0025 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("cost$0.0025");
    });

    it("appends both tokens and cost when both non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 300 }, cost: 0.001 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("tokens=300");
      expect(result).toContain("cost$0.0010");
    });

    it("omits metrics suffix when tokens and cost are zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 0 }, cost: 0 },
      });
      expect(formatEvent(line, false)).toBe("Done");
    });
  });

  describe("error", () => {
    it("returns error message with ✗ prefix", () => {
      const line = JSON.stringify({ type: "error", error: { message: "Something failed" } });
      expect(formatEvent(line, false)).toBe("✗ Something failed");
    });

    it("returns ✗ prefix with string error", () => {
      const line = JSON.stringify({ type: "error", message: "Direct error" });
      const result = formatEvent(line, false);
      expect(result).toContain("✗");
    });

    it("returns empty string for error with no extractable text", () => {
      const line = JSON.stringify({ type: "error" });
      const result = formatEvent(line, false);
      expect(typeof result).toBe("string");
    });
  });

  describe("assistant", () => {
    it("returns nested text content", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "text", text: "Assistant response" }] } },
      });
      expect(formatEvent(line, false)).toBe("Assistant response");
    });

    it("returns trimmed nested text", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "text", text: "  Trimmed  " }] } },
      });
      expect(formatEvent(line, false)).toBe("Trimmed");
    });

    it("returns empty for non-text content blocks", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "tool_use" }] } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns empty for assistant with no content", () => {
      const line = JSON.stringify({ type: "assistant", part: {} });
      expect(formatEvent(line, false)).toBe("");
    });
  });

  describe("unknown types", () => {
    it("returns empty string for unknown type in non-debug mode", () => {
      const line = JSON.stringify({ type: "some_unknown_type", data: {} });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns [type] for unknown type in debug mode", () => {
      const line = JSON.stringify({ type: "some_unknown_type" });
      expect(formatEvent(line, true)).toBe("[some_unknown_type]");
    });

    it("returns empty string for JSON with no type in non-debug mode", () => {
      const line = JSON.stringify({ sessionID: "ses_123" });
      expect(formatEvent(line, false)).toBe("");
    });
  });
});
