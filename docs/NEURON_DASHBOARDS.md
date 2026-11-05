# Neuron dashboard files

Raw MLP neurons are too many for database rows. Qwen3-32B alone has 64 × 25,600 of them. So their
dashboards are served as static files, and the browser reads one neuron with two byte-range
requests. A `neurons` source set renders from these files when its `externalDashboardsUrl` points at
them.

This page is the format, as `apps/webapp/lib/utils/neuron-dashboards.ts` reads it. That reader, and
its type `NeuronDashboardRecord`, are authoritative where they differ from this page.

## Serving and checking

|                   |                                                                                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| neuronpedia.org   | `https://dashboards.neuronpedia.org/v2/<model>`, served from R2 by `utils/neuron-dashboards-worker`                                                                                                                                                                  |
| locally           | `make dashboards-serve DIR=<root>` serves `<root>/v2/<model>/...` on `http://127.0.0.1:3001` with ranges and CORS, using `npx http-server`                                                                                                                           |
| point a set at it | `make source-set-update MODEL=<id> DASHBOARDS_URL=http://127.0.0.1:3001/v2/<id>`                                                                                                                                                                                     |
| check a set       | `make dashboards-check URL=<base URL> [LAYERS=0,17] [SAMPLE=3]` loads sample neurons of each layer with the webapp's own reader, and needs no browser. It checks every layer's index against its `.json.gz` and reports gaps in the layers, but not the corpus files |

`dashboards-check` works against any server, the public one included:

```
$ make dashboards-check URL=https://dashboards.neuronpedia.org/v2/qwen3-32b LAYERS=9,50 SAMPLE=1
vocab: 151669 tokens
layer  9: 25600 neurons, checked 0, 12800, 25599  top logits of 0: ["IAL","可怜",".null","аж","俦"]
layer 50: 25600 neurons, checked 0, 12800, 25599  top logits of 0: ["阳光","砭"," Loud","蹴","晚饭"]

OK: every checked neuron loads as the webapp would load it.
```

Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (recent Node 22 and 24).
Set it to check a public URL from behind a proxy.

## Layout

The base URL names one model. The `v2` in the path is the layout version. The record format below
is version 1.

```
<root>/v2/
  corpus/
    docs.txt              UTF-8 text of every document, concatenated; shared by all models
    docs_offsets.npy      int64, documents + 1 byte offsets into docs.txt
  <model>/                  <- externalDashboardsUrl
    corpus/
      vocab.json          JSON array: the decoded string of each token id
      tokens.npy          uint32, every document's tokens in this model's tokenizer, concatenated
      offsets.npy         int64, documents + 1 offsets into tokens.npy
    neurons/
      layer_00.idx        uint64 little-endian, neurons + 1 byte offsets into layer_00.json.gz
      layer_00.json.gz    one gzip member per neuron, back to back
      layer_01.idx ...    layer numbers zero-padded to two digits (three past 99)
```

- **Reading neuron n of layer L.** Read bytes `8n .. 8n+15` of `layer_LL.idx` to get `[start, end)`.
  Then read bytes `start .. end-1` of `layer_LL.json.gz` and gunzip them, which gives one JSON
  record. Offsets must strictly increase, and the last one is the `.json.gz` file's size.
- **The `.npy` files** are ordinary NumPy files. The reader skips the header without checking its
  dtype or shape, and reads the items it needs with ranges as raw little-endian values, so the
  dtype must be exactly `<u4` for `tokens.npy` and `<i8` for the offsets. NumPy's default int64 for
  tokens reads back as garbage, with no error.
- **The corpus files** are only read when someone opens a whole document from an example. A
  neuron's page needs only `vocab.json` and its own record.
- **The server must answer a single `Range: bytes=a-b` with 206** and send
  `Access-Control-Allow-Origin`, since the files are fetched cross-origin from the page. A 200 with
  the whole file also works, but the reader then downloads all of it.

## Record (format version 1)

```jsonc
{
  "v": 1,                       // format version; anything else is refused
  "model": "qwen3-32b",
  "layer": 31, "neuron": 12345, // must match the position it was read from
  "stats": {
    "max": 47.25, "min": -62.25, "mean": 7.18e-05, "std": 0.159,
    "sigma_calib": 0.1879,
    "frac_gate_open": 0.0032,   // share of tokens with the gate open (gate > 0)
    "echo_abs_share": 0.944,
    "n_hist_tokens": 12548855   // tokens counted in hist
  },
  "quantiles": { "q": [...], "v": [...] },   // activation value v[i] at quantile q[i]
  "hist": {
    "sigma": 0.1879,
    // per sign and gate state, counts of |act| / sigma in 66 bins:
    // bin 0 below 1e-3, bins 1..64 log-spaced up to 1e3, bin 65 above
    "open_pos": [...], "open_neg": [...], "closed_pos": [...], "closed_neg": [...]
  },
  "top": [Example, ...],        // strongest positive activations, strongest first
  "bottom": [Example, ...],     // most negative, most negative first
  "echo_top": [...], "echo_bottom": [...],
  "bands": [                    // examples drawn from quantile bands between the extremes
    { "q_lo": 0.9, "q_hi": 0.99, "lo": 1.2, "hi": 5.0, "examples": [Example, ...] }
  ],
  "logits": {                   // the neuron's direct effect on the output vocabulary
    "pos": [[tokenId, "token", value], ...],
    "neg": [[tokenId, "token", value], ...]
  }
}
```

An `Example` is one window of a document around a peak:

| Field               | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `doc`               | document index in the corpus                                                  |
| `pos`               | the peak token's position in the document                                     |
| `act`, `gate`, `up` | activation, gate and up value at the peak (for SwiGLU, act = silu(gate) × up) |
| `start`             | the document position of the window's first token                             |
| `tokens`            | token ids of the window, indexes into `vocab.json`                            |
| `acts`              | the activation at each window token; `null` is allowed and drawn as 0         |
| `gate_closed`       | one character per window token, `"1"` where the gate is closed (gate ≤ 0)     |

`tokens`, `acts` and `gate_closed` have the same length. `pos - start` falls inside the window.
`dashboards-check` tests these on every example it loads, `echo_*` and `bands` included.
