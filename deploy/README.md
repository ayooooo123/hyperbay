# Deploying Hyperbay on Unraid

The container is a full peer, not a client. It seeds what it holds and serves
the HTTP bridge so ordinary tools can read from the swarm.

## Build

The app runs on Bare and the native addons resolve prebuilds for the *target*
platform, so the image must be built for where it runs. Unraid is `linux/amd64`:

```sh
docker buildx build --platform linux/amd64 -t hyperbay:local .
```

Two things the image needs that are easy to miss:

- **`libatomic1`** — `rocksdb-native`'s prebuild links it and the slim Node base
  does not ship it. Without it the addon fails to load and the node cannot open
  its corestore.
- **the Bare runtime** — it is not a project dependency (locally `bare` is a
  global install), so the Dockerfile installs a pinned `bare-runtime` and the
  entrypoint calls `node_modules/bare-runtime/bin/bare` directly. `npm i
  --no-save` does not create the `node_modules/.bin` shim.

## Deploy — registry

Push the image, then use either the compose file or the Unraid template:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/ayooooo123/hyperbay:latest --push .
```

Pushing to GHCR needs a token with `write:packages` (the default `gh` token does
not have it):

```sh
gh auth refresh -h github.com -s write:packages
gh auth token | docker login ghcr.io -u <user> --password-stdin
```

Then on Unraid, either:

```sh
# Compose Manager plugin, or plain docker compose over ssh
docker compose -f deploy/docker-compose.yml up -d
```

or copy `deploy/unraid-hyperbay.xml` to
`/boot/config/plugins/dockerMan/templates-user/my-hyperbay.xml` and add the
container from the Docker tab.

## Deploy — no registry

If you would rather not publish the image, ship it over SSH:

```sh
docker buildx build --platform linux/amd64 -t hyperbay:local --load .
docker save hyperbay:local | gzip | ssh unraid 'gunzip | docker load'

ssh unraid 'docker run -d --name hyperbay --restart unless-stopped \
  --network host \
  -e HYPERBAY_HOST=0.0.0.0 -e HYPERBAY_PORT=8433 -e HYPERBAY_STORAGE=/data \
  -v /mnt/user/appdata/hyperbay:/data \
  hyperbay:local'
```

## Networking

Host networking is the default here. Hyperswarm holepunches over UDP; a peer on
Docker's bridge works but reaches fewer peers and re-punches more often. Nothing
needs port forwarding — the swarm dials out.

Only the gateway port (8433) is inbound, and only if you want the UI or the
bridge from another machine.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HYPERBAY_STORAGE` | `/data` | Corestore, identity keypair, config |
| `HYPERBAY_PORT` | `8433` | HTTP bridge + web UI |
| `HYPERBAY_HOST` | `0.0.0.0` | Bind address |
| `HYPERBAY_CATALOG` | *(unset)* | Join an existing bay by catalog key |

Flags still win over the environment, so
`docker run ... hyperbay:local serve --port 9000` overrides `HYPERBAY_PORT`.

## After it starts

```sh
curl -s http://TOWER_IP:8433/api/state          # catalog key, peers, seeding
curl -s http://TOWER_IP:8433/api/catalog        # the key to share
curl -O http://TOWER_IP:8433/f/<owner>/<name>/<file>
```

Back up `/mnt/user/appdata/hyperbay`. It holds this peer's ed25519 identity —
lose it and the node cannot update anything it published, because a publisher
can only rewrite records it signed.

## Security

The gateway has **no authentication** and it can publish, seed, import and
delete on this node's behalf. Keep it on a trusted network, or put it behind a
reverse proxy that does auth. Do not expose 8433 to the internet.
