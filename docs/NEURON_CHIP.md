# Neuron chips

A chip names one neuron by its id and its top explanation, and links to the neuron's page:

```
( ◔ L16.N1744 | Wind Whisperer )
```

The ring around the dot shows how deep the layer sits in the model (layer 16 of 36 fills about
half of it), and its colour shows which model it belongs to: Qwen3-0.6B is teal, 8B violet and 32B
amber, and anything else is grey. A neuron outside the raw `neurons` set shows its set name as a
tag. Hover for the model, the layer count and the full label.

There are two versions of the same chip, and both read the same data:

| Where                                                  | What                                                   | Source                                   |
| ------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------- |
| Any HTML page: a write-up, an Artifact, a static atlas | `<np-neuron>` web component, one file, no dependencies | `apps/webapp/public/np-neuron.js`        |
| Inside this webapp                                     | `<NeuronChip>` React component                         | `apps/webapp/components/neuron-chip.tsx` |

`/neuron-chip?neurons=qwen3-8b/18/7807,qwen3-8b/9/3757` renders a row of chips on the webapp,
with the snippets below.

## In a static page

```html
<script src="np-neuron.js"></script>
<!-- a copy, or http://<instance>/np-neuron.js -->

<np-neuron model="qwen3-8b" layer="16" neuron="1744"></np-neuron>
<np-neuron
  model="qwen3-8b"
  layer="18"
  neuron="7807"
  set="neuronpersonas"
></np-neuron>
<np-neuron
  model="qwen3-32b"
  layer="4"
  neuron="8476"
  host="https://www.neuronpedia.org"
></np-neuron>
```

| Attribute         | Meaning                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `model`           | Neuronpedia model id, such as `qwen3-8b`                                                                |
| `layer`, `neuron` | The layer number and the neuron index (`index` works too)                                               |
| `set`             | The source set; defaults to `neurons`, the raw MLP neurons. Any other set is the source `<layer>-<set>` |
| `source`          | An explicit source id instead of `layer` and `set`, such as `6-res-jb`                                  |
| `label`           | Show this label and look nothing up                                                                     |
| `host`            | The instance to link to and ask; see below                                                              |
| `labels`          | A labels file for this chip only                                                                        |
| `href`            | Link here instead of the neuron's page                                                                  |
| `layers`          | The model's layer count, for the ring, when the chip doesn't know the model                             |
| `target`          | Defaults to `_blank`; `none` opens the link in the same tab                                             |
| `fetch="off"`     | Never call the per-neuron API                                                                           |

Page-wide settings go in meta tags, or in `NpNeuron.configure({ host, labels, fetch })`:

```html
<meta name="np-host" content="http://100.96.206.20:3000" />
<meta name="np-labels" content="labels/qwen3-8b-neuronpersonas.json" />
```

The host is the first of: the chip's `host`, `<meta name="np-host">`, the labels file's `host`, the
instance the script was loaded from, and finally `https://www.neuronpedia.org`.

### Where a label comes from

The first match wins:

1. The chip's own `label` attribute.
2. A labels file: inline blocks first (see below), then each `<meta name="np-labels">` URL, then
   the chip's `labels` attribute. A page fetches each file once, whatever the number of chips.
3. The instance's per-neuron API, `GET /api/feature/<model>/<source>/<index>`, taking the
   explanation the neuron's page lists first. That route returns the whole neuron, top activations
   included, and is not cached by a CDN, so the chip runs at most 6 of these at once, asks once per
   neuron per page, and keeps each answer in `localStorage` for a week.

An `https` page cannot fetch from a plain-`http` instance such as the tailnet one, and a sandboxed
page, such as a claude.ai Artifact, may not be allowed to fetch at all. Such a page needs its
labels inline, or each chip's `label` attribute. The links still work, because following a link is
not a fetch.

## The labels file

Optional. It lets a page avoid per-neuron requests, or carry labels where it can't fetch. Nothing
writes one yet; write it by hand or from a script. Inline, it goes in the page as
`<script type="application/json" data-np-labels>...</script>`, with any `<` in it escaped as
`\u003c`.

```json
{
  "format": "np-labels/1",
  "host": "http://100.96.206.20:3000",
  "models": { "qwen3-8b": { "layers": 36 } },
  "neurons": {
    "qwen3-8b/16/1744": { "label": "Wind Whisperer", "score": 0.82 },
    "qwen3-8b/18-neuronpersonas/7807": "a bare string is a label too"
  }
}
```

- Keys are `<model>/<source>/<index>`, in lower case. The source is the Neuronpedia source id: a
  bare layer number for raw neurons, and `<layer>-<set>` for any other set.
- To match the neuron's page, `label` should be the explanation the page lists first: highest
  `scoreV2`, then `scoreV1`.
- An entry can carry `href`, to link somewhere other than the neuron's page.
- `host`, when set, is where chips link to and what they ask for labels missing from the file.

## In the webapp

```tsx
import NeuronChip from "@/components/neuron-chip";

<NeuronChip model="qwen3-8b" layer={18} neuron={7807} set="neuronpersonas" />;
```

It takes the same fields as the web component (`label`, `labels`, `host`, `layers`, `source`).
With no `label` and no entry in `labels`, it asks this instance's per-neuron API, with the same
limit of 6 at once and one request per neuron per page load. A server component that already has
the explanations can pass them as `label` or `labels` instead, as long as the viewer can see the
source set.

## Keeping the two in step

`public/np-neuron.js` cannot import TypeScript, so it repeats the naming and parsing helpers in
`lib/neuron-chip/neuron-chip.ts`. `lib/neuron-chip/neuron-chip.test.ts` loads the web component
outside a browser and runs every case against both copies, so a change to one that skips the other
fails the test.
