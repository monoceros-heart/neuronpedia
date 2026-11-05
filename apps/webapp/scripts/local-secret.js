// Generate the shared secret the webapp presents to the local GPU servers (inference, autointerp,
// graph, sparsity, nla), and write it to .env.localhost.local, which is gitignored.
//
// The default is the public `localhost-secret`, fine while every server listens on loopback. Once
// a server runs elsewhere (another machine, a Modal container), anyone who can reach it can use
// it, so it needs a real secret. `make webapp-dev` (scripts/dev-with-env.js) and `make webapp-run`
// (start:localhost) layer .env.localhost.local over .env.localhost, and the Makefile's *-dev
// targets read the same file, so both ends agree without the secret going into a tracked file.
// It is never printed.
//
//   node scripts/local-secret.js            write a secret if there isn't one
//   node scripts/local-secret.js --rotate   replace it

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '..', '.env.localhost.local');
const KEYS = [
  'INFERENCE_SERVER_SECRET',
  'AUTOINTERP_SERVER_SECRET',
  'GRAPH_SERVER_SECRET',
  'SPARSITY_SERVER_SECRET',
  'NLA_SERVER_SECRET',
];

const rotate = process.argv.includes('--rotate');
const lines = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\n') : [];
const existing = lines.find((line) => line.startsWith('INFERENCE_SERVER_SECRET='));

if (existing && !rotate) {
  console.log(`A server secret is already set in ${FILE}; pass ROTATE=1 to replace it.`);
  process.exit(0);
}

const secret = crypto.randomBytes(32).toString('hex');
const kept = lines.filter((line) => line !== '' && !KEYS.some((key) => line.startsWith(`${key}=`)));
const body = [...kept, ...KEYS.map((key) => `${key}=${secret}`)].join('\n') + '\n';
fs.writeFileSync(FILE, body, { mode: 0o600 });
fs.chmodSync(FILE, 0o600);
console.log(`Wrote a new server secret to ${FILE}.`);
console.log(
  'Restart the webapp (make webapp-dev or webapp-run) and the servers (make inference-dev ...) to pick it up.',
);
console.log(
  `A server on another machine needs it as SECRET: SECRET=$(sed -n 's/^INFERENCE_SERVER_SECRET=//p' ${FILE})`,
);
