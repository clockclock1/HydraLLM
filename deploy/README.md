# HydraLLM 部署 / Deployment

中文 | [English](#english)

这些部署文件只使用 GitHub Packages 中已经编译好的 Docker 镜像：

```text
ghcr.io/clockclock1/hydrallm
```

它们不会在本地构建镜像。

## Docker Compose

复制环境变量示例，并把版本号改成你已经发布的 Release：

```bash
cd deploy/compose
cp .env.example .env
# 编辑 HYDRALLM_VERSION=v0.1.0
docker compose up -d
```

默认访问地址是 `http://127.0.0.1:8787`。

配置数据默认保存到 clone 下来的项目目录：

```text
deploy/compose/data
```

Docker Compose 首次启动时会自动创建这个本地数据目录，并自动创建一个名为 `hydrallm-network` 的 bridge 网络。

### 自定义宿主机端口

容器内部固定监听 `8787`，但你可以通过 `.env` 把任意宿主机端口映射到它。

例如把服务暴露到宿主机 `18080`：

```bash
cd deploy/compose
cp .env.example .env
```

编辑 `.env`：

```env
HYDRALLM_IMAGE=ghcr.io/clockclock1/hydrallm
HYDRALLM_VERSION=v0.1.0
HYDRALLM_PORT=18080
HYDRALLM_DATA_DIR=./data
HYDRALLM_NETWORK=hydrallm-network
```

启动：

```bash
docker compose up -d
```

然后访问：

```text
http://127.0.0.1:18080
```

对应的 Compose 端口映射是：

```yaml
ports:
  - "${HYDRALLM_PORT:-8787}:8787"
```

左边是宿主机端口，右边是容器端口。

### 自定义数据目录和网络

默认：

```env
HYDRALLM_DATA_DIR=./data
HYDRALLM_NETWORK=hydrallm-network
```

`./data` 是相对 `deploy/compose/docker-compose.yml` 的路径，因此数据会落在 clone 下来的项目文件夹内。

网络由 Compose 自动创建：

```yaml
networks:
  hydrallm-network:
    name: ${HYDRALLM_NETWORK:-hydrallm-network}
    driver: bridge
```

## Kubernetes

使用 GHCR 中已经存在的 Release 镜像：

```bash
cd deploy/kubernetes
kustomize edit set image ghcr.io/clockclock1/hydrallm=ghcr.io/clockclock1/hydrallm:v0.1.0
kubectl apply -k .
```

清单会创建：

- Namespace: `hydrallm`
- Deployment: `hydrallm`
- Service: `hydrallm`
- PVC: `hydrallm-data`
- Ingress: `hydrallm.example.com`

生产环境应用前，请编辑 `ingress.yaml`，把 `hydrallm.example.com` 换成你的真实域名。如果集群不使用 nginx ingress，请调整或删除 ingress class 和 annotations。

---

## English

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

The service is exposed on `http://127.0.0.1:8787` by default.

Configuration is persisted in the cloned project folder:

```text
deploy/compose/data
```

Docker Compose creates this local data folder automatically on first start. It also creates a dedicated bridge network named `hydrallm-network`.

### Custom Host Port

The container always listens on port `8787`, but you can map any host port to it through `.env`.

Example: expose HydraLLM on host port `18080`:

```bash
cd deploy/compose
cp .env.example .env
```

Edit `.env`:

```env
HYDRALLM_IMAGE=ghcr.io/clockclock1/hydrallm
HYDRALLM_VERSION=v0.1.0
HYDRALLM_PORT=18080
HYDRALLM_DATA_DIR=./data
HYDRALLM_NETWORK=hydrallm-network
```

Start:

```bash
docker compose up -d
```

Then open:

```text
http://127.0.0.1:18080
```

Equivalent mapping in `docker-compose.yml`:

```yaml
ports:
  - "${HYDRALLM_PORT:-8787}:8787"
```

The left side is the host port. The right side is the container port.

### Custom Data Directory and Network

Defaults:

```env
HYDRALLM_DATA_DIR=./data
HYDRALLM_NETWORK=hydrallm-network
```

`./data` is relative to `deploy/compose/docker-compose.yml`, so the data stays inside the cloned project folder.

The network is created automatically by Compose:

```yaml
networks:
  hydrallm-network:
    name: ${HYDRALLM_NETWORK:-hydrallm-network}
    driver: bridge
```

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
