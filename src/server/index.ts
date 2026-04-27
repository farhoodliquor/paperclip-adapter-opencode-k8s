import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { type, agentConfigurationDoc } from "../index.js";
import { listK8sModels } from "./models.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./session.js";
import { getConfigSchema } from "./config-schema.js";
import { listOpenCodeSkills, syncOpenCodeSkills } from "./skills.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    listModels: listK8sModels,
    listSkills: listOpenCodeSkills,
    syncSkills: syncOpenCodeSkills,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc,
    getConfigSchema,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    sessionManagement: getAdapterSessionManagement("opencode_local") ?? {
      supportsSessionResume: true,
      nativeContextManagement: "unknown",
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 20,
        maxRawInputTokens: 500_000,
        maxSessionAgeHours: 24,
      },
    },
  };
}

export { execute, testEnvironment, sessionCodec };
