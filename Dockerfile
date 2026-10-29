# Annoy server: one process for REST, gateway and voice (SFU).
FROM node:24-bookworm-slim

# Fallback toolchain in case mediasoup has no prebuilt worker for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
RUN npm ci --omit=dev

COPY src src

ENV ANNOY_DATA_DIR=/data \
    ANNOY_PORT=8787 \
    ANNOY_VOICE_PORT=40000
VOLUME /data
EXPOSE 8787/tcp 40000/udp 40000/tcp

CMD ["node_modules/.bin/tsx", "src/index.ts"]
