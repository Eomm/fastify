'use strict'

/**
 * The end to end benchmark of the serialization of Fastify v6.
 *
 * The server answers the same payload on two routes:
 *
 * - `/v6`: the route declares a `schema.response`, so the payload goes
 *   through the output validation of the framework (the Ajv output validator,
 *   which also shapes the payload) and through the native `JSON.stringify`.
 *   This is what Fastify v6 does;
 * - `/fjs`: the route installs a `reply.serializer` with the compiled
 *   `fast-json-stringify` serializer, so the custom serializer owns the wire
 *   format and the output validation is skipped. This is what Fastify v5 did.
 *
 * The two routes answer the same bytes, so the request rates are comparable:
 * the difference is the cost of the output validation.
 *
 * The request rates are measured with `autocannon` (a devDependency), the
 * tool the other benchmarks of this repository use.
 *
 * Usage:
 *
 *   node examples/benchmark/serialization-http.js [options]
 *
 *   --duration=<s>     the duration of one measurement, in seconds (default: 10)
 *   --connections=<n>  the connections of one measurement (default: 100)
 *   --port=<n>         the port of the server (default: 3000)
 *   --host=<host>      the host of the server (default: 127.0.0.1)
 */

const fastify = require('../../fastify')
const autocannon = require('autocannon')

const DEFAULT_DURATION = 10
const DEFAULT_CONNECTIONS = 100
const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'

/**
 * The schema of the response: the same schema on the two routes.
 */
const responseSchema = {
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
}

/**
 * The payload of the two routes: the same payload on the two routes.
 */
const payload = {
  id: 42,
  name: 'a name',
  email: 'a.name@example.com',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  score: 13.37,
  tags: ['one', 'two', 'three']
}

/**
 * Parses the arguments of the script.
 *
 * @param {string[]} argv the arguments
 * @returns {object} the options
 */
function parseArgs (argv) {
  const options = {
    duration: DEFAULT_DURATION,
    connections: DEFAULT_CONNECTIONS,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST
  }

  for (const arg of argv) {
    const [key, value] = arg.split('=')
    switch (key) {
      case '--duration':
        options.duration = Number(value)
        break
      case '--connections':
        options.connections = Number(value)
        break
      case '--port':
        options.port = Number(value)
        break
      case '--host':
        options.host = value
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isFinite(options.duration) || options.duration < 1) {
    throw new Error(`Invalid duration: ${options.duration}`)
  }
  if (!Number.isInteger(options.connections) || options.connections < 1) {
    throw new Error(`Invalid connection count: ${options.connections}`)
  }

  return options
}

/**
 * Builds the server of the benchmark.
 *
 * @returns {object} the Fastify instance
 */
function buildServer () {
  const server = fastify({ logger: false })

  // The v6 route: the output validation of the framework shapes the payload
  // and the native `JSON.stringify` serializes it.
  server.get('/v6', { schema: { response: { 200: responseSchema } } }, async function (request, reply) {
    return reply.send(payload)
  })

  // The v5 like route: the custom serializer owns the wire format, the output
  // validation is skipped.
  const fjsSerializer = require('fast-json-stringify')(responseSchema)
  server.get('/fjs', async function (request, reply) {
    reply.serializer(fjsSerializer)
    return reply.send(payload)
  })

  return server
}

/**
 * Measures the request rate of one route.
 *
 * @param {string} url the url of the route
 * @param {object} options the options of the script
 * @returns {Promise<number>} the average requests per second
 */
async function measureRoute (url, options) {
  const result = await autocannon({
    url,
    connections: options.connections,
    duration: options.duration,
    pipelining: 1
  })

  return result.requests.average
}

/**
 * Runs the benchmark.
 *
 * @returns {Promise<number>} the exit code
 */
async function main () {
  const options = parseArgs(process.argv.slice(2))

  const server = buildServer()
  await server.listen({ port: options.port, host: options.host })

  const base = `http://${options.host}:${options.port}`
  console.log(`node ${process.version} (v8 ${process.versions.v8}) — ` +
    `${options.connections} connections, ${options.duration}s per route`)

  const v6 = await measureRoute(`${base}/v6`, options)
  const fjs = await measureRoute(`${base}/fjs`, options)

  console.log('')
  console.log(`${'route'.padEnd(17)}requests/s`)
  console.log(`${'-'.repeat(16)} ${'-'.repeat(11)}`)
  console.log(`${'/v6'.padEnd(17)}${Math.round(v6).toLocaleString('en-US')}`)
  console.log(`${'/fjs'.padEnd(17)}${Math.round(fjs).toLocaleString('en-US')}`)
  console.log('')
  console.log(`summary: the v6 path answers ${(v6 / fjs * 100).toFixed(0)}% of the requests ` +
    `of the fjs path (${(1e6 / v6).toFixed(2)}us/op against ${(1e6 / fjs).toFixed(2)}us/op)`)

  await server.close()

  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`The benchmark cannot run: ${error.message}`)
    process.exitCode = 1
  })
