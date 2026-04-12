import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      // Core fields
      {
        key: "model",
        label: "Model",
        type: "text",
        hint: "OpenCode model id in provider/model format (e.g. anthropic/claude-sonnet-4-6)",
        required: true,
        group: "Core",
      },
      {
        key: "variant",
        label: "Variant",
        type: "text",
        hint: "Provider-specific reasoning/profile variant passed as --variant",
        group: "Core",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip Permission Checks",
        type: "toggle",
        default: true,
        hint: "Inject runtime config with permission.external_directory=allow",
        group: "Core",
      },
      {
        key: "promptTemplate",
        label: "Prompt Template",
        type: "text",
        hint: "Run prompt template",
        group: "Core",
      },
      {
        key: "extraArgs",
        label: "Extra Arguments",
        type: "textarea",
        hint: "JSON array of additional CLI args appended to the opencode command",
        group: "Core",
      },
      {
        key: "env",
        label: "Environment Variables",
        type: "textarea",
        hint: "KEY=VALUE pairs, one per line. Overrides inherited vars from the Deployment.",
        group: "Core",
      },

      // Kubernetes fields
      {
        key: "namespace",
        label: "Namespace",
        type: "text",
        hint: "Kubernetes namespace for Jobs; defaults to the Deployment namespace",
        group: "Kubernetes",
      },
      {
        key: "image",
        label: "Container Image",
        type: "text",
        hint: "Override container image; defaults to the running Deployment image",
        group: "Kubernetes",
      },
      {
        key: "imagePullPolicy",
        label: "Image Pull Policy",
        type: "select",
        options: [
          { label: "IfNotPresent", value: "IfNotPresent" },
          { label: "Always", value: "Always" },
          { label: "Never", value: "Never" },
        ],
        default: "IfNotPresent",
        group: "Kubernetes",
      },
      {
        key: "kubeconfig",
        label: "Kubeconfig Path",
        type: "text",
        hint: "Absolute path to a kubeconfig file; defaults to in-cluster service account auth",
        group: "Kubernetes",
      },
      {
        key: "resources.requests.cpu",
        label: "CPU Request",
        type: "text",
        hint: "e.g. '1000m' or '1'",
        group: "Kubernetes",
      },
      {
        key: "resources.requests.memory",
        label: "Memory Request",
        type: "text",
        hint: "e.g. '2Gi' or '2G'",
        group: "Kubernetes",
      },
      {
        key: "resources.limits.cpu",
        label: "CPU Limit",
        type: "text",
        hint: "e.g. '4000m' or '4'",
        group: "Kubernetes",
      },
      {
        key: "resources.limits.memory",
        label: "Memory Limit",
        type: "text",
        hint: "e.g. '8Gi' or '8G'",
        group: "Kubernetes",
      },
      {
        key: "nodeSelector",
        label: "Node Selector",
        type: "textarea",
        hint: "key=value pairs, one per line",
        group: "Kubernetes",
      },
      {
        key: "tolerations",
        label: "Tolerations",
        type: "textarea",
        hint: "JSON array of toleration objects",
        group: "Kubernetes",
      },
      {
        key: "labels",
        label: "Labels",
        type: "textarea",
        hint: "key=value pairs, one per line. Extra labels added to Job metadata.",
        group: "Kubernetes",
      },
      {
        key: "ttlSecondsAfterFinished",
        label: "TTL After Finished",
        type: "number",
        default: 300,
        hint: "Auto-cleanup delay in seconds after Job completes",
        group: "Kubernetes",
      },
      {
        key: "retainJobs",
        label: "Retain Jobs",
        type: "toggle",
        hint: "Skip cleanup on completion for debugging",
        group: "Kubernetes",
      },

      // Operational fields
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 0,
        hint: "Run timeout in seconds; 0 means no timeout",
        group: "Operational",
      },
      {
        key: "graceSec",
        label: "Grace Period (seconds)",
        type: "number",
        default: 60,
        hint: "Additional grace before adapter gives up after Job deadline",
        group: "Operational",
      },
    ],
  };
}