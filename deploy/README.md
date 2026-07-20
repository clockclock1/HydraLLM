# Deployment

## Docker Compose

```bash
cd deploy/compose
cp .env.example .env
docker compose up -d
```

Set `HYDRALLM_IMAGE`, `HYDRALLM_PORT`, `HYDRALLM_DATA_DIR`, `HYDRALLM_VERSION`, `HYDRALLM_NETWORK`, and `RUST_LOG` in `.env` or the environment when needed.

## Kubernetes

The Kubernetes manifests are intentionally small and assume the image is already published to GHCR.

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/pvc.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
```
