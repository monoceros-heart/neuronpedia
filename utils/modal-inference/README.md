# Inference on Modal

`inference_host.py` runs `apps/inference`, unchanged, as a scale-to-zero
[Modal](https://modal.com) web endpoint, so a local webapp can offer the Test
box and steering for a model too large for the machine it runs on. It reads
one of the repo-root `.env.inference.<model>.<sourceset>` files, the same ones
`make inference-dev` uses.

```bash
modal token new                     # once, if ~/.modal.toml has no token
make local-secret                   # the endpoint is public, so it needs a secret of its own
make inference-modal-deploy MODEL_SOURCESET=qwen3-8b.neurons          # prints the URL
make host-add SERVICE=INFERENCE MODEL=qwen3-8b SOURCE_SETS=neurons URL=<that URL>
make source-set-update ...          # turn inference on for the set, if model-add did not
```

- **GPU**: `GPU=L4` by default (Qwen3-8B in bf16 needs about 16 GB). A config with
  `DEVICE=cpu`, such as `qwen3-0.6b.neurons`, gets 8 CPUs and no GPU.
- **Secret**: the webapp's `INFERENCE_SERVER_SECRET` from
  `apps/webapp/.env.localhost.local` goes to Modal as a secret on the app. Every
  path checks it, `/health` included. The target refuses the public default
  `localhost-secret`. After `make local-secret ROTATE=1`, deploy again.
- **Cold starts**: the container stops after 15 idle minutes
  (`NP_INFERENCE_SCALEDOWN`, in seconds). The next request waits while it loads
  the model, about a minute once the weights are cached, longer on the very first
  start, which downloads them into the `neuronpedia-hf-cache` Volume
  (`NP_INFERENCE_VOLUME`). The webapp's own deadline for a non-streaming call is
  `INFERENCE_REQUEST_TIMEOUT_MS` (300000 in `.env.localhost`; 60 s if unset), so
  it waits out a cold start instead of failing the first request.
- **Only the config's own keys** go to Modal. The repo-root `.env`, which holds
  personal keys, is not sent. A gated model would need `HF_TOKEN` added to the
  script's allowed keys and a Modal secret.
- **Client**: the targets run Modal through `uvx` (`MODAL_CLI`), so no project gains
  a dependency. Behind an HTTP proxy, point `MODAL_CLI` at a client installed
  with the `modal[api-proxy-support]` extra.
- **Stopping**: `make inference-modal-stop MODEL_SOURCESET=...`, then
  `make host-remove SERVICE=INFERENCE URL=...`, so the webapp stops sending it work.
