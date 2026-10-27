# The benchmarks of Fastify

The benchmarks of this directory measure the cost of the serialization of a
response. They are **measurements of one machine**: they are never a promise,
and every number must be read with the Node.js version and the machine it was
taken on.

## The serialization benchmark

`serialization.js` compares, on the same payload and on the same schema:

| Measurement | What it does |
|-------------|--------------|
| `fjs` | `fast-json-stringify` compiles the response schema and serializes the payload — what Fastify v5 did |
| `JSON.stringify` | the native serialization of the payload, without any validation — the lower bound, the cost of the serialization alone |
| `v6` | the Ajv output validation (which also shapes the payload) followed by the native `JSON.stringify` — what Fastify v6 does |

The gap between `JSON.stringify` and `v6` is the price of the validation the
schema now performs; the gap between `fjs` and `JSON.stringify` is what the
native serializer saves.

The `v6` measurement uses the **published** surface of the framework: the
output defaults of the output Ajv pool (`useDefaults: false`,
`coerceTypes: false`, `removeAdditional: true`, `allErrors: false`,
`strict: false`) and the published parity transform
(`applyFjsObjectParity()` of `lib/output-schema-parity.js`). The benchmark
never imports a module private symbol of the runtime.

The benchmark compares the bytes of the `v6` path and the bytes of the fjs
baseline before it measures anything: the two paths must serialize the same
bytes, and a divergence is reported instead of being published as a number of
a pipeline that the runtime does not use.

The `fjs` baseline uses the `fast-json-stringify` **devDependency** of this
repository: the benchmark adds no runtime dependency, and the scripts of this
directory live outside `lib/` and are never loaded by the framework.

Run it with:

```bash
npm run benchmark:serialization
```

The script accepts the iteration count, the number of runs, the warmup and the
selection of the shapes:

```bash
node examples/benchmark/serialization.js --iterations=100000 --runs=5
node examples/benchmark/serialization.js --shapes=small-flat,array-of-objects
node examples/benchmark/serialization.js --list
```

It prints the operations per second and the time per operation of the three
measurements, for every shape, the comparison of the bytes of the two paths,
and it exits with a non-zero code when it cannot run (a missing dependency, an
unusable schema).

## The end to end serialization benchmark

`serialization-http.js` starts a server with two routes that answer the same
payload:

- `/v6` declares a `schema.response`: the output validation of the framework
  shapes the payload and the native `JSON.stringify` serializes it;
- `/fjs` installs a `reply.serializer` with the compiled `fast-json-stringify`
  serializer: the custom serializer owns the wire format and the output
  validation is skipped. This is the v5 like path.

The request rates are measured with `autocannon` (a devDependency), and the
script prints the two rates and their ratio.

Run it with:

```bash
npm run benchmark:serialization:http
```

The script accepts the duration of a measurement, the number of connections
and the address of the server:

```bash
node examples/benchmark/serialization-http.js --duration=30 --connections=200
```

## The results

The numbers that were measured, with the machine, the Node.js versions and the
exact commands, are in [serialization-results.md](./serialization-results.md).

They were measured on **Node.js v24.22.1** (V8 13.6.233.17) and on
**Node.js v25.9.0** (V8 14.1.146.11); the runtime of the sandbox (v22.23.3,
V8 12.4.254.21) is measured as a reference.

A Node.js version that could not be obtained is recorded as **missing** in
that file: the numbers of another version are never presented as the numbers
of the missing one.
