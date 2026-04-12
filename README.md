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

## Prerequisites

Before installing this adapter, ensure the following requirements are met.

### 1. Shared ReadWriteMany (RWX) PersistentVolumeClaim

**This is the most critical requirement.** The Paperclip Deployment and every agent Job pod must share the same filesystem at `/paperclip`. This requires a PVC with `ReadWriteMany` access mode.

The adapter discovers the PVC by introspecting the running Paperclip pod — it finds the volume mounted at `/paperclip` and reuses the same claim name for all spawned Jobs. There is no config field for the PVC name; it is always auto-detected.

**Why RWX?** The Paperclip Deployment pod and multiple concurrent agent Job pods all need simultaneous read/write access to the same volume. A `ReadWriteOnce` PVC will cause Job pods to fail to schedule.

Example PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: paperclip-data
  namespace: paperclip
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: your-rwx-storage-class   # e.g. efs-sc, nfs-csi, azurefile-csi
  resources:
    requests:
      storage: 50Gi
```

The Paperclip Deployment must mount this PVC at `/paperclip`:

```yaml
# Excerpt from the Paperclip Deployment spec
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: paperclip-data
containers:
  - name: paperclip
    volumeMounts:
      - name: data
        mountPath: /paperclip
```

> **Note:** Your cluster must have a StorageClass that supports RWX volumes. Common options include AWS EFS, Azure Files, NFS-based provisioners, or GCP Filestore. Standard block storage (gp3, Azure Disk, GCE PD) does **not** support RWX.

### 2. Kubernetes RBAC

The Paperclip Deployment's service account needs permissions to create and manage Jobs, list Pods, and stream Pod logs. Apply the following Role and RoleBinding in the namespace where agent Jobs will run.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip
  namespace: paperclip
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: paperclip-adapter
  namespace: paperclip
rules:
  # Create, inspect, and clean up agent Jobs
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "delete"]

  # List pods spawned by Jobs (label selector: job-name=<name>)
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]

  # Stream and read logs from agent pods
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]

  # Verify the target namespace exists (optional — only needed
  # when targeting a namespace other than the Deployment's own)
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get"]

  # Verify the RWX PVC exists and has the correct access mode
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get"]

  # Verify optional secrets exist (e.g. paperclip-secrets)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]

  # RBAC self-test during adapter validation
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: paperclip-adapter
  namespace: paperclip
subjects:
  - kind: ServiceAccount
    name: paperclip
    namespace: paperclip
roleRef:
  kind: Role
  name: paperclip-adapter
  apiGroup: rbac.authorization.k8s.io
```

Then reference the service account in your Paperclip Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: paperclip
  namespace: paperclip
spec:
  template:
    spec:
      serviceAccountName: paperclip
      # ... containers, volumes, etc.
```

> **Scoping note:** If agent Jobs run in the same namespace as the Paperclip Deployment (the default), a namespace-scoped `Role` + `RoleBinding` is sufficient. If you configure Jobs to run in a different namespace, use a `ClusterRole` + `ClusterRoleBinding` or create the Role in the target namespace with a cross-namespace RoleBinding.

### 3. Additional Cluster Requirements

- **Kubernetes 1.25+** — the adapter uses `batch/v1` Jobs with `ttlSecondsAfterFinished` for automatic cleanup.
- **In-cluster authentication** — the Deployment pod must have a mounted service account token (default for all pods). Alternatively, set the `kubeconfig` config field for out-of-cluster access.
- **Image pull secrets** — if your container images are in a private registry, configure `imagePullSecrets` on the Paperclip Deployment. The adapter automatically forwards these to all spawned Job pods.
- **DNS config** — custom DNS settings on the Paperclip Deployment are automatically inherited by Job pods.

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

Agent-level configuration fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | **yes** | — | OpenCode model in `provider/model` format |
| `variant` | no | — | Reasoning profile variant |
| `namespace` | no | Deployment namespace | K8s namespace for agent Jobs |
| `image` | no | Deployment image | Override container image for Jobs |
| `kubeconfig` | no | In-cluster | Path to kubeconfig file |
| `serviceAccountName` | no | Default SA | Service account for Job pods |
| `resources` | no | See below | CPU/memory requests and limits |
| `timeoutSec` | no | `0` (none) | Run timeout in seconds |
| `retainJobs` | no | `false` | Keep completed Jobs for debugging |
| `env` | no | — | Additional environment variables for Jobs |

### Default Resource Requests and Limits

If not overridden, agent Job pods use:

```yaml
resources:
  requests:
    cpu: "1000m"
    memory: "2Gi"
  limits:
    cpu: "4000m"
    memory: "8Gi"
```

## How It Works

1. **Self-introspection** — on first run, the adapter reads the Paperclip Deployment pod's own spec to discover the PVC claim name, mounted secrets, image pull secrets, DNS config, and environment variables.
2. **Job creation** — each agent run creates a Kubernetes Job in the target namespace. The Job pod mounts the same RWX PVC at `/paperclip`, inherits all secrets and env vars, and runs the agent command.
3. **Log streaming** — the adapter streams stdout/stderr from the Job pod back to the Paperclip UI in real time.
4. **Concurrency guard** — only one Job per agent is allowed at a time (enforced via label selectors).
5. **Cleanup** — completed Jobs are automatically deleted after 300 seconds (`ttlSecondsAfterFinished`), or retained if `retainJobs` is enabled.

### Security Context

All Job pods run with a locked-down security context:

- `runAsUser: 1000`, `runAsGroup: 1000`, `fsGroup: 1000`
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- All Linux capabilities dropped
- `fsGroupChangePolicy: OnRootMismatch` for volume permission handling

## Dependencies

- `@kubernetes/client-node` ^1.0.0
- `@paperclipai/adapter-utils` >=2026.411.0-canary.8 (peer dependency)

## License

MIT
