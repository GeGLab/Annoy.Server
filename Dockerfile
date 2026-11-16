# Annoy server: one process for REST, gateway and voice (SFU).
#
# Two stages: dependencies are installed with a fallback compiler, and only their result goes
# into the runtime image. Debian 13 (trixie): mediasoup's prebuilt worker runs there, so npm ci
# downloads it instead of compiling the C++ worker from source (tens of minutes on bookworm,
# whose system libraries are too old for the prebuilt binary).

FROM node:24-trixie-slim AS deps
# Fallback toolchain in case mediasoup has no prebuilt worker for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Only the manifests: a change in the protocol's source must not reinstall every dependency.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev

FROM node:24-trixie-slim
# git for code channels.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
COPY src src
COPY scripts scripts

ENV ANNOY_DATA_DIR=/data \
    ANNOY_PORT=8787 \
    ANNOY_VOICE_PORT=40000
RUN install -d -o node -g node -m 0700 /data
USER node
VOLUME /data
EXPOSE 8787/tcp 40000/udp 40000/tcp

CMD ["node_modules/.bin/tsx", "src/index.ts"]
