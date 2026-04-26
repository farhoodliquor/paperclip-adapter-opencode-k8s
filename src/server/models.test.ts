import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();

vi.mock("child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    execMock(cmd, opts, cb);
  },
}));

const { listK8sModels, STATIC_MODELS } = await import("./models.js");

function mockExecResult(stdout: string) {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, { stdout, stderr: "" });
  });
}

function mockExecError(err: Error) {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(err, { stdout: "", stderr: "" });
  });
}

describe("listK8sModels", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("parses opencode models output into AdapterModel entries", async () => {
    mockExecResult(
      [
        "anthropic/claude-opus-4-7",
        "openai/gpt-4o",
        "google/gemini-2.5-pro",
      ].join("\n"),
    );

    const models = await listK8sModels();

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ id: "anthropic/claude-opus-4-7", label: "claude opus 4 7" });
    expect(models[1]).toEqual({ id: "openai/gpt-4o", label: "gpt 4o" });
    expect(models[2]).toEqual({ id: "google/gemini-2.5-pro", label: "gemini 2.5 pro" });
  });

  it("ignores blank lines and trims whitespace", async () => {
    mockExecResult("\nanthropic/claude-opus-4-7\n\n  openai/gpt-4o  \n\n");

    const models = await listK8sModels();

    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-7",
      "openai/gpt-4o",
    ]);
  });

  it("invokes opencode models with a timeout", async () => {
    mockExecResult("anthropic/claude-opus-4-7");

    await listK8sModels();

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, opts] = execMock.mock.calls[0];
    expect(cmd).toBe("opencode models");
    expect(opts).toMatchObject({ timeout: 30_000 });
  });

  it("falls back to the static list when the CLI fails", async () => {
    mockExecError(new Error("ENOENT: opencode not found"));

    const models = await listK8sModels();

    expect(models).toBe(STATIC_MODELS);
    expect(models.length).toBeGreaterThan(0);
  });

  it("falls back to the static list when the CLI returns empty stdout", async () => {
    mockExecResult("");

    const models = await listK8sModels();

    expect(models).toBe(STATIC_MODELS);
  });
});
