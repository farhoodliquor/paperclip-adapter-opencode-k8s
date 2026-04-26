import type { AdapterModel } from "@paperclipai/adapter-utils";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function listK8sModels(): Promise<AdapterModel[]> {
  try {
    const result = await execAsync("opencode models", { timeout: 30_000 });
    const output = result.stdout;
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    const models: AdapterModel[] = [];
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split("/");
      const id = line;
      const label = parts[parts.length - 1].replace(/-/g, " ").replace(/_/g, " ");
      models.push({ id, label });
    }
    return models;
  } catch {
    const fallback: AdapterModel[] = [
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ];
    return fallback;
  }
}