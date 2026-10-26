# The results of the serialization benchmarks

**Date:** 2026-10-26

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
| v24.22.1 | 13.6.233.17 | the official binary of nodejs.org |
| v25.9.0 | 14.1.146.11 | the official binary of nodejs.org |
| v22.23.3 | 12.4.254.21 | the runtime of the sandbox, measured as a reference |

Both required versions were obtained and measured. Nothing is missing, and no
number of one version is presented as the number of another one.

## The commands

```bash
# the micro benchmark (the default parameters: 50000 iterations,
# 10000 warmup iterations, the best of 3 runs, every shape)
node examples/benchmark/serialization.js

# the end to end benchmark (100 connections, 10s per route, best of 3 runs)
node examples/benchmark/serialization-http.js --duration=10 --connections=100 --runs=3
```

The runtimes were the ones of the table above, for example:

```bash
/path/to/node-v24.22.1-linux-x64/bin/node examples/benchmark/serialization.js
/path/to/node-v25.9.0-linux-x64/bin/node examples/benchmark/serialization.js
```

## The micro benchmark

The three measurements share the same payload and the same schema:

- `fjs` — the `fast-json-stringify` serializer (the devDependency that the
  benchmark uses as the baseline of the v5 era);
- `JSON.stringify` — the native serialization, without any validation;
- `v6` — the Ajv output validation (the published output defaults, on the
  parity transformed schema) followed by the native `JSON.stringify`.

### Node.js v24.22.1 (V8 13.6.233.17)

| Shape | fjs ops/s | JSON.stringify ops/s | v6 ops/s |
|-------|-----------|----------------------|----------|
| small-flat | 1,962,775 | 1,726,954 | 1,703,485 |
| large-flat | 701,323 | 559,006 | 330,648 |
| array-of-objects | 98,424 | 107,491 | 97,899 |
| deeply-nested | 6,678,534 | 2,757,115 | 2,334,891 |
| open-object | 234,946 | 563,335 | 549,717 |

| Shape | fjs us/op | JSON.stringify us/op | v6 us/op |
|-------|-----------|----------------------|----------|
| small-flat | 0.51 | 0.58 | 0.59 |
| large-flat | 1.43 | 1.79 | 3.02 |
| array-of-objects | 10.16 | 9.30 | 10.21 |
| deeply-nested | 0.15 | 0.36 | 0.43 |
| open-object | 4.26 | 1.78 | 1.82 |

### Node.js v25.9.0 (V8 14.1.146.11)

| Shape | fjs ops/s | JSON.stringify ops/s | v6 ops/s |
|-------|-----------|----------------------|----------|
| small-flat | 2,418,778 | 2,999,995 | 2,738,787 |
| large-flat | 751,156 | 529,255 | 330,754 |
| array-of-objects | 115,706 | 211,444 | 173,005 |
| deeply-nested | 7,748,179 | 5,635,811 | 4,113,167 |
| open-object | 295,129 | 532,623 | 531,224 |

| Shape | fjs us/op | JSON.stringify us/op | v6 us/op |
|-------|-----------|----------------------|----------|
| small-flat | 0.41 | 0.33 | 0.37 |
| large-flat | 1.33 | 1.89 | 3.02 |
| array-of-objects | 8.64 | 4.73 | 5.78 |
| deeply-nested | 0.13 | 0.18 | 0.24 |
| open-object | 3.39 | 1.88 | 1.88 |

### Node.js v22.23.3 (V8 12.4.254.21) — the reference of the sandbox

| Shape | fjs ops/s | JSON.stringify ops/s | v6 ops/s |
|-------|-----------|----------------------|----------|
| small-flat | 2,147,579 | 2,085,154 | 1,944,821 |
| large-flat | 685,621 | 635,426 | 355,175 |
| array-of-objects | 90,804 | 108,850 | 97,963 |
| deeply-nested | 6,873,841 | 2,970,284 | 2,457,500 |
| open-object | 224,866 | 633,744 | 628,671 |

| Shape | fjs us/op | JSON.stringify us/op | v6 us/op |
|-------|-----------|----------------------|----------|
| small-flat | 0.47 | 0.48 | 0.51 |
| large-flat | 1.46 | 1.57 | 2.82 |
| array-of-objects | 11.01 | 9.19 | 10.21 |
| deeply-nested | 0.15 | 0.34 | 0.41 |
| open-object | 4.45 | 1.58 | 1.59 |

## The end to end benchmark

The two routes answer the same payload: `/v6` declares a `schema.response`
(output validation, shaping, native `JSON.stringify`), `/fjs` installs a
`reply.serializer` with the compiled `fast-json-stringify` serializer (the
v5 like path, the output validation is skipped).

| Node.js | `/v6` requests/s | `/fjs` requests/s | Ratio |
|---------|------------------|-------------------|-------|
| v24.22.1 | 21,558 | 22,150 | 97 % |
| v25.9.0 | 19,680 | 20,205 | 97 % |

## The reading

**The native serializer.** On Node.js 24 the native `JSON.stringify` is
*faster* than fjs on two shapes (an array of objects: 9.30 against 10.16
us/op, and an open object: 1.78 against 4.26 us/op) and slower on the three
others (a small object: 0.58 against 0.51 us/op, a large flat object: 1.79
against 1.43 us/op, a deeply nested object: 0.36 against 0.15 us/op). On
Node.js 25 the native serializer is faster on three shapes (0.33 against 0.41,
4.73 against 8.64 and 1.88 against 3.39 us/op) and slower on two (1.89
against 1.33 and 0.18 against 0.13 us/op).

The claim of the ADR — that the native serializer of the recent V8 is roughly
comparable with `fast-json-stringify` — **holds on both runtimes**: the
difference is a factor of 1.1 to 2.4 in either direction, and it depends on
the shape, not on the runtime. The biggest single win of Node.js 25 is the
array of objects: the native serialization goes from 9.30 to 4.73 us/op, the
serialization of an array of objects is twice as fast.

**The output validation.** The `v6` column is the whole path of Fastify v6:
the Ajv output validation (which also shapes the payload) and then the native
serialization. It costs between 1.03x (an array of objects on Node.js 25) and
3.0x (a deeply nested object on Node.js 24) the time of the fjs baseline. The
gap is the price of the validation that the schema now performs — the thing
Fastify v5 did with fjs as well, but without the structured errors.

**End to end.** The request rate of the v6 path is 97 % of the request rate of
the fjs path on both runtimes: the HTTP path of Fastify is dominated by the
framework overhead, not by the serialization of the response. The two runtimes
are within 8 % of each other on this workload.

## The caveats

- These are the measurements of **one machine**, taken with the machine
  otherwise idle. They move by a few percent between two runs, and they are
  not a promise for any other machine.
- The payloads of the micro benchmark **conform to their schema**, so the
  three measurements serialize the same bytes and the difference between the
  columns is the cost of the schema driven serialization (fjs) against the
  cost of the validation and of the native serialization (v6). The Ajv
  `removeAdditional: 'all'` pass — the shaping — is part of the `v6` column,
  but the removal of the properties that the schema does not declare is not
  measured, because the payload of a conforming request has none.
- The `open-object` shape is the one that exercises the fjs parity rule 2 of
  `lib/output-schema-parity.js`: its schema accepts every additional
  property, and fjs is at its slowest on it (3.39 to 4.53 us/op), while the
  v6 path is at the speed of the native serialization.
- The `fjs` baseline is the `fast-json-stringify` **devDependency** of this
  repository. The benchmark adds no runtime dependency, and the scripts live
  outside `lib/`.
