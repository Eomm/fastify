'use strict'

// Independent behavioural audit of the phase 1 claims (output validation
// alongside fjs). Every test here is written from the requirement, not from
// the implementation, so it can fail if the claim is not actually backed by
// an automated check.

const { test } = require('node:test')
const Fastify = require('../..')
const { getResponseSchemaEntry } = require('../../lib/schemas')
const {
  kRouteContext,
  kSchemaController,
  kSchemaResponse,
  kSchemaOutputValidator
} = require('../../lib/symbols')

// ---------------------------------------------------------------------------
// 01-01 / task 1 — the output Ajv pool
// ---------------------------------------------------------------------------

test('01-01/T1: the output pool does not coerce while the input pool still does (two distinct pools)', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.post('/in', {
    schema: {
      body: { type: 'object', properties: { n: { type: 'number' } } }
    }
  }, async (req) => ({ n: req.body.n }))

  app.get('/out', {
    schema: {
      response: { 200: { type: 'object', properties: { n: { type: 'number' } } } }
    }
  }, async () => ({ n: '42' }))

  // The input pool keeps the framework input semantics (it coerces).
  const input = await app.inject({ method: 'POST', url: '/in', payload: { n: '42' } })
  t.assert.strictEqual(input.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(input.payload), { n: 42 })

  // The output pool has its own instance with `coerceTypes: false`.
  const output = await app.inject({ method: 'GET', url: '/out' })
  t.assert.strictEqual(output.statusCode, 500)
  t.assert.strictEqual(JSON.parse(output.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
})

test('01-01/T1: the output pool is seeded with the shared schema documents', async (t) => {
  let seenExternalSchemas = null
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator (externalSchemas, options) {
          seenExternalSchemas = externalSchemas
          t.assert.ok(options === undefined || typeof options === 'object', 'the factory receives the output validator options')
          const Ajv = require('ajv')
          const ajv = new Ajv({ strict: false })
          for (const schema of Object.values(externalSchemas)) {
            ajv.addSchema(schema)
          }
          return ({ schema }) => ajv.compile(schema)
        }
      }
    }
  })
  t.after(() => app.close())

  app.addSchema({
    $id: 'http://fastify.test/audit-shared.json',
    type: 'object',
    properties: { shared: { type: 'string' } },
    required: ['shared']
  })

  app.get('/', {
    schema: {
      response: {
        200: { $ref: 'http://fastify.test/audit-shared.json' }
      }
    }
  }, async () => ({ shared: 'yes' }))

  await app.inject('/')

  t.assert.ok(seenExternalSchemas, 'the factory has been called')
  t.assert.ok(
    Object.keys(seenExternalSchemas).includes('http://fastify.test/audit-shared.json'),
    'the document published through addSchema is part of the external schemas of the output pool'
  )
})

test('01-01/T1: the output side keeps its own bucket - addSchema never writes to it', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.addSchema({ $id: 'http://fastify.test/audit-bucket.json', type: 'object' })

  app.get('/', {
    schema: { response: { 200: { type: 'object' } } }
  }, async () => ({}))

  await app.inject('/')
  await app.ready()

  const controller = app[kSchemaController]
  const inputDocuments = controller.getSchemas()
  const outputDocuments = controller.getOutputSchemas()

  t.assert.ok(
    Object.keys(inputDocuments).includes('http://fastify.test/audit-bucket.json'),
    'the input bucket holds the shared document'
  )
  t.assert.ok(
    !Object.keys(outputDocuments).includes('http://fastify.test/audit-bucket.json'),
    'the output bucket does not hold the shared document'
  )
  t.assert.notStrictEqual(outputDocuments, inputDocuments, 'the two buckets are not the same object')
})

test('01-01/T1: the compiled output validators live on the route context and are reused across requests', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  const seen = []
  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { a: { type: 'string' } } } } }
  }, async function (req, reply) {
    seen.push(reply[kRouteContext][kSchemaOutputValidator])
    return { a: 'x' }
  })

  await app.inject('/')
  await app.inject('/')

  t.assert.strictEqual(seen.length, 2)
  t.assert.ok(seen[0], 'the route context carries the compiled output validators')
  t.assert.strictEqual(typeof seen[0]['200'], 'function', 'the validator is stored under the status code')
  t.assert.strictEqual(seen[0], seen[1], 'the very same compiled validator is used for every request')
})

test('01-01/T1: getResponseSchemaEntry is schema agnostic - the bucket is selected by the symbol', (t) => {
  const serializerEntry = function serializer () {}
  const validatorEntry = function validator () {}
  const context = {
    [kSchemaResponse]: { 200: serializerEntry },
    [kSchemaOutputValidator]: { 200: validatorEntry }
  }

  t.assert.strictEqual(
    getResponseSchemaEntry(context, 200, 'application/json'),
    serializerEntry,
    'without the option the helper looks into the serializer bucket'
  )
  t.assert.strictEqual(
    getResponseSchemaEntry(context, 200, 'application/json', { symbol: kSchemaOutputValidator }),
    validatorEntry,
    'with the option the helper looks into the output validator bucket'
  )
})

// ---------------------------------------------------------------------------
// 01-01 / task 2 — the lookup per status code and per media type
// ---------------------------------------------------------------------------

test('01-01/T2: the output validator is selected per status code and per media type of a content map', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  const contentSchema = {
    200: {
      content: {
        'application/json': {
          schema: { type: 'object', properties: { n: { type: 'number' } } }
        },
        'application/vnd.api+json': {
          schema: { type: 'object', properties: { n: { type: 'string' } } }
        }
      }
    },
    404: {
      content: {
        'application/json': {
          schema: { type: 'object', properties: { n: { type: 'boolean' } } }
        }
      }
    }
  }

  app.get('/vnd', { schema: { response: contentSchema } }, async (req, reply) => {
    reply.type('application/vnd.api+json')
    return { n: 42 }
  })

  app.get('/json', { schema: { response: contentSchema } }, async () => ({ n: 42 }))

  app.get('/notfound', { schema: { response: contentSchema } }, async (req, reply) => {
    reply.code(404)
    return { n: true }
  })

  // The `application/vnd.api+json` entry is the one that applies: it wants a
  // string, the payload carries a number.
  const vnd = await app.inject('/vnd')
  t.assert.strictEqual(vnd.statusCode, 500)
  t.assert.strictEqual(JSON.parse(vnd.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.match(JSON.parse(vnd.payload).message, /must be string/)

  // The `application/json` entry is the one that applies: it wants a number.
  const json = await app.inject('/json')
  t.assert.strictEqual(json.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(json.payload), { n: 42 })

  // The `404` entry is the one that applies.
  const notFound = await app.inject('/notfound')
  t.assert.strictEqual(notFound.statusCode, 404)
  t.assert.deepStrictEqual(JSON.parse(notFound.payload), { n: true })
})

// ---------------------------------------------------------------------------
// 01-01 / task 3 — the user's options and the user's factory
// ---------------------------------------------------------------------------

test('01-01/T3: the output pool honours schemaController.outputValidatorOptions (allErrors)', async (t) => {
  const build = (customOptions) => {
    const app = Fastify({
      schemaController: { outputValidatorOptions: { customOptions } }
    })
    app.addHook('onError', (request, reply, error, done) => {
      app.capturedError = error
      done()
    })
    app.get('/', {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' }
            }
          }
        }
      }
    }, async () => ({ a: 'x', b: 'y' }))
    return app
  }

  const withDefault = build({})
  t.after(() => withDefault.close())
  const withAllErrors = build({ allErrors: true })
  t.after(() => withAllErrors.close())

  const defaultResult = await withDefault.inject('/')
  t.assert.strictEqual(defaultResult.statusCode, 500)
  t.assert.strictEqual(withDefault.capturedError.validation.length, 1, 'the framework default reports one error')

  const allErrorsResult = await withAllErrors.inject('/')
  t.assert.strictEqual(allErrorsResult.statusCode, 500)
  t.assert.strictEqual(withAllErrors.capturedError.validation.length, 2, 'the user option reports every error')
})

test('01-01/T3: a user supplied compilersFactory.buildOutputValidator replaces the default output factory', async (t) => {
  const calls = { factory: 0, compiler: 0, validator: 0 }
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator (externalSchemas, options) {
          calls.factory++
          t.assert.deepStrictEqual(Object.keys(externalSchemas), [], 'the factory receives the external schemas')
          t.assert.strictEqual(options, undefined, 'the factory receives the output validator options')
          return ({ schema, httpStatus, contentType }) => {
            calls.compiler++
            t.assert.strictEqual(httpStatus, '200')
            t.assert.strictEqual(contentType, undefined)
            t.assert.deepStrictEqual(schema, { type: 'object' })
            return (payload) => {
              calls.validator++
              return payload.accepted === true
            }
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.get('/ok', { schema: { response: { 200: { type: 'object' } } } }, async () => ({ accepted: true }))
  app.get('/ko', { schema: { response: { 200: { type: 'object' } } } }, async () => ({ accepted: false }))

  await app.ready()

  t.assert.strictEqual(calls.factory, 1, 'the factory is called once, when the pool is built')
  const compilerCallsAtRegistration = calls.compiler
  t.assert.ok(compilerCallsAtRegistration >= 2, 'the compiler is called at route registration, once per route and status code')
  t.assert.strictEqual(calls.validator, 0, 'no validator has run before the first request')

  const ok = await app.inject('/ok')
  t.assert.strictEqual(ok.statusCode, 200)
  t.assert.strictEqual(calls.validator, 1, 'the validator of the user factory runs on every response')
  t.assert.strictEqual(calls.compiler, compilerCallsAtRegistration, 'the schema is not compiled again at request time')

  const ko = await app.inject('/ko')
  t.assert.strictEqual(ko.statusCode, 500)
  t.assert.strictEqual(JSON.parse(ko.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(calls.validator, 2, 'the validator of the user factory runs on every response')
  t.assert.strictEqual(calls.compiler, compilerCallsAtRegistration, 'the schema is not compiled again at request time')
})

test('01-03/T2: the user factory resolves the shared schema documents in its own pool', async (t) => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator (externalSchemas) {
          const Ajv = require('ajv')
          const ajv = new Ajv({ strict: false })
          for (const schema of Object.values(externalSchemas)) {
            ajv.addSchema(schema)
          }
          return ({ schema }) => ajv.compile(schema)
        }
      }
    }
  })
  t.after(() => app.close())

  app.addSchema({
    $id: 'http://fastify.test/audit-user-pool.json',
    type: 'object',
    properties: { shared: { type: 'string' } },
    required: ['shared']
  })

  app.get('/', {
    schema: { response: { 200: { $ref: 'http://fastify.test/audit-user-pool.json' } } }
  }, async () => ({ shared: 'yes' }))

  app.get('/bad', {
    schema: { response: { 200: { $ref: 'http://fastify.test/audit-user-pool.json' } } }
  }, async () => ({ shared: 42 }))

  const ok = await app.inject('/')
  t.assert.strictEqual(ok.statusCode, 200)

  const bad = await app.inject('/bad')
  t.assert.strictEqual(bad.statusCode, 500)
  t.assert.strictEqual(JSON.parse(bad.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
})

// ---------------------------------------------------------------------------
// 01-02 / task 1 — the runtime stage
// ---------------------------------------------------------------------------

test('01-02/T1: the validation stage runs before the preSerialization hooks', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.addHook('preSerialization', async (request, reply, payload) => {
    // The payload is already valid here: a type violation introduced now is
    // never validated again.
    payload.injected = 'not a number'
    return payload
  })

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async () => ({ n: 1 }))

  const result = await app.inject('/')
  // The payload the `preSerialization` hook produced is never validated
  // again: the response is not an output validation failure.
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(result.payload), { n: 1 })
})

test('01-02/T1: a route without schema.response is not validated', async (t) => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the validator has been invoked for a route without schema.response')
            return true
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.get('/', async () => ({ anything: true }))

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(result.payload), { anything: true })
})

test('01-02/T1: the status code lookup is lenient', async (t) => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the validator has been invoked for an unmatched status code')
            return true
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async (req, reply) => {
    reply.code(418)
    return { n: 'not a number' }
  })

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 418)
  t.assert.deepStrictEqual(JSON.parse(result.payload), { n: 'not a number' })
})

test('01-02/T1: the content type lookup fails closed', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': { schema: { type: 'object', properties: { n: { type: 'number' } } } }
          }
        }
      }
    }
  }, async (req, reply) => {
    reply.type('application/vnd.api+json')
    return { n: 1 }
  })

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  t.assert.strictEqual(JSON.parse(result.payload).code, 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN')
})

test('01-02/T1: the null payload is not validated', async (t) => {
  let validated = 0
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            validated++
            return true
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async (req, reply) => {
    reply.send(null)
  })

  const result = await app.inject('/')
  t.assert.strictEqual(validated, 0, 'the validator has never been invoked')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{}')
})

test('01-02/T1: a custom reply.serializer(fn) skips the validation', async (t) => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the validator has been invoked for a reply with a custom serializer')
            return true
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async (req, reply) => {
    reply.serializer((payload) => JSON.stringify({ custom: payload }))
    return { n: 'not a number' }
  })

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(result.payload), { custom: { n: 'not a number' } })
})

test('01-02/T1: an $async output validator is awaited before the response is sent', async (t) => {
  const app = Fastify({
    schemaController: {
      outputValidatorOptions: {
        plugins: [
          (ajv) => {
            ajv.addKeyword({
              keyword: 'auditIsEven',
              async: true,
              validate: async (schema, data) => {
                await new Promise(resolve => setTimeout(resolve, 20))
                return data % 2 === 0
              }
            })
          }
        ]
      }
    }
  })
  t.after(() => app.close())

  // A unique shared document gives this server its own output pool.
  app.addSchema({ $id: 'http://fastify.test/audit-async-fixture.json', type: 'object' })

  const schema = {
    $async: true,
    type: 'object',
    properties: { count: { type: 'number', auditIsEven: true } }
  }

  app.get('/valid', { schema: { response: { 200: schema } } }, async () => ({ count: 4 }))
  app.get('/invalid', { schema: { response: { 200: schema } } }, async () => ({ count: 3 }))

  const valid = await app.inject('/valid')
  t.assert.strictEqual(valid.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(valid.payload), { count: 4 })

  // The keyword is really registered: the violating payload is rejected, the
  // case cannot pass vacuously.
  const invalid = await app.inject('/invalid')
  t.assert.strictEqual(invalid.statusCode, 500)
  t.assert.strictEqual(JSON.parse(invalid.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
})

test('01-02/T1: a rejected async validator is normalized into the framework error shape', async (t) => {
  let capturedError = null
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => async () => {
            const error = new Error('async validation failed')
            error.errors = [{ instancePath: '/n', message: 'must be number' }]
            throw error
          }
        }
      }
    }
  })
  t.after(() => app.close())

  app.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async () => ({ n: 'x' }))

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  t.assert.strictEqual(JSON.parse(result.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.deepStrictEqual(capturedError.validation, [{ instancePath: '/n', message: 'must be number' }])
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

test('01-02/T1: the FST_ERR_OUTPUT_VALIDATION error contract', async (t) => {
  let capturedError = null
  const app = Fastify()
  t.after(() => app.close())

  app.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async () => ({ n: 'not a number' }))

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.statusCode, 500)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(body.error, 'Internal Server Error')
  t.assert.ok(body.message.startsWith('Response validation failed. Errors: '))

  t.assert.ok(capturedError, 'the error reached the error handler')
  t.assert.strictEqual(capturedError.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(capturedError.statusCode, 500)
  t.assert.ok(Array.isArray(capturedError.validation))
  t.assert.ok(capturedError.validation.length > 0, 'the validation array is not empty')
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

// ---------------------------------------------------------------------------
// 01-02 / task 2 — the reconciliation of the fjs-era expectations
// ---------------------------------------------------------------------------

test('01-02/T2: a wrongly typed response value yields the framework error and not a bare TypeError', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async () => ({ n: 'not a number' }))

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.doesNotMatch(body.message, /TypeError/)
})

test('01-02/T2: the reply serializer still receives the payload untouched', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  let received = null
  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { name: { type: 'string' } } } } }
  }, async (req, reply) => {
    reply.serializer((payload) => {
      received = payload
      return JSON.stringify(payload)
    })
    return { name: 'Foo', work: 'Bar', nick: 'Boo' }
  })

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.deepStrictEqual(received, { name: 'Foo', work: 'Bar', nick: 'Boo' })
})

// ---------------------------------------------------------------------------
// 01-02 / task 3 — the error handler lookup and the validator without errors
// ---------------------------------------------------------------------------

test('01-02/T3: a validator that returns false without an Ajv error array yields the framework error shape', async (t) => {
  let capturedError = null
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => false
        }
      }
    }
  })
  t.after(() => app.close())

  app.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  app.get('/', {
    schema: { response: { 200: { type: 'object', properties: { n: { type: 'number' } } } } }
  }, async () => ({ n: 1 }))

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  t.assert.strictEqual(JSON.parse(result.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.ok(Array.isArray(capturedError.validation), 'the validation is an array')
  t.assert.deepStrictEqual(capturedError.validation, [])
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

test('01-02/T3: the error handler serializer lookup uses the response schema of the error status code', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  app.get('/', {
    schema: {
      response: {
        500: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { message: { type: 'string' } } }
            }
          }
        }
      }
    }
  }, async () => {
    throw new Error('boom')
  })

  const result = await app.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  // The error body is serialized with the 500 schema of the route: only the
  // declared property is on the wire.
  t.assert.deepStrictEqual(JSON.parse(result.payload), { message: 'boom' })
})
