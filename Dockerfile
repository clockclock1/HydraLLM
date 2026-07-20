FROM rust:1-slim AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config ca-certificates && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY assets ./assets
RUN cargo build --release

FROM debian:stable-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/hydrallm /usr/local/bin/hydrallm
COPY data/config.example.json /app/data/config.example.json
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
VOLUME ["/app/data"]
ENTRYPOINT ["hydrallm"]
