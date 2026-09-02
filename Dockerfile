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
# HOSTNAME must be pinned to 0.0.0.0. Next's standalone server.js binds to
# process.env.HOSTNAME, and Docker sets that to the container id — so without this the
# server listens on that one interface only, boots cleanly, logs "Ready", and every
# request from the platform's proxy still fails with 502.
ENV HOSTNAME=0.0.0.0
# Artifacts live on a mounted volume so work-in-progress survives a redeploy and the
# folder stays inspectable and prunable.
ENV DATA_ROOT=/data
# Created so a local `docker run` without a volume still works; on Railway the
# attached volume is mounted over this path at runtime.
RUN mkdir -p /data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Fonts and the brand logo are read at render time from the working directory.
COPY --from=builder /app/assets ./assets

# No VOLUME directive: Railway rejects it outright ("docker VOLUME is not supported,
# use Railway Volumes") because it attaches its own volume at this mount path.
#
# Runs as root deliberately. Railway mounts the volume at /data owned by root, so a
# non-root process cannot write the SQLite file or any artifact into it — and dropping
# privileges after a startup chown needs gosu/su-exec, which would mean another package
# and a shell wrapper in front of PID 1. This is an internal tool on a trusted network,
# so the trade is not worth it.
EXPOSE 3000
CMD ["node", "server.js"]
