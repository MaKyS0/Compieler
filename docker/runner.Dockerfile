# Sandbox image: every user command (pip/npm install, g++, python, node) runs in a throw-away
# container created from this image. Keep it free of secrets.
# Override NODE_IMAGE to take Node.js from another image/registry mirror.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS node

FROM python:3.12-slim-bookworm
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=0

RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ gcc make cmake libc6-dev \
        bash coreutils procps ca-certificates git curl \
        libffi-dev libssl-dev zlib1g-dev libjpeg-dev libfreetype6-dev libxml2-dev libxslt1-dev libopenblas-dev gfortran pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 + npm from the official image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Optional: pre-install heavy scientific packages once for every project
# (projects use venvs with --system-site-packages, so these are visible without reinstalling).
ARG PRELOAD_PACKAGES=""
RUN if [ -n "$PRELOAD_PACKAGES" ]; then pip install --no-cache-dir $PRELOAD_PACKAGES; fi

RUN useradd --uid 10001 --create-home --home-dir /home/runner --shell /bin/bash runner \
 && mkdir -p /work /cache && chown runner:runner /work /cache
USER 10001:10001
WORKDIR /work
CMD ["bash"]
