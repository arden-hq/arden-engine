# Disposable validation/runtime image. Record the resolved image digest with results.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.10
WORKDIR /opt/arden
COPY runtime.tar.gz /tmp/runtime.tar.gz
RUN tar -xzf /tmp/runtime.tar.gz -C /opt/arden && rm /tmp/runtime.tar.gz && sh benchmarks/install.sh
ENV ARDEN_BENCH_NODE=/usr/local/bin/node
WORKDIR /workspace
