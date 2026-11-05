'use strict'

/**
 * The serialization benchmark of Fastify v6.
 *
 * It compares, on the same payload and on the same schema:
 *
 * - `fjs`: the `fast-json-stringify` serializer, the baseline of the v5 era
 *   (the package is a devDependency of this repository, it is not a runtime
 *   dependency any more);
 * - `JSON.stringify`: the native serialization of the payload, without any
 *   validation — the lower bound, the cost of the serialization alone;
 * - `v6`: the full path of Fastify v6 — the Ajv output validation (which also
 *   shapes the payload) followed by the native `JSON.stringify`.
 *
 * The v6 measurement uses the **published** surface of the framework: the
 * output defaults of `lib/schema-controller.js` (they are written down here,
 * the module private factory of the runtime is never imported) and the
 * published parity transform `applyFjsObjectParity()` of
 * `lib/output-schema-parity.js`.
 *
 * The payload of a shape is built once and reused by the three measurements,
 * and it conforms to its schema: the three measurements therefore serialize
 * **the same bytes** and the difference between the columns is the cost of
 * the schema driven serialization (fjs) against the cost of the output
 * validation and of the native serialization (v6). The output validation of
 * the v6 path performs the shaping too: the output pool is configured with
 * `removeAdditional: true`, and the parity layer declares
 * `additionalProperties: false` exactly where the v5 serializer dropped the
 * extra properties.
 *
 * The benchmark compares the bytes of the two paths before it measures
 * anything: a shape whose bytes diverge is reported as a divergence, and it
 * is never published as the number of a pipeline that the runtime does not
 * use.
 *
 * The measurements are the measurements of one machine: they are not a promise.
 *
 * Usage:
 *
 *   node examples/benchmark/serialization.js [options]
 *
 *   --iterations=<n>   the iterations of one measurement (default: 50000)
 *   --warmup=<n>       the warmup iterations of one measurement (default: 10000)
 *   --runs=<n>         the repetitions of one measurement, the best is kept
 *                      (default: 3)
 *   --shapes=<a,b>     the shapes to measure (default: every shape)
 *   --list             the names of the shapes, and nothing else
 */

const { applyFjsObjectParity } = require('../../lib/output-schema-parity')

/**
 * The published output defaults of the framework.
 *
 * They are the defaults of the output Ajv pool of `lib/schema-controller.js`:
 * the benchmark does **not** import the module private factory of the runtime,
 * it uses the documented values, so the measurement is the one the framework
 * performs.
 *
 * The value of `removeAdditional` is `true`, and **not** `'all'`: the option
 * removes a property only where the schema declares
 * `additionalProperties: false`, and the parity layer of
 * `lib/output-schema-parity.js` declares it exactly where the v5 serializer
 * dropped the extra properties. The value `'all'` would remove every
 * additional property, even the ones that an `additionalProperties: <schema>`
 * allows: the measurement would be the one of a pipeline that the runtime does
 * not use.
 */
const OUTPUT_VALIDATOR_DEFAULTS = {
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: true,
  allErrors: false,
  strict: false
}

const DEFAULT_ITERATIONS = 50000
const DEFAULT_WARMUP = 10000
const DEFAULT_RUNS = 3

/**
 * Builds the schema and the payload of the "large flat object" shape.
 *
 * @param {number} size the number of the properties
 * @returns {object} the shape
 */
function buildLargeFlatShape (size) {
  const properties = {}
  const payload = {}
  for (let i = 0; i < size; i++) {
    properties[`field${i}`] = { type: 'string' }
    payload[`field${i}`] = `value ${i}`
  }

  return {
    name: 'large-flat',
    schema: { type: 'object', properties },
    payload
  }
}

/**
 * Builds the schema and the payload of the "array of objects" shape.
 *
 * @param {number} size the number of the items of the array
 * @returns {object} the shape
 */
function buildArrayShape (size) {
  const payload = []
  for (let i = 0; i < size; i++) {
    payload.push({
      id: i,
      name: `item ${i}`,
      price: i + 0.5,
      inStock: i % 2 === 0
    })
  }

  return {
    name: 'array-of-objects',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number' },
          inStock: { type: 'boolean' }
        }
      }
    },
    payload
  }
}

/**
 * Builds the schema and the payload of the "deeply nested" shape.
 *
 * @param {number} depth the depth of the nesting
 * @returns {object} the shape
 */
function buildNestedShape (depth) {
  const properties = {
    leaf: { type: 'string' },
    count: { type: 'integer' }
  }

  // The schema is built from the inside out: every level owns its own
  // `properties` object, a schema must never be cyclic.
  let level = { type: 'object', properties }
  for (let index = depth - 1; index >= 0; index--) {
    level = { type: 'object', properties: { [`level${index}`]: level } }
  }

  let payload = { leaf: 'the leaf', count: 1 }
  for (let index = depth - 1; index >= 0; index--) {
    payload = { [`level${index}`]: payload }
  }

  return {
    name: 'deeply-nested',
    schema: level,
    payload
  }
}

/**
 * Builds the schema and the payload of the "open object" shape.
 *
 * The schema declares no property and accepts every additional property: the
 * parity rule 2 of `lib/output-schema-parity.js` applies to it, so the
 * measurement exercises the published parity transform.
 *
 * @param {number} size the number of the properties of the payload
 * @returns {object} the shape
 */
function buildOpenObjectShape (size) {
  const payload = {}
  for (let i = 0; i < size; i++) {
    payload[`field${i}`] = `value ${i}`
  }

  return {
    name: 'open-object',
    schema: { type: 'object', additionalProperties: true },
    payload
  }
}

/**
 * The shapes the benchmark measures: the shapes a JSON API actually returns.
 */
const SHAPES = [
  {
    name: 'small-flat',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        email: { type: 'string' },
        active: { type: 'boolean' },
        createdAt: { type: 'string' },
        score: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    },
    payload: {
      id: 42,
      name: 'a name',
      email: 'a.name@example.com',
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      score: 13.37,
      tags: ['one', 'two', 'three']
    }
  },
  buildLargeFlatShape(20),
  buildArrayShape(50),
  buildNestedShape(4),
  buildOpenObjectShape(20)
]

/**
 * Parses the arguments of the script.
 *
 * @param {string[]} argv the arguments
 * @returns {object} the options
 */
function parseArgs (argv) {
  const options = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    runs: DEFAULT_RUNS,
    shapes: null,
    list: false
  }

  for (const arg of argv) {
    const [key, value] = arg.split('=')
    switch (key) {
      case '--iterations':
        options.iterations = Number(value)
        break
      case '--warmup':
        options.warmup = Number(value)
        break
      case '--runs':
        options.runs = Number(value)
        break
      case '--shapes':
        options.shapes = value.split(',').map((name) => name.trim()).filter(Boolean)
        break
      case '--list':
        options.list = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error(`Invalid iteration count: ${options.iterations}`)
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error(`Invalid warmup count: ${options.warmup}`)
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`Invalid run count: ${options.runs}`)
  }

  return options
}

/**
 * Measures one function.
 *
 * @param {function} fn the measured function, it receives the payload
 * @param {*} payload the payload
 * @param {number} iterations the iterations of one run
 * @param {number} warmup the warmup iterations
 * @returns {number} the operations per second of the run
 */
function measure (fn, payload, iterations, warmup) {
  for (let i = 0; i < warmup; i++) {
    fn(payload)
  }

  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) {
    fn(payload)
  }
  const elapsed = Number(process.hrtime.bigint() - start)

  return iterations / (elapsed / 1e9)
}

/**
 * Runs one measurement `runs` times and keeps the best run.
 *
 * A single noisy run is not a measurement: the best run of the repetitions is
 * the one that is kept.
 *
 * @param {function} fn the measured function
 * @param {*} payload the payload
 * @param {object} options the options of the script
 * @returns {number} the operations per second of the best run
 */
function measureBest (fn, payload, options) {
  let best = 0
  for (let run = 0; run < options.runs; run++) {
    const ops = measure(fn, payload, options.iterations, options.warmup)
    if (ops > best) {
      best = ops
    }
  }
  return best
}

/**
 * Formats a number of operations per second.
 *
 * @param {number} ops the operations per second
 * @returns {string} the formatted number
 */
function formatOps (ops) {
  return Math.round(ops).toLocaleString('en-US')
}

/**
 * Formats a duration in microseconds.
 *
 * @param {number} ops the operations per second
 * @returns {string} the formatted duration
 */
function formatMicros (ops) {
  return (1e6 / ops).toFixed(2)
}

/**
 * Prints a table.
 *
 * @param {string[]} headers the headers of the table
 * @param {Array} rows the rows of the table
 */
function printTable (headers, rows) {
  const widths = headers.map((header, index) => {
    return Math.max(header.length, ...rows.map((row) => row[index].length))
  })

  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')

  console.log(line(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(line(row))
  }
}

/**
 * Runs the benchmark.
 *
 * @returns {number} the exit code
 */
function main () {
  const options = parseArgs(process.argv.slice(2))

  if (options.list) {
    for (const shape of SHAPES) {
      console.log(shape.name)
    }
    return 0
  }

  let fastJson
  let AjvCompiler
  try {
    fastJson = require('fast-json-stringify')
    AjvCompiler = require('@fastify/ajv-compiler')
  } catch (error) {
    console.error(`The benchmark cannot run: ${error.message}`)
    console.error('Is the devDependency installed? Run `npm install` in the repository.')
    return 1
  }

  const selected = options.shapes === null
    ? SHAPES
    : SHAPES.filter((shape) => options.shapes.includes(shape.name))

  if (selected.length === 0) {
    console.error(`The benchmark cannot run: no shape matches ${JSON.stringify(options.shapes)}`)
    console.error(`The available shapes are: ${SHAPES.map((shape) => shape.name).join(', ')}`)
    return 1
  }

  // The output validator of the v6 path: the published output defaults of the
  // framework, applied to the parity transformed schema.
  const buildValidator = AjvCompiler()(
    {},
    { customOptions: Object.assign({}, OUTPUT_VALIDATOR_DEFAULTS) }
  )

  const opsRows = []
  const microsRows = []
  const bytesRows = []

  for (const shape of selected) {
    let validate
    let fjsSerializer
    try {
      const paritySchema = applyFjsObjectParity(shape.schema)
      validate = buildValidator({ schema: paritySchema })
      fjsSerializer = fastJson(shape.schema)
    } catch (error) {
      console.error(`The benchmark cannot run: the schema of "${shape.name}" is unusable: ${error.message}`)
      return 1
    }

    // The payload must satisfy the schema, otherwise the measurement would
    // measure a failing validation.
    if (validate(shape.payload) !== true) {
      console.error(`The benchmark cannot run: the payload of "${shape.name}" does not satisfy its schema`)
      console.error(JSON.stringify(validate.errors))
      return 1
    }

    // The two paths must produce the same bytes: the comparison is done on a
    // copy of the payload, so that the measured payload is never shaped
    // before the measurement. A shape whose bytes diverge is a divergence,
    // and the results file must say so instead of publishing the number of
    // a pipeline that the runtime does not use.
    const probe = JSON.parse(JSON.stringify(shape.payload))
    const fjsBytes = fjsSerializer(shape.payload)
    // The validator shapes the data in place and answers `true`: the shaped
    // payload is the one that the native serializer writes.
    validate(probe)
    const v6Bytes = JSON.stringify(probe)
    const sameBytes = fjsBytes === v6Bytes
    bytesRows.push([shape.name, sameBytes ? 'same as fjs' : 'DIVERGENT'])

    const fjs = measureBest((payload) => fjsSerializer(payload), shape.payload, options)
    const native = measureBest((payload) => JSON.stringify(payload), shape.payload, options)
    const v6 = measureBest(
      (payload) => {
        validate(payload)
        return JSON.stringify(payload)
      },
      shape.payload,
      options
    )

    opsRows.push([
      shape.name,
      formatOps(fjs),
      formatOps(native),
      formatOps(v6)
    ])
    microsRows.push([
      shape.name,
      formatMicros(fjs),
      formatMicros(native),
      formatMicros(v6)
    ])
  }

  console.log(`node ${process.version} (v8 ${process.versions.v8}) — ${options.iterations} iterations, ` +
    `${options.warmup} warmup, best of ${options.runs} run(s)`)
  console.log('')
  printTable(['shape', 'fjs ops/s', 'JSON.stringify ops/s', 'v6 ops/s'], opsRows)
  console.log('')
  printTable(['shape', 'fjs us/op', 'JSON.stringify us/op', 'v6 us/op'], microsRows)
  console.log('')
  printTable(['shape', 'bytes of the v6 path'], bytesRows)

  // One summary line: what the native serializer saves and what the output
  // validation costs.
  const summaries = selected.map((shape, index) => {
    const fjs = Number(microsRows[index][1])
    const native = Number(microsRows[index][2])
    const v6 = Number(microsRows[index][3])
    return `${shape.name}: v6 ${v6}us/op (${(v6 / fjs * 100).toFixed(0)}% of fjs), ` +
      `native ${native}us/op (${(native / fjs * 100).toFixed(0)}% of fjs)`
  })
  console.log('')
  console.log(`summary: ${summaries.join(' — ')}`)

  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`The benchmark cannot run: ${error.message}`)
  process.exitCode = 1
}
