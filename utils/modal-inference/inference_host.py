"""Neuronpedia's inference server as a scale-to-zero Modal web endpoint.

A local webapp serves the Test box and steering through whatever inference host is registered
for a model. For a model too big for this machine (Qwen3-8B wants ~16 GB of GPU memory), this
runs `apps/inference` unchanged on a Modal GPU instead, configured from one of the repo-root
`.env.inference.<model>.<sourceset>` files, and gives back an https URL to register with
`make host-add`.

Run it through make, which supplies the config and the shared secret:

    make inference-modal-deploy MODEL_SOURCESET=qwen3-8b.neurons          # GPU from GPU=, default L4
    make inference-modal-deploy MODEL_SOURCESET=qwen3-0.6b.neurons        # DEVICE=cpu configs get no GPU
    make inference-modal-stop MODEL_SOURCESET=qwen3-8b.neurons

The endpoint is public, so every request must carry the webapp's `X-SECRET-KEY`
(`SecretKeyMiddleware` checks every path, `/health` included). The make target refuses the
repo's public default secret; run `make local-secret` first. Model weights are cached in a
Modal Volume (NP_INFERENCE_VOLUME, default `neuronpedia-hf-cache`), so only the first start
downloads them.
"""

import os
import re
import subprocess
from pathlib import Path

import modal

PORT = 5002
# The repo root, two levels up; only meaningful on the machine that deploys (the container has /root/inference_host.py).
REPO = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/np")
# Container scales to zero after this many idle seconds; the next request waits for a cold start.
SCALEDOWN_SECONDS = int(os.environ.get("NP_INFERENCE_SCALEDOWN", "900"))
# What a cold start may take: image pull, a first weight download, and loading the model.
STARTUP_SECONDS = 20 * 60
# Only these keys are read from the config file. The repo-root .env (personal API keys) is not
# shipped to Modal; Qwen3 is ungated, so no HF_TOKEN is needed.
CONFIG_KEYS = (
    "MODEL_ID",
    "OVERRIDE_MODEL_ID",
    "CUSTOM_HF_MODEL_ID",
    "MODEL_DTYPE",
    "SAE_DTYPE",
    "SAE_SETS",
    "NEURON_SETS",
    "INCLUDE_SAE",
    "EXCLUDE_SAE",
    "DEVICE",
    "FORCE_BACKEND",
    "TOKEN_LIMIT",
    "MAX_LOADED_SAES",
)


def read_config(name: str) -> dict[str, str]:
    """The settings in .env.inference.<name>, as the shell would read them: KEY=value, quotes stripped."""
    path = REPO / f".env.inference.{name}"
    if not path.is_file():
        raise SystemExit(f"{path.name} not found; `make inference-list-configs` lists the configs")
    env = {}
    for line in path.read_text().splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if not match:
            continue
        key, value = match[1], match[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        env[key] = value
    unknown = sorted(set(env) - set(CONFIG_KEYS))
    if unknown:
        raise SystemExit(f"{path.name}: not passed to Modal, add to CONFIG_KEYS if needed: {', '.join(unknown)}")
    return env


def label_for(name: str) -> str:
    """The endpoint's URL label: lowercase letters, digits and dashes, as Modal requires."""
    return "np-inference-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


if modal.is_local():
    CONFIG_NAME = os.environ.get("NP_INFERENCE_CONFIG", "")
    if not CONFIG_NAME:
        raise SystemExit("NP_INFERENCE_CONFIG is unset; run `make inference-modal-deploy MODEL_SOURCESET=...`")
    CONFIG = read_config(CONFIG_NAME)
    SECRET = os.environ.get("NP_INFERENCE_SECRET", "")
    if SECRET in ("", "localhost-secret"):
        raise SystemExit("this endpoint is public: run `make local-secret` so it has a secret of its own")
    GPU = None if CONFIG.get("DEVICE") == "cpu" else os.environ.get("NP_INFERENCE_GPU") or "L4"
else:
    # Inside the container the image's environment carries the config, and Modal supplies SECRET.
    CONFIG_NAME = os.environ["NP_INFERENCE_CONFIG"]
    CONFIG = {}
    SECRET = ""
    GPU = None

LABEL = label_for(CONFIG_NAME)
app = modal.App(LABEL)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install("uv")
    .add_local_dir(
        REPO / "apps" / "inference",
        "/np/apps/inference",
        copy=True,
        ignore=[".venv", "**/__pycache__", "logs", ".engine-linked"],
    )
    .run_commands("cd /np/apps/inference && uv sync --frozen --no-dev")
    .env({"NP_INFERENCE_CONFIG": CONFIG_NAME, "HF_HOME": "/cache/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1", **CONFIG})
)
volume = modal.Volume.from_name(os.environ.get("NP_INFERENCE_VOLUME", "neuronpedia-hf-cache"), create_if_missing=True)


@app.function(
    image=image,
    gpu=GPU,
    cpu=8 if GPU is None else 4,
    memory=32768,
    volumes={"/cache": volume},
    secrets=[modal.Secret.from_dict({"SECRET": SECRET})],
    scaledown_window=SCALEDOWN_SECONDS,
    timeout=60 * 60,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(PORT, startup_timeout=STARTUP_SECONDS, label=LABEL)
def serve() -> None:
    """Start the inference server and return once it reports healthy.

    The server binds its port before the model has loaded and answers 503 or 500 until then, so
    returning as soon as the port listens would hand a cold start's first requests those errors.
    Modal holds traffic until this returns.
    """
    import time
    import urllib.error
    import urllib.request

    proc = subprocess.Popen(
        ["uv", "run", "--no-sync", "python", "start.py", "--host", "0.0.0.0", "--port", str(PORT)],
        cwd="/np/apps/inference",
    )
    health = urllib.request.Request(f"http://127.0.0.1:{PORT}/health", headers={"X-SECRET-KEY": os.environ["SECRET"]})
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"inference server exited with code {proc.returncode}")
        try:
            with urllib.request.urlopen(health, timeout=5) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass  # not listening yet, or still loading (503)
        time.sleep(2)
    raise RuntimeError(f"inference server was not healthy after {STARTUP_SECONDS} s")
