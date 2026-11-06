/*!
 * <np-neuron>: a chip that names a Neuronpedia neuron, such as ( L16.N1744 | Wind Whisperer ),
 * and links to its page.
 *
 *   <script src="np-neuron.js"></script>
 *   <np-neuron model="qwen3-8b" layer="16" neuron="1744"></np-neuron>
 *   <np-neuron model="qwen3-8b" layer="18" neuron="7807" set="neuronpersonas"></np-neuron>
 *
 * One file, no dependencies: copy it into a static page, or load it from any Neuronpedia instance
 * that serves it (`<host>/np-neuron.js`). Format and options: docs/NEURON_CHIP.md.
 *
 * Where the label comes from, first match wins:
 *   1. the element's own `label` attribute;
 *   2. a labels file: inline `<script type="application/json" data-np-labels>` blocks, then every
 *      `<meta name="np-labels" content="URL">` (each fetched once per page), then the element's
 *      own `labels` attribute;
 *   3. the instance's per-neuron API, `<host>/api/feature/<model>/<source>/<index>`, which returns
 *      the whole neuron, so these run at most 6 at a time, are shared between chips that name the
 *      same neuron, and are cached in localStorage for a week. `fetch="off"` turns this off.
 *
 * The host is the element's `host`, else `<meta name="np-host">`, else the labels file's own
 * `host`, else the origin this script was loaded from when that is a Neuronpedia instance, else
 * https://www.neuronpedia.org.
 *
 * Kept in step with lib/neuron-chip/neuron-chip.ts, which the webapp's React chip uses; the tests
 * in lib/neuron-chip/neuron-chip.test.ts run both on the same cases.
 */
(function () {
  'use strict';

  var VERSION = 1;
  var FORMAT = 'np-labels/1';
  var NEURONS_SET = 'neurons';
  var DEFAULT_HOST = 'https://www.neuronpedia.org';
  var CACHE_PREFIX = 'np-neuron:v' + VERSION + ':';
  var CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  var MAX_PARALLEL = 6;

  /** Layer counts for the models we link to most; a labels file or `layers` attribute adds more. */
  var MODEL_LAYERS = {
    'qwen3-0.6b': 28,
    'qwen3-8b': 36,
    'qwen3-32b': 64,
    'gpt2-small': 12,
    'gemma-2-2b': 26,
    'llama3.1-8b': 32,
  };

  /** One accent per model, so chips from different models read apart at a glance. */
  var MODEL_COLORS = {
    'qwen3-0.6b': '#0f9d8a',
    'qwen3-8b': '#7c4dff',
    'qwen3-32b': '#d9822b',
  };
  var FALLBACK_COLOR = '#64748b';

  // ---------------------------------------------------------------- pure helpers (tested)

  /**
   * The Neuronpedia source id for a layer of a source set. Raw neurons (`neurons`) use the bare
   * layer number; every other set is `<layer>-<set>`, as in `18-neuronpersonas` or `6-res-jb`.
   * An explicit `source` wins.
   */
  function sourceId(opts) {
    if (opts.source) return String(opts.source).toLowerCase();
    var layer = String(opts.layer);
    var set = opts.set ? String(opts.set).toLowerCase() : NEURONS_SET;
    return set === NEURONS_SET ? layer : layer + '-' + set;
  }

  /** The layer number at the front of a source id, or null. */
  function layerOf(source) {
    var m = /^(-?\d+)/.exec(String(source));
    return m ? parseInt(m[1], 10) : null;
  }

  /** The set name a source id belongs to (`neurons` for a bare layer number). */
  function setOf(source) {
    var s = String(source);
    var dash = s.indexOf('-', s.charAt(0) === '-' ? 1 : 0);
    return /^-?\d+$/.test(s) ? NEURONS_SET : dash === -1 ? s : s.slice(dash + 1);
  }

  /** The lookup key a labels file uses: `<model>/<source>/<index>`. */
  function neuronKey(model, source, index) {
    return String(model).toLowerCase() + '/' + String(source).toLowerCase() + '/' + String(index);
  }

  /** `L16.N1744`; a source with no leading layer number keeps its own name. */
  function formatId(source, index) {
    var layer = layerOf(source);
    return (layer === null ? String(source) : 'L' + layer) + '.N' + index;
  }

  function stripSlash(url) {
    return String(url).replace(/\/+$/, '');
  }

  /** The neuron's page on a Neuronpedia instance. */
  function neuronUrl(host, model, source, index) {
    return stripSlash(host) + '/' + encodeURIComponent(model) + '/' + encodeURIComponent(source) + '/' + index;
  }

  /** The per-neuron API the fallback reads. */
  function featureApiUrl(host, model, source, index) {
    return (
      stripSlash(host) + '/api/feature/' + encodeURIComponent(model) + '/' + encodeURIComponent(source) + '/' + index
    );
  }

  /**
   * Read a labels file into { host, models: {id: {layers}}, neurons: {key: {label, href?, score?}} }.
   * A neuron's value may be a bare label string. Throws on a file of another format.
   */
  function parseLabels(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('labels: expected a JSON object');
    if (data.format && data.format !== FORMAT) throw new Error('labels: unknown format ' + data.format);
    var neurons = {};
    var raw = data.neurons || {};
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      var entry = typeof v === 'string' ? { label: v } : v;
      if (entry && typeof entry.label === 'string') neurons[k.toLowerCase()] = entry;
    });
    return { host: data.host ? stripSlash(data.host) : null, models: data.models || {}, neurons: neurons };
  }

  /** The label to show from a /api/feature response: its best explanation, as Neuronpedia orders them. */
  function labelFromFeature(feature) {
    var exps = (feature && feature.explanations) || [];
    for (var i = 0; i < exps.length; i += 1) {
      if (exps[i] && typeof exps[i].description === 'string' && exps[i].description.trim()) {
        return exps[i].description.trim();
      }
    }
    return null;
  }

  /** How deep the layer sits, 0..1, or null when the model's layer count is unknown. */
  function depth(layer, layers) {
    if (layer === null || !layers) return null;
    return Math.max(0, Math.min(1, (layer + 1) / layers));
  }

  function modelColor(model) {
    return MODEL_COLORS[String(model).toLowerCase()] || FALLBACK_COLOR;
  }

  var helpers = {
    VERSION: VERSION,
    FORMAT: FORMAT,
    MODEL_LAYERS: MODEL_LAYERS,
    sourceId: sourceId,
    layerOf: layerOf,
    setOf: setOf,
    neuronKey: neuronKey,
    formatId: formatId,
    neuronUrl: neuronUrl,
    featureApiUrl: featureApiUrl,
    parseLabels: parseLabels,
    labelFromFeature: labelFromFeature,
    depth: depth,
    modelColor: modelColor,
  };

  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  if (typeof document === 'undefined' || typeof customElements === 'undefined') {
    // Loaded outside a browser (the unit tests): expose the helpers and stop.
    root.NpNeuron = helpers;
    return;
  }
  if (customElements.get('np-neuron')) return;

  // ---------------------------------------------------------------- page-wide state

  var scriptOrigin = (function () {
    var s = document.currentScript;
    if (!s || !s.src) return null;
    try {
      var u = new URL(s.src, location.href);
      // Served by a Neuronpedia instance at its root, rather than copied onto a CDN or another site.
      return /\/np-neuron(\.min)?\.js$/.test(u.pathname) && u.pathname.split('/').length === 2 ? u.origin : null;
    } catch (e) {
      return null;
    }
  })();

  var config = { host: null, labels: [], fetch: true };
  var labelSets = []; // parsed label files, in priority order
  var labelFiles = {}; // url -> Promise<parsed|null>
  var featureRequests = {}; // host|key -> Promise<string|null>
  var queue = [];
  var running = 0;
  var elements = new Set();

  function metaContent(name) {
    var out = [];
    document.querySelectorAll('meta[name="' + name + '"]').forEach(function (m) {
      if (m.content) out.push(m.content);
    });
    return out;
  }

  function pageHost() {
    return config.host || metaContent('np-host')[0] || null;
  }

  function readInlineLabels() {
    document.querySelectorAll('script[type="application/json"][data-np-labels]').forEach(function (s) {
      if (s.__npRead) return;
      s.__npRead = true;
      try {
        labelSets.push(parseLabels(JSON.parse(s.textContent || '{}')));
      } catch (e) {
        console.warn('np-neuron: skipping an inline labels block:', e.message);
      }
    });
  }

  function loadLabelFile(url) {
    var abs = new URL(url, location.href).href;
    if (!labelFiles[abs]) {
      labelFiles[abs] = fetch(abs, { credentials: 'omit' })
        .then(function (r) {
          if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
          return r.json();
        })
        .then(function (data) {
          var parsed = parseLabels(data);
          labelSets.push(parsed);
          return parsed;
        })
        .catch(function (e) {
          console.warn('np-neuron: could not load labels ' + abs + ':', e.message);
          return null;
        });
    }
    return labelFiles[abs];
  }

  function pageLabelFiles() {
    return Promise.all(metaContent('np-labels').concat(config.labels).map(loadLabelFile));
  }

  function findLabel(key) {
    for (var i = 0; i < labelSets.length; i += 1) {
      if (labelSets[i].neurons[key]) return { entry: labelSets[i].neurons[key], set: labelSets[i] };
    }
    return null;
  }

  function knownLayers(model) {
    var m = String(model).toLowerCase();
    for (var i = 0; i < labelSets.length; i += 1) {
      var info = labelSets[i].models[m];
      if (info && info.layers) return info.layers;
    }
    return MODEL_LAYERS[m] || null;
  }

  function cacheGet(id) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + id);
      if (!raw) return undefined;
      var hit = JSON.parse(raw);
      if (Date.now() - hit.t > CACHE_TTL_MS) return undefined;
      return hit.v;
    } catch (e) {
      return undefined;
    }
  }

  function cacheSet(id, value) {
    try {
      localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      /* storage full or blocked: the in-memory promise still dedupes this page */
    }
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      var job = queue.shift();
      running += 1;
      job().then(
        function () {
          running -= 1;
          pump();
        },
        function () {
          running -= 1;
          pump();
        },
      );
    }
  }

  function fetchFeatureLabel(host, model, source, index) {
    var id = stripSlash(host) + '|' + neuronKey(model, source, index);
    if (featureRequests[id]) return featureRequests[id];
    var cached = cacheGet(id);
    if (cached !== undefined) {
      featureRequests[id] = Promise.resolve(cached);
      return featureRequests[id];
    }
    featureRequests[id] = new Promise(function (resolve) {
      queue.push(function () {
        return fetch(featureApiUrl(host, model, source, index), { credentials: 'omit' })
          .then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json().then(labelFromFeature);
          })
          .then(
            function (label) {
              cacheSet(id, label);
              resolve(label);
            },
            function (e) {
              console.warn('np-neuron: ' + id + ':', e.message);
              resolve(undefined); // not cached, so a reload tries again
            },
          );
      });
      pump();
    });
    return featureRequests[id];
  }

  // ---------------------------------------------------------------- the element

  var STYLE =
    ':host{display:inline-block;vertical-align:baseline;max-width:100%;' +
    '--np-bg:#f8fafc;--np-fg:#0f172a;--np-muted:#64748b;--np-border:#cbd5e1;--np-track:#e2e8f0}' +
    '@media (prefers-color-scheme:dark){:host{--np-bg:#1e293b;--np-fg:#e2e8f0;--np-muted:#94a3b8;' +
    '--np-border:#334155;--np-track:#334155}}' +
    'a{display:inline-flex;align-items:center;gap:.4em;max-width:100%;box-sizing:border-box;' +
    'padding:.1em .6em .1em .35em;border:1px solid var(--np-border);border-radius:999px;' +
    'background:var(--np-bg);color:var(--np-fg);text-decoration:none;font:inherit;font-size:.88em;' +
    'line-height:1.5;white-space:nowrap;transition:border-color .15s,box-shadow .15s}' +
    'a:hover,a:focus-visible{border-color:var(--np-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--np-accent) 18%,transparent);outline:none}' +
    'svg{flex:none;width:1.05em;height:1.05em}' +
    '.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em;font-weight:600;color:var(--np-accent)}' +
    '.sep{color:var(--np-border)}' +
    '.set{color:var(--np-muted)}' +
    '.label{overflow:hidden;text-overflow:ellipsis;max-width:var(--np-label-max,22em);padding-right:.1em}' +
    '.label.none{color:var(--np-muted);font-style:italic}' +
    '.label.loading{color:var(--np-muted)}';

  function el(tag, attrs, text) {
    var e = document.createElementNS(
      tag === 'svg' || tag === 'circle' || tag === 'path' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
      tag,
    );
    Object.keys(attrs || {}).forEach(function (k) {
      e.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** A small neuron glyph: a dot, ringed by an arc showing how deep its layer sits in the model. */
  function glyph(d, color) {
    var svg = el('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    svg.appendChild(el('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'var(--np-track)', 'stroke-width': 2.4 }));
    if (d !== null) {
      var a = d * 2 * Math.PI;
      var x = 8 + 6 * Math.sin(a);
      var y = 8 - 6 * Math.cos(a);
      var path =
        d >= 0.999
          ? 'M8 2 A6 6 0 1 1 7.99 2'
          : 'M8 2 A6 6 0 ' + (d > 0.5 ? 1 : 0) + ' 1 ' + x.toFixed(2) + ' ' + y.toFixed(2);
      svg.appendChild(el('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
    }
    svg.appendChild(el('circle', { cx: 8, cy: 8, r: 2.6, fill: color }));
    return svg;
  }

  var OBSERVED = ['model', 'layer', 'neuron', 'index', 'set', 'source', 'label', 'host', 'labels', 'href', 'layers', 'target', 'fetch'];

  class NpNeuronElement extends HTMLElement {
    static get observedAttributes() {
      return OBSERVED;
    }
  }

  NpNeuronElement.prototype.connectedCallback = function () {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).appendChild(el('style', {}, STYLE));
    }
    elements.add(this);
    this._render();
  };
  NpNeuronElement.prototype.disconnectedCallback = function () {
    elements.delete(this);
  };
  NpNeuronElement.prototype.attributeChangedCallback = function () {
    if (this.isConnected && this.shadowRoot) this._render();
  };

  NpNeuronElement.prototype._spec = function () {
    var model = (this.getAttribute('model') || '').toLowerCase();
    var index = this.getAttribute('neuron') || this.getAttribute('index') || '';
    var source = sourceId({
      layer: this.getAttribute('layer') || '',
      set: this.getAttribute('set'),
      source: this.getAttribute('source'),
    });
    return { model: model, source: source, index: index, key: neuronKey(model, source, index) };
  };

  NpNeuronElement.prototype._render = function () {
    var spec = this._spec();
    var token = {};
    this._token = token;
    if (!spec.model || spec.source === '' || spec.index === '') {
      this._paint(spec, { label: 'needs model, layer and neuron', state: 'none' });
      return;
    }
    var own = this.getAttribute('label');
    if (own) {
      this._paint(spec, { label: own, state: 'ok' });
      return;
    }
    this._paint(spec, { label: '…', state: 'loading' });
    readInlineLabels();
    var files = [pageLabelFiles()];
    if (this.getAttribute('labels')) files.push(loadLabelFile(this.getAttribute('labels')));
    Promise.all(files).then(() => {
      if (this._token !== token) return;
      var hit = findLabel(spec.key);
      if (hit) {
        this._paint(spec, { label: hit.entry.label, href: hit.entry.href, host: hit.set.host, state: 'ok' });
        return;
      }
      var host = this._host(null);
      if ((this.getAttribute('fetch') || '').toLowerCase() === 'off' || !config.fetch) {
        this._paint(spec, { label: 'no label', state: 'none' });
        return;
      }
      fetchFeatureLabel(host, spec.model, spec.source, spec.index).then((label) => {
        if (this._token !== token) return;
        this._paint(spec, label ? { label: label, state: 'ok' } : { label: 'no label', state: 'none' });
      });
    });
  };

  NpNeuronElement.prototype._host = function (fileHost) {
    var firstFileHost = null;
    for (var i = 0; i < labelSets.length && !firstFileHost; i += 1) firstFileHost = labelSets[i].host;
    return stripSlash(this.getAttribute('host') || pageHost() || fileHost || firstFileHost || scriptOrigin || DEFAULT_HOST);
  };

  NpNeuronElement.prototype._paint = function (spec, result) {
    var sr = this.shadowRoot;
    var old = sr.querySelector('a');
    if (old) old.remove();
    var host = this._host(result.host || null);
    var href = this.getAttribute('href') || result.href || neuronUrl(host, spec.model, spec.source, spec.index);
    var layers = parseInt(this.getAttribute('layers') || '', 10) || knownLayers(spec.model);
    var layer = layerOf(spec.source);
    var color = modelColor(spec.model);
    var set = setOf(spec.source);
    var id = formatId(spec.source, spec.index);

    var a = el('a', { href: href, part: 'chip' });
    var target = this.getAttribute('target');
    if (target !== 'none') {
      a.setAttribute('target', target || '_blank');
      a.setAttribute('rel', 'noopener');
    }
    a.style.setProperty('--np-accent', color);
    a.title =
      spec.model +
      ' · layer ' +
      (layer === null ? spec.source : layer) +
      (layers ? ' of ' + layers : '') +
      ' · neuron ' +
      spec.index +
      (set !== NEURONS_SET ? ' · ' + set : '') +
      (result.state === 'ok' ? '\n' + result.label : '');
    a.setAttribute('aria-label', id + (result.state === 'ok' ? ', ' + result.label : '') + ', ' + spec.model);
    a.appendChild(glyph(depth(layer, layers), color));
    a.appendChild(el('span', { class: 'id', part: 'id' }, id));
    a.appendChild(el('span', { class: 'sep', 'aria-hidden': 'true' }, '|'));
    a.appendChild(el('span', { class: 'label ' + (result.state === 'ok' ? '' : result.state), part: 'label' }, result.label));
    if (set !== NEURONS_SET) {
      a.appendChild(el('span', { class: 'sep', 'aria-hidden': 'true' }, '|'));
      a.appendChild(el('span', { class: 'set', part: 'set' }, set));
    }
    sr.appendChild(a);
  };

  customElements.define('np-neuron', NpNeuronElement);

  /** Page-wide options, for pages that would rather set them in script than with meta tags. */
  helpers.configure = function (opts) {
    if (opts.host !== undefined) config.host = opts.host ? stripSlash(opts.host) : null;
    if (opts.labels) config.labels = config.labels.concat(opts.labels);
    if (opts.fetch !== undefined) config.fetch = !!opts.fetch;
    elements.forEach(function (e) {
      e._render();
    });
  };
  /** Add a labels object directly, as a page that builds its own would. */
  helpers.addLabels = function (data) {
    labelSets.unshift(parseLabels(data));
    elements.forEach(function (e) {
      e._render();
    });
  };
  root.NpNeuron = helpers;
})();
