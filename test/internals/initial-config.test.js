'use strict'

const { test, before } = require('node:test')
const Fastify = require('../..')
const helper = require('../helper')
const http = require('node:http')
const pino = require('pino')
const split = require('split2')
const deepClone = require('rfdc')({ circles: true, proto: false })
const { deepFreezeObject } = require('../../lib/initial-config-validation').utils
const validateConfig = require('../../lib/config-validator')

const { buildCertificate } = require('../build-certificate')

process.removeAllListeners('warning')

/**
 * Collects the warnings that the process emits while `fn` runs.
 *
 * Node.js emits the `warning` event asynchronously: the listener must wait
 * for the event instead of asserting synchronously.
 *
 * @param {function} fn the code that emits the warnings
 * @returns {Promise<object[]>} the warnings that arrived
 */
function collectWarnings (fn) {
  return new Promise((resolve) => {
    const warnings = []
    const onWarning = (warning) => {
      warnings.push(warning)
    }

    process.on('warning', onWarning)
    try {
      fn()
    } finally {
      setImmediate(() => {
        process.removeListener('warning', onWarning)
        resolve(warnings)
      })
    }
  })
}

let localhost
let localhostForURL

before(async function () {
  await buildCertificate();
  [localhost, localhostForURL] = await helper.getLoopbackHost()
})

test('Fastify.initialConfig is an object', t => {
  t.plan(1)
  t.assert.ok(typeof Fastify().initialConfig === 'object')
})

test('without options passed to Fastify, initialConfig should expose default values', t => {
  t.plan(1)

  const fastifyDefaultOptions = {
    connectionTimeout: 0,
    keepAliveTimeout: 72000,
    maxRequestsPerSocket: 0,
    requestTimeout: 0,
    handlerTimeout: 0,
    bodyLimit: 1024 * 1024,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    pluginTimeout: 10000,
    requestIdHeader: false,
    http2SessionTimeout: 72000,
    exposeHeadRoutes: true,
    routerOptions: {
      allowUnsafeRegex: false,
      caseSensitive: true,
      compile: false,
      constraints: undefined,
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      maxParamLength: 100,
      useSemicolonDelimiter: false
    }
  }

  t.assert.deepStrictEqual(Fastify().initialConfig, fastifyDefaultOptions)
})

test('Fastify.initialConfig should expose all options', t => {
  t.plan(22)

  const serverFactory = (handler, opts) => {
    const server = http.createServer((req, res) => {
      handler(req, res)
    })

    return server
  }

  const versionStrategy = {
    name: 'version',
    storage: function () {
      const versions = {}
      return {
        get: (version) => { return versions[version] || null },
        set: (version, store) => { versions[version] = store }
      }
    },
    deriveConstraint: (req, ctx) => {
      return req.headers.accept
    },
    validate () { return true }
  }

  let reqId = 0
  const options = {
    http2: true,
    https: {
      key: global.context.key,
      cert: global.context.cert
    },
    connectionTimeout: 0,
    keepAliveTimeout: 72000,
    bodyLimit: 1049600,
    onProtoPoisoning: 'remove',
    serverFactory,
    requestIdHeader: 'request-id-alt',
    pluginTimeout: 20000,
    genReqId: function (req) {
      return reqId++
    },
    loggerInstance: pino({ level: 'info' }),
    trustProxy: function myTrustFn (address, hop) {
      return address === '1.2.3.4' || hop === 1
    },
    routerOptions: {
      allowUnsafeRegex: false,
      caseSensitive: true,
      constraints: {
        version: versionStrategy
      },
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
      maxParamLength: 200,
      querystringParser: str => str,
      useSemicolonDelimiter: false
    }
  }

  const fastify = Fastify(options)

  t.assert.strictEqual(fastify.initialConfig.http2, true)
  t.assert.strictEqual(fastify.initialConfig.https, true, 'for security reason the key cert is hidden')
  t.assert.strictEqual(fastify.initialConfig.connectionTimeout, 0)
  t.assert.strictEqual(fastify.initialConfig.keepAliveTimeout, 72000)
  t.assert.strictEqual(fastify.initialConfig.bodyLimit, 1049600)
  t.assert.strictEqual(fastify.initialConfig.onProtoPoisoning, 'remove')
  t.assert.strictEqual(fastify.initialConfig.requestIdHeader, 'request-id-alt')
  t.assert.strictEqual(fastify.initialConfig.pluginTimeout, 20000)

  // obfuscated options:
  t.assert.strictEqual(fastify.initialConfig.serverFactory, undefined)
  t.assert.strictEqual(fastify.initialConfig.trustProxy, undefined)
  t.assert.strictEqual(fastify.initialConfig.genReqId, undefined)
  t.assert.strictEqual(fastify.initialConfig.childLoggerFactory, undefined)
  t.assert.strictEqual(fastify.initialConfig.logger, undefined)
  t.assert.strictEqual(fastify.initialConfig.trustProxy, undefined)

  // router options
  t.assert.strictEqual(fastify.initialConfig.routerOptions.allowUnsafeRegex, false)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.caseSensitive, true)
  t.assert.ok(fastify.initialConfig.routerOptions.constraints.version)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.ignoreTrailingSlash, true)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.ignoreDuplicateSlashes, true)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.maxParamLength, 200)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.querystringParser, undefined)
  t.assert.strictEqual(fastify.initialConfig.routerOptions.useSemicolonDelimiter, false)
})

test('Should throw if you try to modify Fastify.initialConfig', t => {
  t.plan(8)

  const fastify = Fastify({ keepAliveTimeout: 1, routerOptions: { ignoreTrailingSlash: true } })
  try {
    fastify.initialConfig.keepAliveTimeout = 2
    t.assert.fail()
  } catch (error) {
    t.assert.ok(error instanceof TypeError)
    t.assert.strictEqual(error.message, "Cannot assign to read only property 'keepAliveTimeout' of object '#<Object>'")
    t.assert.ok(error.stack)
    t.assert.ok(true)
  }
  try {
    fastify.initialConfig.routerOptions.ignoreTrailingSlash = false
    t.assert.fail()
  } catch (error) {
    t.assert.ok(error instanceof TypeError)
    t.assert.strictEqual(error.message, "Cannot assign to read only property 'ignoreTrailingSlash' of object '#<Object>'")
    t.assert.ok(error.stack)
    t.assert.ok(true)
  }
})

test('We must avoid shallow freezing and ensure that the whole object is freezed', t => {
  t.plan(4)

  const fastify = Fastify({
    https: {
      allowHTTP1: true,
      key: global.context.key,
      cert: global.context.cert
    }
  })

  try {
    fastify.initialConfig.https.allowHTTP1 = false
    t.assert.fail()
  } catch (error) {
    t.assert.ok(error instanceof TypeError)
    t.assert.strictEqual(error.message, "Cannot assign to read only property 'allowHTTP1' of object '#<Object>'")
    t.assert.ok(error.stack)
    t.assert.deepStrictEqual(fastify.initialConfig.https, {
      allowHTTP1: true
    }, 'key cert removed')
  }
})

test('https value check', t => {
  t.plan(1)

  const fastify = Fastify({})
  t.assert.ok(!fastify.initialConfig.https)
})

test('Return an error if options do not match the validation schema', t => {
  t.plan(6)

  try {
    Fastify({ ignoreTrailingSlash: 'string instead of boolean' })

    t.assert.fail()
  } catch (error) {
    t.assert.ok(error instanceof Error)
    t.assert.strictEqual(error.name, 'FastifyError')
    t.assert.strictEqual(error.message, 'Invalid initialization options: \'["must be boolean"]\'')
    t.assert.strictEqual(error.code, 'FST_ERR_INIT_OPTS_INVALID')
    t.assert.ok(error.stack)
    t.assert.ok(true)
  }
})

test('Original options must not be frozen', t => {
  t.plan(4)

  const originalOptions = {
    https: {
      allowHTTP1: true,
      key: global.context.key,
      cert: global.context.cert
    }
  }

  const fastify = Fastify(originalOptions)

  t.assert.strictEqual(Object.isFrozen(originalOptions), false)
  t.assert.strictEqual(Object.isFrozen(originalOptions.https), false)
  t.assert.strictEqual(Object.isFrozen(fastify.initialConfig), true)
  t.assert.strictEqual(Object.isFrozen(fastify.initialConfig.https), true)
})

test('Original options must not be altered (test deep cloning)', t => {
  t.plan(3)

  const originalOptions = {
    https: {
      allowHTTP1: true,
      key: global.context.key,
      cert: global.context.cert
    }
  }

  const originalOptionsClone = deepClone(originalOptions)

  const fastify = Fastify(originalOptions)

  // initialConfig has been triggered
  t.assert.strictEqual(Object.isFrozen(fastify.initialConfig), true)

  // originalOptions must not have been altered
  t.assert.deepStrictEqual(originalOptions.https.key, originalOptionsClone.https.key)
  t.assert.deepStrictEqual(originalOptions.https.cert, originalOptionsClone.https.cert)
})

test('Should not have issues when passing stream options to Pino.js', (t, done) => {
  t.plan(17)

  const stream = split(JSON.parse)

  const originalOptions = {
    logger: {
      level: 'trace',
      stream
    },
    routerOptions: {
      ignoreTrailingSlash: true
    }
  }

  let fastify

  try {
    fastify = Fastify(originalOptions)
    fastify.setChildLoggerFactory(function (logger, bindings, opts) {
      bindings.someBinding = 'value'
      return logger.child(bindings, opts)
    })

    t.assert.ok(typeof fastify === 'object')
    t.assert.deepStrictEqual(fastify.initialConfig, {
      connectionTimeout: 0,
      keepAliveTimeout: 72000,
      maxRequestsPerSocket: 0,
      requestTimeout: 0,
      handlerTimeout: 0,
      bodyLimit: 1024 * 1024,
      onProtoPoisoning: 'error',
      onConstructorPoisoning: 'error',
      pluginTimeout: 10000,
      requestIdHeader: false,
      http2SessionTimeout: 72000,
      exposeHeadRoutes: true,
      routerOptions: {
        allowUnsafeRegex: false,
        caseSensitive: true,
        compile: false,
        constraints: undefined,
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: false,
        maxParamLength: 100,
        useSemicolonDelimiter: false
      }
    })
  } catch (error) {
    t.assert.fail()
  }

  fastify.get('/', function (req, reply) {
    t.assert.ok(req.log)
    reply.send({ hello: 'world' })
  })

  stream.once('data', listenAtLogLine => {
    t.assert.ok(listenAtLogLine, 'listen at log message is ok')

    stream.once('data', line => {
      const id = line.reqId
      t.assert.ok(line.reqId, 'reqId is defined')
      t.assert.strictEqual(line.someBinding, 'value', 'child logger binding is set')
      t.assert.ok(line.req, 'req is defined')
      t.assert.strictEqual(line.msg, 'incoming request', 'message is set')
      t.assert.strictEqual(line.req.method, 'GET', 'method is get')

      stream.once('data', line => {
        t.assert.strictEqual(line.reqId, id)
        t.assert.ok(line.reqId, 'reqId is defined')
        t.assert.strictEqual(line.someBinding, 'value', 'child logger binding is set')
        t.assert.ok(line.res, 'res is defined')
        t.assert.strictEqual(line.msg, 'request completed', 'message is set')
        t.assert.strictEqual(line.res.statusCode, 200, 'statusCode is 200')
        t.assert.ok(line.responseTime, 'responseTime is defined')
      })
    })
  })

  fastify.listen({ port: 0, host: localhost }, err => {
    t.assert.ifError(err)
    t.after(() => { fastify.close() })

    http.get(`http://${localhostForURL}:${fastify.server.address().port}`, () => {
      done()
    })
  })
})

test('deepFreezeObject() should not throw on TypedArray', t => {
  t.plan(5)

  const object = {
    buffer: Buffer.from(global.context.key),
    dataView: new DataView(new ArrayBuffer(16)),
    float: 1.1,
    integer: 1,
    object: {
      nested: { string: 'string' }
    },
    stream: split(JSON.parse),
    string: 'string'
  }

  try {
    const frozenObject = deepFreezeObject(object)

    // Buffers should not be frozen, as they are Uint8Array inherited instances
    t.assert.strictEqual(Object.isFrozen(frozenObject.buffer), false)

    t.assert.strictEqual(Object.isFrozen(frozenObject), true)
    t.assert.strictEqual(Object.isFrozen(frozenObject.object), true)
    t.assert.strictEqual(Object.isFrozen(frozenObject.object.nested), true)

    t.assert.ok(true)
  } catch (error) {
    t.assert.fail()
  }
})

test('pluginTimeout should be parsed correctly', t => {
  const withDisabledTimeout = Fastify({ pluginTimeout: '0' })
  t.assert.strictEqual(withDisabledTimeout.initialConfig.pluginTimeout, 0)
  const withInvalidTimeout = Fastify({ pluginTimeout: undefined })
  t.assert.strictEqual(withInvalidTimeout.initialConfig.pluginTimeout, 10000)
})

test('Should not mutate the options object outside Fastify', async t => {
  const options = Object.freeze({})

  try {
    Fastify(options)
    t.assert.ok(true)
  } catch (error) {
    t.assert.fail(error.message)
  }
})

test('the serializerOpts server option is rejected at boot', t => {
  t.plan(5)

  try {
    Fastify({ serializerOpts: { rounding: 'ceil' } })

    t.assert.fail()
  } catch (error) {
    t.assert.ok(error instanceof Error)
    t.assert.strictEqual(error.name, 'FastifyError')
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_OPTS_REMOVED')
    t.assert.ok(error.message.includes('serializerOpts'), 'the message names the option')
    t.assert.ok(error.message.includes('migration guide'), 'the message points at the migration guide')
  }
})

test('an undefined serializerOpts is not a present option', t => {
  t.plan(1)

  const fastify = Fastify({ serializerOpts: undefined })
  t.assert.ok(fastify)
})

test('the generated validator rejects the serializerOpts key', t => {
  t.plan(2)

  t.assert.strictEqual(validateConfig({ serializerOpts: { rounding: 'ceil' } }), false)
  t.assert.ok(validateConfig.errors.some(error => error.instancePath === '/serializerOpts'))
})

test('the serializer factory is rejected at boot', t => {
  t.plan(3)

  try {
    Fastify({ compilersFactory: { buildSerializer: () => () => JSON.stringify({}) } })

    t.assert.fail()
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('compilersFactory.buildSerializer'))
    t.assert.ok(error.message.includes('migration guide'))
  }
})

test('the renamed input factory key is rejected at boot', t => {
  t.plan(3)

  try {
    Fastify({ compilersFactory: { buildValidator: () => () => true } })

    t.assert.fail()
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_BUILD_VALIDATOR_RENAMED')
    t.assert.ok(error.message.includes('buildInputValidator'))
    t.assert.ok(error.message.includes('migration guide'))
  }
})

test('the serializer factory of the schema controller is rejected at boot', t => {
  t.plan(2)

  try {
    Fastify({ schemaController: { compilersFactory: { buildSerializer: () => () => JSON.stringify({}) } } })

    t.assert.fail()
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('compilersFactory.buildSerializer'))
  }
})

test('setSerializerCompiler and the serializerCompiler accessor fail explicitly', t => {
  t.plan(3)

  const fastify = Fastify()

  try {
    fastify.setSerializerCompiler(() => () => JSON.stringify({}))
    t.assert.fail()
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('migration guide'))
  }

  try {
    // The accessor must not expose a serializer compiler that does not exist.
    const compiler = fastify.serializerCompiler
    t.assert.fail(`the accessor returned ${compiler}`)
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
  }
})

test('the route level serializerCompiler option is rejected at registration', t => {
  t.plan(2)

  const fastify = Fastify()

  try {
    fastify.get('/', { serializerCompiler: () => () => JSON.stringify({}) }, () => {})
    t.assert.fail()
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('serializerCompiler'))
  }
})

test('the deprecated top-level ajv option emits the deprecation warning once per server', async t => {
  t.plan(5)

  const warnings = await collectWarnings(() => {
    Fastify({ ajv: { customOptions: {} } })
  })

  t.assert.strictEqual(warnings.length, 1, 'the deprecated option must emit exactly one warning per server')
  t.assert.strictEqual(warnings[0]?.code, 'FSTDEP026')
  t.assert.strictEqual(warnings[0]?.name, 'FastifyDeprecation')
  t.assert.ok(warnings[0]?.message.includes('schemaController.inputValidatorOptions'))

  // The warning is not emitted once per process: every server that uses the
  // deprecated option warns.
  const moreWarnings = await collectWarnings(() => {
    Fastify({ ajv: { customOptions: {} } })
    Fastify({ ajv: { customOptions: {} } })
  })

  t.assert.strictEqual(moreWarnings.length, 2, 'the deprecated option must emit one warning per server')
})

test('the schema controller input validator options emit no deprecation warning', async t => {
  t.plan(2)

  const warnings = await collectWarnings(() => {
    Fastify({ schemaController: { inputValidatorOptions: { customOptions: {} } } })
    Fastify()
  })

  t.assert.strictEqual(warnings.length, 0, 'the new option must not emit any warning')
  t.assert.strictEqual(warnings[0], undefined)
})

test('the schema controller input validator options configure the input pool', async t => {
  t.plan(2)

  const fastify = Fastify({
    schemaController: {
      inputValidatorOptions: {
        // The option states the coercion of the scalars explicitly: the
        // default pool of the framework uses `coerceTypes: 'array'`, which
        // coerces them too.
        customOptions: { coerceTypes: true }
      }
    }
  })

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: { id: { type: 'number' } }
      }
    }
  }, (request, reply) => {
    reply.send({ id: request.query.id, type: typeof request.query.id })
  })

  const response = await fastify.inject({ method: 'GET', url: '/?id=42' })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(response.json(), { id: 42, type: 'number' })
})

test('the deprecated top-level ajv option still configures the input pool', async t => {
  t.plan(2)

  const fastify = Fastify({
    ajv: {
      customOptions: { coerceTypes: true }
    }
  })

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: { id: { type: 'number' } }
      }
    }
  }, (request, reply) => {
    reply.send({ id: request.query.id, type: typeof request.query.id })
  })

  const response = await fastify.inject({ method: 'GET', url: '/?id=42' })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(response.json(), { id: 42, type: 'number' })
})

test('the schema controller input validator options win over the deprecated ajv option', async t => {
  t.plan(4)

  const warnings = await collectWarnings(() => {
    Fastify({
      ajv: {
        // The deprecated option does not coerce the scalars.
        customOptions: { coerceTypes: false }
      },
      schemaController: {
        inputValidatorOptions: {
          customOptions: { coerceTypes: true }
        }
      }
    })
  })

  t.assert.strictEqual(warnings.length, 1, 'the deprecated option was used: it must warn')
  t.assert.strictEqual(warnings[0]?.code, 'FSTDEP026')

  const fastify = Fastify({
    ajv: {
      customOptions: { coerceTypes: false }
    },
    schemaController: {
      inputValidatorOptions: {
        customOptions: { coerceTypes: true }
      }
    }
  })

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: { id: { type: 'number' } }
      }
    }
  }, (request, reply) => {
    reply.send({ id: request.query.id, type: typeof request.query.id })
  })

  const response = await fastify.inject({ method: 'GET', url: '/?id=42' })

  t.assert.strictEqual(response.statusCode, 200, 'the new option wins: the deprecated one does not coerce the scalars')
  t.assert.deepStrictEqual(response.json(), { id: 42, type: 'number' })
})
