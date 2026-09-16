# Hyperbay seedbox / gateway image.
#
# The app runs on Bare, not Node. Node is present only to drive npm during the
# build; the runtime entrypoint is the `bare` binary that ships with the
# bare-runtime package. Native addons (rocksdb-native, sodium-native,
# udx-native) resolve prebuilds for the *target* platform, so this image must be
# built with --platform matching where it runs.

FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Only the manifests, so dependency layers survive source edits.
COPY package.json package-lock.json ./

# `npm ci --omit=dev` keeps brittle (the test harness) out of the image.
RUN npm ci --omit=dev --no-audit --no-fund

# The app is a Bare program, so the image has to carry the Bare runtime itself.
# Kept out of package.json deliberately: locally `bare` comes from a global
# install, and pinning it here keeps the image reproducible without making the
# library depend on a particular runtime build.
RUN npm i --no-save --omit=dev --no-audit --no-fund bare-runtime@1.33.3

FROM node:22-bookworm-slim AS runtime

# rocksdb-native's prebuild links libatomic, which the slim base does not ship;
# without it the addon fails to load and the node cannot open its corestore.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libatomic1 && \
    rm -rf /var/lib/apt/lists/*

ENV HYPERBAY_STORAGE=/data \
    HYPERBAY_PORT=8433 \
    HYPERBAY_HOST=0.0.0.0

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY ui ./ui
COPY worker.js ./worker.js

# bare-runtime/bin/bare is a Node shim that chmod()s the real binary on every
# start. That fails for any user that does not own /app — which is exactly what
# happens on Unraid, where containers conventionally run as 99:100. Mark the
# real binary executable once, at build time, and link it so the entrypoint
# never needs to write anything.
RUN set -eux; \
    bare_bin="$(ls -d /app/node_modules/bare-runtime-*/bin/bare | head -1)"; \
    chmod 0755 "$bare_bin"; \
    ln -sf "$bare_bin" /usr/local/bin/bare; \
    bare -e 'console.log("bare " + Bare.version + " " + Bare.platform + "-" + Bare.arch)'

# Storage is a volume: the corestore, the identity keypair and config.json all
# live here, so losing it means losing this peer's identity and its bay.
# World-readable app tree so the image also runs under --user <uid>:<gid>.
RUN mkdir -p /data && \
    useradd --system --uid 10001 --home-dir /data hyperbay && \
    chown -R hyperbay:hyperbay /data && \
    chmod -R a+rX /app
USER hyperbay

VOLUME ["/data"]
EXPOSE 8433/tcp

# The gateway is the only thing with a health surface. The swarm needs no port
# mapping: Hyperswarm dials out and holepunches.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HYPERBAY_PORT||8433)+'/api/state').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["bare", "bin/hyperbay.js"]
CMD ["serve"]
