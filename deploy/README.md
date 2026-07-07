# HydraLLM Deployment

These deployment files use the already-built Docker image from GitHub Packages:

```text
ghcr.io/clockclock1/hydrallm
```

They do not build images locally.

## Docker Compose

Copy the example environment file and pin the version you published:

```bash
cd deploy/compose
cp .env.example .env
# edit HYDRALLM_VERSION=v0.1.0
docker compose up -d
```

The service is exposed on `http://127.0.0.1:8787` by default. Configuration is persisted in the named Docker volume `hydrallm-data`.

## Kubernetes

Use the release tag that exists in GHCR:

```bash
cd deploy/kubernetes
kustomize edit set image ghcr.io/clockclock1/hydrallm=ghcr.io/clockclock1/hydrallm:v0.1.0
kubectl apply -k .
```

The manifests create:

- Namespace: `hydrallm`
- Deployment: `hydrallm`
- Service: `hydrallm`
- PVC: `hydrallm-data`
- Ingress: `hydrallm.example.com`

Before applying to production, edit `ingress.yaml` and replace `hydrallm.example.com` with your real domain. If your cluster does not use nginx ingress, update or remove the ingress annotations/class.
