# ---- build the frontend -------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend ------------------------------------------------------------------------
FROM node:22-bookworm-slim AS node
FROM docker:27-cli AS dockercli

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends clang-format ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && npm install -g prettier@3 --no-audit --no-fund && ln -sf ../lib/node_modules/prettier/bin/prettier.cjs /usr/local/bin/prettier
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt black ruff
COPY backend/app ./app
COPY --from=frontend /src/dist /app/static

ENV COMPIELER_STATIC_DIR=/app/static COMPIELER_DATA_DIR=/data COMPIELER_ENV=prod
EXPOSE 8000
# One worker: run registry, rate limiter and concurrency counters live in process memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
