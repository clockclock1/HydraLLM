# HydraLLM

HydraLLM is an OpenAI-compatible LLM failover proxy with a visual management UI.

It exposes custom API keys and OpenAI-style endpoints while routing one or many public model names through ordered upstream failover targets. Streaming, tool calls, response formats, and multimodal request bodies are passed through unchanged.

## Features

- OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/completions`
- Same endpoints also work without the `/v1` prefix.
- Visual React management UI from `model-failover-proxy-ui`.
- Custom proxy API keys.
- Fixed public model aliases.
- Model-source mode: pull many model names from a custom `/v1/models` URL and apply one failover target group to all fetched models.
- Persistent local config in `data/config.json`.
- GitHub Actions build standalone executables for Windows, Linux, and macOS on amd64 and arm64.
- GitHub Actions build and push a multi-arch Docker image to GitHub Packages / GHCR.

## Local Start

```powershell
.\start.ps1
```

Default URL:

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

Publishing a GitHub Release triggers GitHub Actions. The workflow builds these executables and uploads them to that same Release:

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

Build locally:

```bash
docker build -t hydrallm .
docker run --rm -p 8787:8787 -v hydrallm-data:/app/data hydrallm
```

Publishing a GitHub Release also builds and pushes a multi-arch Docker image to:

```text
ghcr.io/clockclock1/hydrallm
```

Supported image platforms:

- `linux/amd64`
- `linux/arm64`

Pull:

```bash
docker pull ghcr.io/clockclock1/hydrallm:latest
```

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

Failover happens before returning a response to the client. After a streaming response has started, the proxy cannot switch providers mid-stream because bytes have already been sent to the client.
