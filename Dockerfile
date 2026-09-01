# Single container: Next.js UI + job worker + ffmpeg in one box.
#
# This tool cannot be serverless. A single assembly runs ffmpeg for minutes over
# ~1.5 GB of clips and emits an ~80 MB 1080x1920 file, and one video generation polls
# an external API for ~150s — all far past a serverless function's ceiling, and none
# of it possible without an ffmpeg binary and a writable disk.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 is a native module and needs a toolchain to build here; the build
# tools are left behind in this stage rather than shipped in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && npm ci \
 && apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Artifacts live on a mounted volume so work-in-progress survives a redeploy and the
# folder stays inspectable and prunable.
ENV DATA_ROOT=/data
RUN mkdir -p /data && chown -R node:node /data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Fonts and the brand logo are read at render time from the working directory.
COPY --from=builder /app/assets ./assets

USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
