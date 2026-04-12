# @farhoodliquor/paperclip-adapter-opencode-k8s

Paperclip adapter plugin that runs OpenCode agents as isolated Kubernetes Jobs instead of inside the main Paperclip process.

## Features

- Spawns agent runs as K8s Jobs with full pod isolation
- Inherits container image, secrets, DNS, and PVC from the Paperclip Deployment automatically
- Real-time log streaming from Job pods back to the Paperclip UI
- Session resume via shared RWX PVC
- Per-agent concurrency guard
- Configurable resources, namespace, kubeconfig
- Runtime config injection for permission bypass

## Installation

### Via Paperclip Adapter Manager

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"packageName": "@farhoodliquor/paperclip-adapter-opencode-k8s"}'
```

### Local Development

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/path/to/paperclip-adapter-opencode-k8s"}'
```

## Configuration

See the agent configuration documentation for all available fields:

- `model` (required) — OpenCode model in provider/model format
- `variant` — reasoning profile variant
- `namespace` — K8s namespace for Jobs
- `image` — Override container image
- `kubeconfig` — Path to kubeconfig file
- `resources` — CPU/memory requests and limits
- `timeoutSec` — Run timeout (0 = no timeout)
- `retainJobs` — Keep completed Jobs for debugging

## Requirements

- **Paperclip must be deployed on a Kubernetes cluster with a shared RWX PVC mounted at `/paperclip`** — this is required for session resume and workspace sharing between the Paperclip pod and agent Job pods
- Kubernetes cluster with RBAC permissions to create Jobs, list Pods, and read Pod logs
- `@paperclipai/adapter-utils` >= 0.3.0

## License

MIT
