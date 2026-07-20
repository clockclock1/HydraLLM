# syntax=docker/dockerfile:1.7
FROM debian:stable-slim
ARG TARGETARCH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 dist/hydrallm-linux-${TARGETARCH} /usr/local/bin/hydrallm
COPY data/config.example.json /app/data/config.example.json
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
VOLUME ["/app/data"]
ENTRYPOINT ["hydrallm"]
