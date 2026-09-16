# Hyperbay

[![ci](https://github.com/ayooooo123/hyperbay/actions/workflows/ci.yml/badge.svg)](https://github.com/ayooooo123/hyperbay/actions/workflows/ci.yml)

A bay for open model weights that nobody owns.

Sites that mirror open model weights are still one host, one index, one domain.
Take the host down and the mirror is gone. Hyperbay keeps the same job — find a
model, check its license, pull the files, trust the hashes — and removes the
server.

- The **index** is an [Autobase](https://github.com/holepunchto/autobase):
  many writers, one eventually consistent [Hyperbee](https://github.com/holepunchto/hyperbee)
  view. Every peer holds the index and can answer searches.
- The **weights** are one [Hyperdrive](https://github.com/holepunchto/hyperdrive)
  per artifact. Downloading is sparse, resumable and verified block by block.
- **Discovery** is [Hyperswarm](https://github.com/holepunchto/hyperswarm) on the
  DHT. Holepunching means a home machine can seed without port forwarding.
- Every peer that downloads can **seed**. More demand means more mirrors.

Runs on [Bare](https://github.com/holepunchto/bare). There is no Node.js here.

## Install

```sh
npm install          # dependencies only; Bare runs the code
```

## Use it

```sh
# start the node, the local gateway and the UI
bare bin/hyperbay.js serve --open

# join someone else's bay
bare bin/hyperbay.js serve --catalog <catalog-key>

# put a local folder of weights into the bay
bare bin/hyperbay.js publish ./my-model --owner me --name my-model --license mit

# mirror a public Hugging Face repo into the bay
bare bin/hyperbay.js import Qwen/Qwen3-8B

# pull an artifact out of the swarm and check every hash
bare bin/hyperbay.js get qwen/qwen3-8b ./out

# run as a headless seedbox
bare bin/hyperbay.js seed qwen/qwen3-8b

# search, inspect, verify
bare bin/hyperbay.js search gguf 8b
bare bin/hyperbay.js info qwen/qwen3-8b
bare bin/hyperbay.js verify qwen/qwen3-8b
```

Desktop app:

```sh
pear run --dev .
```

The window is Chromium; the peer itself runs in a Bare worker (`worker.js`)
because a Chromium renderer has no Bare runtime and cannot hold a Hypercore.
The window drives the worker over its pipe, so the UI needs no daemon and no
HTTP round trip. The worker still opens a loopback gateway on a spare port,
which is what keeps `curl` and `huggingface-cli` working against the desktop
app from a terminal.

Paste someone's catalog key into **Network → Join a bay** and the node starts
replicating their index, keeping its own identity and everything it seeds.

## Existing tools keep working

`serve` exposes a local bridge, so anything that speaks HTTP can read from the
swarm:

```sh
# raw file
curl -O http://127.0.0.1:8433/f/qwen/qwen3-8b/model.gguf

# huggingface_hub compatible path
HF_ENDPOINT=http://127.0.0.1:8433 huggingface-cli download qwen/qwen3-8b
```

The bridge streams straight out of the Hyperdrive. It supports `Range`, so a
broken transfer resumes instead of restarting.

## Run it as a seedbox

```sh
docker run -d --name hyperbay --restart unless-stopped --network host \
  --user 99:100 \
  -e HYPERBAY_HOST=0.0.0.0 \
  -v /mnt/user/hyperbay:/data \
  ghcr.io/ayooooo123/hyperbay:latest
```

CI builds and publishes `linux/amd64` and `linux/arm64` on every push to
`main`, so there is nothing to build by hand. Updating is
`docker pull … && docker restart hyperbay`; the data volume is untouched, so the
peer keeps its identity and its bay.

Configuration is by flag or environment (`HYPERBAY_STORAGE`, `HYPERBAY_PORT`,
`HYPERBAY_HOST`, `HYPERBAY_CATALOG`); flags win. Host networking is the default
because Hyperswarm holepunches over UDP and nothing needs forwarding.

Put the data on storage that can grow — a bay is as large as the weights it
mirrors. On Unraid that means a share with the cache turned off, not `appdata`.

`deploy/` has a compose file, an Unraid template and the full notes —
`deploy/README.md`.

The gateway has no authentication and can publish, seed and delete on the
node's behalf. Keep it on a trusted network.

## Trust

- Every catalog op is signed with the publisher's ed25519 key. `apply` verifies
  the signature before touching the view, so a forged record cannot enter the
  index on any peer.
- Publishing is open. The base is optimistic: any peer can append a valid signed
  op. Indexers only provide ordering quorum, they do not decide who may publish.
- Spam has a deterministic ceiling, not a moderator: `apply` counts a
  publisher's records in the view and stops at the quota. Every peer computes
  the same answer.
- A publisher can only change records it signed. Anyone else publishing the same
  slug is recorded as an extra mirror, so re-hosting someone's model can never
  rewrite their metadata or license.
- Integrity is checked twice: Hypercore verifies every block against the merkle
  tree while it transfers, and the manifest carries the upstream SHA-256 per
  file, so `verify` proves a mirror matches the origin.
- Gated or private upstream repos are refused, never worked around.

## Layout

```
lib/schema.js      keyspace, validation, canonical form  (pure, deterministic)
lib/trust.js       identity, op signing, verification
lib/hash.js        streaming SHA-256
lib/catalog.js     the index: Autobase + Hyperbee view
lib/drives.js      the bytes: Hyperdrive publish, seed, download, verify
lib/node.js        one object wiring store, swarm, catalog and drives
lib/gateway.js     HTTP bridge, REST API, SSE, UI hosting
lib/api.js         one API surface, two transports (in-process and HTTP)
lib/import/hf.js   mirror a public Hugging Face repo
worker.js          the desktop peer, run on Bare by the Pear app
ui/                the interface, shared by the desktop app and the browser
bin/hyperbay.js    CLI
```

`docs/ARCHITECTURE.md` has the full contract, the keyspace and the op format.

## Test

```sh
bare test/all.js
```

The suite publishes real weights, replicates them between two independent
peers, verifies every hash, checks that a second publisher cannot rewrite
someone else's record, checks that two peers seeding one drive both count as
mirrors, pulls a file back through the HTTP bridge with a `Range` request, and
joins one node's bay from another.
