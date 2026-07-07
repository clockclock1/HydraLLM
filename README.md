# HydraLLM

中文 | [English](#english)

HydraLLM 是一个 OpenAI 兼容的 LLM 故障转移代理，内置可视化管理界面。它可以暴露自定义 API Key 和 OpenAI 风格接口，并把一个或多个公开模型名按顺序路由到多个上游模型。

## 功能

- OpenAI 兼容接口：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/completions`
- 同时支持去掉 `/v1` 的路径。
- 可视化 React 管理界面。
- 自定义代理 API Key。
- 固定模型别名。
- 模型源模式：从自定义 `/v1/models` URL 拉取多个模型，并为所有拉取到的模型套用同一组故障转移上游。
- 流式、工具调用、response format、多模态请求体原样透传。
- 本地持久化配置：`data/config.json`。
- 上游健康检查会定时刷新管理界面的在线提供商状态。
- 单个上游连续失败达到阈值后会临时禁用，失败次数和冷却分钟数可在管理界面配置。
- GitHub Release 发布时自动构建 Windows、Linux、macOS 的 amd64 和 arm64 可执行文件。
- GitHub Release 发布时自动构建并推送多架构 Docker 镜像到 GitHub Packages / GHCR。

## 本地启动

```powershell
.\start.ps1
```

默认信息：

- 管理界面：`http://127.0.0.1:8787`
- 外部监听：`0.0.0.0:8787`
- 默认 Admin Token：`admin`
- 默认代理 Key：`sk-local-test`

首次运行会自动创建 `data/config.json`。安全示例配置在 `data/config.example.json`。

## 构建前端

```bash
npm install
npm --prefix ui ci
npm run build:ui
```

`npm run build:ui` 会构建 React UI，并把单文件产物复制到 `public/index.html`。

## 发布构建

创建并发布 GitHub Release 会触发 GitHub Actions。工作流会构建以下可执行文件，并上传到同一个 Release 的附件下：

- `hydrallm-windows-amd64.exe`
- `hydrallm-windows-arm64.exe`
- `hydrallm-linux-amd64`
- `hydrallm-linux-arm64`
- `hydrallm-macos-amd64`
- `hydrallm-macos-arm64`

发布新版本：

1. 把源码推送到 `main`。
2. 在 GitHub 创建并发布 Release，例如 `v0.1.0`。
3. 等待 `Build Executables` 工作流完成。
4. 在 Release 附件中下载对应系统和架构的可执行文件。

## Docker

发布 GitHub Release 也会构建并推送多架构 Docker 镜像到：

```text
ghcr.io/clockclock1/hydrallm
```

支持的平台：

- `linux/amd64`
- `linux/arm64`

拉取镜像：

```bash
docker pull ghcr.io/clockclock1/hydrallm:latest
```

运行：

```bash
docker run --rm -p 8787:8787 -v hydrallm-data:/app/data ghcr.io/clockclock1/hydrallm:latest
```

## 编排部署

部署文件位于 `deploy/`，只使用 GHCR 中已经编译好的 Docker 镜像，不会本地构建镜像。

Docker Compose：

```bash
cd deploy/compose
cp .env.example .env
# 发布 Release 后把 HYDRALLM_VERSION 改成 v0.1.0 等版本号
# 如需自定义宿主机端口，把 HYDRALLM_PORT 改成 18080 等端口
docker compose up -d
```

Compose 默认映射为 `8787:8787`。如果在 `.env` 中设置 `HYDRALLM_PORT=18080`，访问地址就是 `http://127.0.0.1:18080`，容器内部端口仍然是 `8787`。

Compose 默认把数据保存到 clone 下来的项目目录 `deploy/compose/data`，并自动创建 `hydrallm-network` 网络。可以在 `.env` 中通过 `HYDRALLM_DATA_DIR` 和 `HYDRALLM_NETWORK` 修改。

Kubernetes：

```bash
cd deploy/kubernetes
kustomize edit set image ghcr.io/clockclock1/hydrallm=ghcr.io/clockclock1/hydrallm:v0.1.0
kubectl apply -k .
```

更多细节见 `deploy/README.md`。

## 配置模型

每个公开模型会映射到一组有序上游：

```json
{
  "publicName": "gpt-failover",
  "enabled": true,
  "targets": [
    {
      "name": "primary",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "modelName": "gpt-4.1-mini",
      "enabled": true
    },
    {
      "name": "backup",
      "baseUrl": "https://backup.example.com/v1",
      "apiKey": "sk-...",
      "modelName": "gpt-4o-mini",
      "enabled": true
    }
  ]
}
```

模型源模式会从自定义 URL 拉取模型 ID，并为每个拉取到的模型创建运行时路由。上游模型模板支持 `{model}`。

默认熔断策略是单个上游连续失败 3 次后禁用 10 分钟；这两个值可在管理界面侧边栏修改并保存到 `data/config.json` 的 `circuitBreaker.failureThreshold` 和 `circuitBreaker.cooldownMinutes`。如果某条转移链的所有上游都处于熔断状态，代理会自动解除该链的熔断并重新尝试整条链。

故障转移发生在向客户端返回响应之前。流式响应一旦开始输出，代理无法在中途切换上游，因为字节已经发送给客户端。

---

## English

HydraLLM is an OpenAI-compatible LLM failover proxy with a visual management UI. It exposes custom API keys and OpenAI-style endpoints while routing one or many public model names through ordered upstream failover targets.

## Features

- OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/completions`
- The same endpoints also work without the `/v1` prefix.
- Visual React management UI.
- Custom proxy API keys.
- Fixed public model aliases.
- Model-source mode: pull many model names from a custom `/v1/models` URL and apply one failover target group to all fetched models.
- Streaming, tool calls, response formats, and multimodal request bodies are passed through unchanged.
- Persistent local config in `data/config.json`.
- Provider health checks refresh the online-provider status in the management UI on a timer.
- Per-upstream circuit breaking temporarily disables repeatedly failing targets; the failure threshold and cooldown minutes are configurable in the UI.
- GitHub Release builds standalone executables for Windows, Linux, and macOS on amd64 and arm64.
- GitHub Release builds and pushes a multi-arch Docker image to GitHub Packages / GHCR.

## Local Start

```powershell
.\start.ps1
```

Defaults:

- Admin UI: `http://127.0.0.1:8787`
- External bind: `0.0.0.0:8787`
- Default admin token: `admin`
- Default proxy key: `sk-local-test`

The first run creates `data/config.json` automatically. A safe template is included at `data/config.example.json`.

## Build UI

```bash
npm install
npm --prefix ui ci
npm run build:ui
```

`npm run build:ui` builds the React UI and copies the single-file output to `public/index.html`.

## Release Builds

Publishing a GitHub Release triggers GitHub Actions. The workflow builds these executables and uploads them to the same Release:

- `hydrallm-windows-amd64.exe`
- `hydrallm-windows-arm64.exe`
- `hydrallm-linux-amd64`
- `hydrallm-linux-arm64`
- `hydrallm-macos-amd64`
- `hydrallm-macos-arm64`

To publish a new version:

1. Push source changes to `main`.
2. Create and publish a GitHub Release such as `v0.1.0`.
3. Wait for the `Build Executables` workflow.
4. Download the binaries from the Release assets.

## Docker

Publishing a GitHub Release also builds and pushes a multi-arch Docker image to:

```text
ghcr.io/clockclock1/hydrallm
```

Supported platforms:

- `linux/amd64`
- `linux/arm64`

Pull:

```bash
docker pull ghcr.io/clockclock1/hydrallm:latest
```

Run:

```bash
docker run --rm -p 8787:8787 -v hydrallm-data:/app/data ghcr.io/clockclock1/hydrallm:latest
```

## Orchestrated Deployment

Deployment manifests are in `deploy/`. They use the prebuilt Docker image from GHCR and do not build images locally.

Docker Compose:

```bash
cd deploy/compose
cp .env.example .env
# after publishing a Release, set HYDRALLM_VERSION to v0.1.0 or another tag
# to customize the host port, set HYDRALLM_PORT to 18080 or another port
docker compose up -d
```

Compose maps `8787:8787` by default. If `.env` sets `HYDRALLM_PORT=18080`, open `http://127.0.0.1:18080`; the container port remains `8787`.

Compose stores data in the cloned project folder at `deploy/compose/data` by default and automatically creates the `hydrallm-network` network. You can customize them with `HYDRALLM_DATA_DIR` and `HYDRALLM_NETWORK` in `.env`.

Kubernetes:

```bash
cd deploy/kubernetes
kustomize edit set image ghcr.io/clockclock1/hydrallm=ghcr.io/clockclock1/hydrallm:v0.1.0
kubectl apply -k .
```

See `deploy/README.md` for details.

## Configuration Model

Each public model maps to ordered targets:

```json
{
  "publicName": "gpt-failover",
  "enabled": true,
  "targets": [
    {
      "name": "primary",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "modelName": "gpt-4.1-mini",
      "enabled": true
    },
    {
      "name": "backup",
      "baseUrl": "https://backup.example.com/v1",
      "apiKey": "sk-...",
      "modelName": "gpt-4o-mini",
      "enabled": true
    }
  ]
}
```

In model-source mode, the proxy fetches model IDs from a custom URL and creates runtime routes for every fetched model. Target model templates support `{model}`.

By default, a single upstream target is disabled for 10 minutes after 3 consecutive failures. Both values can be changed in the UI sidebar and are saved to `circuitBreaker.failureThreshold` and `circuitBreaker.cooldownMinutes` in `data/config.json`. If every target in a failover chain is circuit-open, the proxy clears that chain and retries all targets.

Failover happens before returning a response to the client. After a streaming response has started, the proxy cannot switch providers mid-stream because bytes have already been sent to the client.
