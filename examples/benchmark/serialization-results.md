# The results of the serialization benchmarks

**Date:** 2026-10-27

These are the measurements of **one machine**. They are not a promise, and they
are not a benchmark result of the project: they are the numbers a contributor
can reproduce with the commands below.

## The machine

| Item | Value |
|------|-------|
| CPU | Intel(R) N100 (4 cores) |
| Memory | 7 GB |
| Operating system | Debian GNU/Linux 12 (bookworm), Linux 6.18.15 x86_64 |
| Node.js runtimes | the official binaries of [nodejs.org](https://nodejs.org/dist/), unpacked outside the repository |

The machine is a shared container: the numbers move by a few percent between
two runs.

## The Node.js versions

| Version | V8 | How it was obtained |
|---------|-----|---------------------|
| v22.23.3 | 12.4.254.21 | the runtime of the sandbox, measured as a reference |

The micro benchmark was **re-measured** on the runtime of the sandbox, the
only runtime that is available in this container.

> ⚠️ **The previous micro benchmark numbers were removed.** They were measured
> on the Node.js v24.22.1 and v25.9.0 runtimes with a benchmark that
> configured its own validator with `removeAdditional: 'all'`, while the
> runtime uses `removeAdditional: true` and the fjs parity layer. The two
> pipelines are not the same — the `'all'` value empties the payload of the
> `open-object` shape after the first iteration — so the published `v6` column
> was not the measurement of the runtime. Those tables are not republished
> here: only the numbers that were measured with the pipeline of the runtime
> are published.

## The commands

```bash
# the micro benchmark (the default parameters: 50000 iterations,
# 10000 warmup iterations, the best of 3 runs, every shape)
node examples/benchmark/serialization.js

# the end to end benchmark (100 connections, 10s per route, best of 3 runs)
node examples/benchmark/serialization-http.js --duration=10 --connections=100 --runs=3
```

The runtime of the sandbox is the one that was measured:

```bash
node examples/benchmark/serialization.js
node examples/benchmark/serialization-http.js --duration=10 --connections=100 --runs=3
```

## The micro benchmark

The three measurements share the same payload and the same schema:

- `fjs` — the `fast-json-stringify` serializer (the devDependency that the
  benchmark uses as the baseline of the v5 era);
- `JSON.stringify` — the native serialization, without any validation;
- `v6` — the Ajv output validation (the published output defaults, on the
  parity transformed schema) followed by the native `JSON.stringify()`.

The `v6` measurement uses the **output defaults of the runtime**
(`useDefaults: false`, `coerceTypes: false`, `removeAdditional: true`,
`allErrors: false`, `strict: false`) and the published parity transform
(`applyFjsObjectParity()` of `lib/output-schema-parity.js`): it is the pipeline
that the framework performs.

The benchmark also compares the **bytes** of the two paths before it measures
anything. The bytes of the `v6` path and the bytes of the fjs baseline must
be the same, because the payload conforms to its schema: the table below
reports the comparison, so that a divergence can never be published as the
number of a pipeline that the runtime does not use.

### Node.js v22.23.3 (V8 12.4.254.21)

| Shape | fjs ops/s | JSON.stringify ops/s | v6 ops/s |
|-------|-----------|----------------------|----------|
| small-flat | 2,139,222 | 2,100,691 | 1,927,734 |
| large-flat | 680,326 | 616,908 | 343,078 |
| array-of-objects | 92,730 | 109,462 | 98,275 |
| deeply-nested | 6,557,331 | 2,976,646 | 2,484,237 |
| open-object | 220,191 | 611,783 | 612,230 |

| Shape | fjs us/op | JSON.stringify us/op | v6 us/op |
|-------|-----------|----------------------|----------|
| small-flat | 0.47 | 0.48 | 0.52 |
| large-flat | 1.47 | 1.62 | 2.91 |
| array-of-objects | 10.78 | 9.14 | 10.18 |
| deeply-nested | 0.15 | 0.34 | 0.40 |
| open-object | 4.54 | 1.63 | 1.63 |

| Shape | bytes of the v6 path |
|-------|----------------------|
| small-flat | same as fjs |
| large-flat | same as fjs |
| array-of-objects | same as fjs |
| deeply-nested | same as fjs |
| open-object | same as fjs |

## The end to end benchmark

The two routes answer the same payload: `/v6` declares a `schema.response`
(output validation, shaping, native `JSON.stringify`), `/fjs` installs a
`reply.serializer` with the compiled `fast-json-stringify` serializer (the
v5 like path, the output validation is skipped).

The end to end benchmark runs the **framework itself**, so its numbers are the
measurement of the runtime and the correction of the micro benchmark does not
change them: the numbers of the Node.js v24.22.1 and v25.9.0 runtimes, that
were measured before the correction, are kept.

| Node.js | `/v6` requests/s | `/fjs` requests/s | Ratio |
|---------|------------------|-------------------|-------|
| v22.23.3 | 17,810 | 18,430 | 97 % |
| v24.22.1 | 21,558 | 22,150 | 97 % |
| v25.9.0 | 19,680 | 20,205 | 97 % |

## The reading

**The native serializer.** On Node.js 22 the native `JSON.stringify` is
*faster* than fjs on two shapes (an array of objects: 9.14 against 10.78
us/op, and an open object: 1.63 against 4.54 us/op) and slower on the three
others (a small object: 0.48 against 0.47 us/op, a large flat object: 1.62
against 1.47 us/op, a deeply nested object: 0.34 against 0.15 us/op).

**The output validation.** The `v6` column is the whole path of Fastify v6:
the Ajv output validation (which also shapes the payload) and then the native
serialization. It costs between 0.94x (an array of objects) and 2.67x (a
deeply nested object) the time of the fjs baseline. The gap is the price of
the validation that the schema now performs — the thing Fastify v5 did with
fjs as well, but without the structured errors.

**The open object.** The `open-object` shape is the one that exercises the
fjs parity rule 2 of `lib/output-schema-parity.js`: its schema accepts every
additional property, so the properties of the payload reach the wire, exactly
as they did with the fjs serializer. The `v6` path is at the speed of the
native serialization on it (1.63 against 1.63 us/op), and the bytes are the
bytes of the fjs baseline — the benchmark checks it. The number that the
previous version of this file published for this shape (1.59 us/op) was the
measurement of a pipeline that removed the properties of the payload after the
first iteration: it was not the measurement of the runtime.

**End to end.** The request rate of the v6 path is 97 % of the request rate of
the fjs path: the HTTP path of Fastify is dominated by the framework overhead,
not by the serialization of the response.

## The caveats

- These are the measurements of **one machine**, taken with the machine
  otherwise idle. They move by a few percent between two runs, and they are
  not a promise for any other machine.
- The payloads of the micro benchmark **conform to their schema**, so the
  three measurements serialize the same bytes and the difference between the
  columns is the cost of the schema driven serialization (fjs) against the
  cost of the validation and of the native serialization (v6). The shaping is
  part of the `v6` column, but the removal of the properties that the schema
  does not declare is not measured, because the payload of a conforming
  request has none.
- The `fjs` baseline is the `fast-json-stringify` **devDependency** of this
  repository. The benchmark adds no runtime dependency, and the scripts live
  outside `lib/`.
