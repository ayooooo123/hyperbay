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

## Deploy — registry (the normal path)

CI publishes the image, so there is nothing to build by hand. Every push to
`main` runs the suite, builds `linux/amd64` and `linux/arm64`, smoke tests the
amd64 image, and assembles a manifest list:

```
ghcr.io/ayooooo123/hyperbay:latest
ghcr.io/ayooooo123/hyperbay:main
ghcr.io/ayooooo123/hyperbay:<short sha>
ghcr.io/ayooooo123/hyperbay:<version>   # on a v* tag
```

The workflow uses its own `GITHUB_TOKEN`, which carries `packages: write` — so
publishing needs no personal access token. (A local `docker push` to GHCR does:
the default `gh` token has no `write:packages`, and `gh auth refresh -h
github.com -s write:packages` is the only way to add it.) The package is public
because the repo is, so the tower pulls it without logging in.

On Unraid, either:

```sh
# Compose Manager plugin, or plain docker compose over ssh
docker compose -f deploy/docker-compose.yml up -d
```

or copy `deploy/unraid-hyperbay.xml` to
`/boot/config/plugins/dockerMan/templates-user/my-hyperbay.xml` and add the
container from the Docker tab.

Updating is then just:

```sh
ssh unraid 'docker pull ghcr.io/ayooooo123/hyperbay:latest && docker restart hyperbay'
```

The data volume is untouched by an image change, so the peer keeps its identity
and its bay across upgrades.

## Deploy — no registry

This is what was actually used for the first deployment. No registry needed:

```sh
docker buildx build --platform linux/amd64 -t hyperbay:0.1.0 --load .
docker save hyperbay:0.1.0 | gzip -1 | ssh unraid 'gunzip | docker load'

# The image runs as uid 10001; Unraid keeps appdata as nobody:users. Run as
# 99:100 and make the directory writable by it, or the node cannot write
# /data/identity.json and exits immediately.
ssh unraid 'mkdir -p /mnt/user/hyperbay && chown -R 99:100 /mnt/user/hyperbay'

ssh unraid 'docker run -d --name hyperbay --restart unless-stopped \
  --network host --user 99:100 \
  -e HYPERBAY_HOST=0.0.0.0 -e HYPERBAY_PORT=8433 -e HYPERBAY_STORAGE=/data \
  -v /mnt/user/hyperbay:/data \
  hyperbay:0.1.0'
```

## Networking

Host networking is the default here. Hyperswarm holepunches over UDP; a peer on
Docker's bridge works but reaches fewer peers and re-punches more often. Nothing
needs port forwarding — the swarm dials out.

Only the gateway port (8433) is inbound, and only if you want the UI or the
bridge from another machine.

### When a peer will not connect: check the egress path, not the firewall

Outbound UDP is all the swarm needs to reach the wider network, and the deployed
node bootstraps the DHT fine — it learns its public address and fills a routing
table.

Two peers on the same segment connect immediately: a second container on the
tower joined the deployed bay, replicated the index and pulled a 5 MB artifact
byte-identical in under a second.

A peer on another local subnet is where it gets interesting, and the obvious
diagnosis is usually wrong. On this network the tower sits on `10.0.40.0/24` and
a laptop on `10.0.10.0/24`. No Hyperswarm connection ever forms. It is tempting
to blame inter-VLAN filtering; measured, that was not it:

- The router already passed everything needed in that direction.
- `tcpdump` on both VLAN interfaces, filtered to the two hosts, caught **zero**
  packets out of ~1.9M during live joins. Nothing was being dropped because
  nothing was being sent.
- A DHT lookup of the bay's topic from the laptop returned the tower with relay
  addresses, so discovery was working the whole time.

The actual cause was the **egress path**. The tower left via WAN
(`107.194.4.98`); the laptop left via a commercial VPN (`178.249.211.77`).
`hyperdht` only attempts its LAN shortcut when both peers appear behind the
*same* public address (`lib/connect.js`, the `clientAddress.host ===
serverAddress.host` guard), so with two different public addresses it never
tries the local path at all — and a holepunch between a commercial VPN exit and
a home WAN, both ends `firewalled: true`, is the case least likely to work:
that NAT is typically symmetric and drops unsolicited inbound UDP.

So before writing firewall rules, check:

```sh
curl -s https://api.ipify.org          # on each peer
```

If those differ because one peer is on a VPN, no firewall rule will help. Either
give both peers the same egress, or accept that they will not be direct peers.

**Not being a peer is not the same as losing access.** The HTTP bridge works
across subnets over plain TCP, so a machine that cannot join the swarm can
still:

- browse the catalog and search it — `GET /api/artifacts`
- download any file, with `Range` so transfers resume — `GET /f/<slug>/<path>`
- **add content to the bay** by having a real peer do the mirroring for it —
  `POST /api/import {"repo":"owner/name"}` fetches from Hugging Face on the
  *node*, so the caller needs no local copy and no swarm connectivity. Verified
  from a VPN'd laptop: it drove the tower into mirroring a 9-file, 12.5 MB repo
  which the tower then seeds.
- join a different bay — `POST /api/catalog {"key":"…"}`

The one thing it cannot do is seed, and note that `POST /api/publish` takes a
directory path **on the node**, not on the caller — so publishing your own local
folder does need to run on a machine that is a peer (or the files have to reach
the node first).

## Storage: use the array, not the cache

A bay grows to the size of the weights it mirrors, so it does not belong on
`appdata`. Unraid ships `appdata` as `shareUseCache="only"`, which pins it to
the cache pool — here that is a 3.7 TB SSD, against 28 TB free on the array.

So Hyperbay gets its own share with the cache turned off, exactly like `Media`:

```sh
# /boot/config/shares/hyperbay.cfg
shareUseCache="no"     # array only, never the cache pool
shareCachePool=""
shareAllocator="highwater"
```

```sh
mkdir -p /mnt/user/hyperbay && chown 99:100 /mnt/user/hyperbay
```

Confirm it really landed on the array rather than trusting the setting:

```sh
dd if=/dev/urandom of=/mnt/user/hyperbay/.t bs=1M count=8 && sync
ls /mnt/cache/hyperbay        # must not exist
ls -d /mnt/disk*/hyperbay     # this is where it should be
rm /mnt/user/hyperbay/.t
```

### Moving an existing bay between filesystems

A corestore cannot simply be copied. `cores/CORESTORE` is a device file that
records its own inode, and on start the store checks it:

```
error: Invalid device file, was modified
```

That guard exists so two copies of the same store cannot be run at once — which
would be two peers with one identity. To migrate deliberately: stop the
container, copy the directory, **delete `cores/CORESTORE`** so it regenerates,
start, and then *delete the old copy* rather than leaving it around.

```sh
docker stop hyperbay
cp -a /mnt/user/appdata/hyperbay/. /mnt/user/hyperbay/
rm -f /mnt/user/hyperbay/cores/CORESTORE
chown -R 99:100 /mnt/user/hyperbay
# rebind the container to /mnt/user/hyperbay, verify the identity and catalog
# key are unchanged, then:
rm -rf /mnt/user/appdata/hyperbay
```

The identity lives in `identity.json` and the bay in `cores/db`, so both
survive the move; only the inode guard needs resetting.

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

Back up `/mnt/user/hyperbay`. It holds this peer's ed25519 identity —
lose it and the node cannot update anything it published, because a publisher
can only rewrite records it signed.

## Security

The gateway has **no authentication** and it can publish, seed, import and
delete on this node's behalf. Keep it on a trusted network, or put it behind a
reverse proxy that does auth. Do not expose 8433 to the internet.
