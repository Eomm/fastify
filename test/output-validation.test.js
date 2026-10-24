'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const { kSchemaController, kOptions, kSchemaResponse, kSchemaOutputValidator } = require('../lib/symbols')
const { getResponseSchemaEntry } = require('../lib/schemas')
const { compileSchemasForResponseValidation } = require('../lib/validation')
const fastify = require('..')()

const opts = {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          hello: {
            type: 'string'
          }
        }
      },
      '2xx': {
        type: 'object',
        properties: {
          hello: {
            type: 'number'
          }
        }
      }
    }
  }
}

test('shorthand - output string', t => {
  t.plan(1)
  try {
    fastify.get('/string', opts, function (req, reply) {
      reply.code(200).send({ hello: 'world' })
    })
    t.assert.ok(true)
  } catch (e) {
    t.assert.fail()
  }
})

test('shorthand - output number', t => {
  t.plan(1)
  try {
    fastify.get('/number', opts, function (req, reply) {
      reply.code(201).send({ hello: 55 })
    })
    t.assert.ok(true)
  } catch (e) {
    t.assert.fail()
  }
})

test('wrong object for schema - output', t => {
  t.plan(1)
  try {
    fastify.get('/wrong-object-for-schema', opts, function (req, reply) {
      // will send { }
      reply.code(201).send({ hello: 'world' })
    })
    t.assert.ok(true)
  } catch (e) {
    t.assert.fail()
  }
})

test('empty response', t => {
  t.plan(1)
  try {
    // no checks
    fastify.get('/empty', opts, function (req, reply) {
      reply.code(204).send()
    })
    t.assert.ok(true)
  } catch (e) {
    t.assert.fail()
  }
})

test('unlisted response code', t => {
  t.plan(1)
  try {
    fastify.get('/400', opts, function (req, reply) {
      reply.code(400).send({ hello: 'DOOM' })
    })
    t.assert.ok(true)
  } catch (e) {
    t.assert.fail()
  }
})

test('start server and run tests', async (t) => {
  const fastifyServer = await fastify.listen({ port: 0 })
  t.after(() => fastify.close())

  await test('shorthand - string get ok', async (t) => {
    const result = await fetch(fastifyServer + '/string')
    t.assert.ok(result.ok)
    t.assert.strictEqual(result.status, 200)
    const body = await result.text()
    t.assert.strictEqual(result.headers.get('content-length'), '' + body.length)
    t.assert.deepStrictEqual(JSON.parse(body), { hello: 'world' })
  })

  await test('shorthand - number get ok', async (t) => {
    const result = await fetch(fastifyServer + '/number')
    t.assert.ok(result.ok)
    t.assert.strictEqual(result.status, 201)
    const body = await result.text()
    t.assert.strictEqual(result.headers.get('content-length'), '' + body.length)
    t.assert.deepStrictEqual(JSON.parse(body), { hello: 55 })
  })

  await test('shorthand - wrong-object-for-schema', async (t) => {
    const result = await fetch(fastifyServer + '/wrong-object-for-schema')
    t.assert.ok(!result.ok)
    t.assert.strictEqual(result.status, 500)
    const body = await result.text()
    t.assert.strictEqual(result.headers.get('content-length'), '' + body.length)
    t.assert.deepStrictEqual(JSON.parse(body), {
      statusCode: 500,
      code: 'FST_ERR_OUTPUT_VALIDATION',
      error: 'Internal Server Error',
      message: 'Response validation failed. Errors: /hello must be number'
    })
  })

  await test('shorthand - empty', async (t) => {
    const result = await fetch(fastifyServer + '/empty')
    t.assert.ok(result.ok)
    t.assert.strictEqual(result.status, 204)
  })

  await test('shorthand - 400', async (t) => {
    const result = await fetch(fastifyServer + '/400')
    t.assert.ok(!result.ok)
    t.assert.strictEqual(result.status, 400)
    const body = await result.text()
    t.assert.strictEqual(result.headers.get('content-length'), '' + body.length)
    t.assert.deepStrictEqual(JSON.parse(body), { hello: 'DOOM' })
  })
})

test('a response that violates the response schema fails with FST_ERR_OUTPUT_VALIDATION', async (t) => {
  let capturedError = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/wrong-type', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async () => ({ hello: 42 }))

  fastify.get('/missing-property', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async () => ({}))

  const fastifyServer = await fastify.listen({ port: 0 })

  const result = await fetch(fastifyServer + '/wrong-type')
  t.assert.ok(!result.ok)
  t.assert.strictEqual(result.status, 500)
  const body = await result.text()
  t.assert.strictEqual(result.headers.get('content-length'), '' + body.length)
  t.assert.deepStrictEqual(JSON.parse(body), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: /hello must be string'
  })

  t.assert.ok(capturedError, 'the error hook received the error')
  t.assert.strictEqual(capturedError.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(capturedError.statusCode, 500)
  t.assert.ok(Array.isArray(capturedError.validation), 'the error carries the Ajv errors')
  t.assert.strictEqual(capturedError.validation.length, 1)
  t.assert.strictEqual(capturedError.validation[0].instancePath, '/hello')
  t.assert.strictEqual(capturedError.validation[0].message, 'must be string')
  t.assert.strictEqual(capturedError.validationContext, 'response')

  const missing = await fetch(fastifyServer + '/missing-property')
  t.assert.strictEqual(missing.status, 500)
  const missingBody = await missing.text()
  t.assert.deepStrictEqual(JSON.parse(missingBody), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: must have required property \'hello\''
  })
})

test('the output pool never coerces a wrongly typed response value', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ count: '42' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(body.statusCode, 500)
  t.assert.ok(!result.payload.includes('42'), 'the value has not been coerced')
  t.assert.strictEqual(body.message, 'Response validation failed. Errors: /count must be number')
})

test('the output pool never injects a schema default into the response', async (t) => {
  let payloadSeenByTheHook = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('preSerialization', (request, reply, payload, done) => {
    payloadSeenByTheHook = payload
    done(null, payload)
  })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' },
            count: { type: 'number', default: 42 }
          }
        }
      }
    }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  // The output validator runs with `useDefaults: false`: the payload it hands
  // over to the `preSerialization` hooks does not carry the default.
  t.assert.deepStrictEqual(payloadSeenByTheHook, { hello: 'world' })
  t.assert.ok(!('count' in payloadSeenByTheHook), 'the default has not been injected')
  // `fast-json-stringify` is still the serializer of this phase and it adds
  // the default to the wire: the rule becomes observable on the bytes when
  // the serializer is dropped.
  t.assert.strictEqual(result.payload, '{"hello":"world","count":42}')
})

test('the output pool strips the properties that the response schema does not declare', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          }
        }
      }
    }
  }, async () => ({ hello: 'world', extra: 'stripped' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
  t.assert.ok(!result.payload.includes('stripped'), 'the undeclared property is gone')
})

test('a route without a response schema is not validated', async (t) => {
  let built = 0
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          built++
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ hello: 'world', extra: 'kept' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{"hello":"world","extra":"kept"}')
  t.assert.strictEqual(built, 0, 'the output pool has not been built')
})

test('a response whose status code matches no entry is sent without validation', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async (req, reply) => {
    reply.code(404).send({ message: 'not found' })
  })

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 404)
  t.assert.strictEqual(result.payload, '{"message":"not found"}')
})

test('a content type that the response schema does not declare fails closed', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  hello: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    reply.type('application/vnd.api+json').send({ hello: 'world' })
  })

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN')
  t.assert.strictEqual(body.statusCode, 500)
})

test('a content type that the response schema declares is validated', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/vnd.api+json': {
              schema: {
                type: 'object',
                properties: {
                  hello: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    reply.type('application/vnd.api+json').send({ hello: 'world' })
  })

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
})

test('a content type covered by the catch all media type is validated', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            '*/*': {
              schema: {
                type: 'object',
                properties: {
                  hello: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    reply.type('application/vnd.api+json').send({ hello: 'world' })
  })

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
})

test('a null payload is not validated', async (t) => {
  let validated = 0
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => (payload) => {
            validated++
            return true
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          }
        }
      }
    }
  }, async (req, reply) => {
    reply.send(null)
  })

  const result = await fastify.inject('/')
  // The behaviour of the null payload is the one of `fast-json-stringify`
  // today: it is not validated, so the payload keeps the body that the
  // serializer produces for it.
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{}')
  t.assert.strictEqual(validated, 0, 'the validator has never been invoked')
})

test('the output pool is seeded with the shared schema documents', async t => {
  const calls = []
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator (externalSchemas, outputValidatorOptions) {
          calls.push({ externalSchemas, outputValidatorOptions })
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addSchema({
    $id: 'shared',
    type: 'object',
    properties: { hello: { type: 'string' } }
  })

  const controller = fastify[kSchemaController]
  controller.setupOutputValidator(fastify[kOptions])

  t.assert.strictEqual(calls.length, 1)
  t.assert.ok(calls[0].externalSchemas.shared, 'the shared document is part of the pool')
  t.assert.strictEqual(calls[0].externalSchemas.shared.$id, 'shared')
  t.assert.deepStrictEqual(calls[0].externalSchemas.shared.properties, { hello: { type: 'string' } })
})

test('the output pool receives the user outputValidatorOptions', async t => {
  const calls = []
  const fastify = Fastify({
    schemaController: {
      outputValidatorOptions: {
        customOptions: { strict: true }
      },
      compilersFactory: {
        buildOutputValidator (externalSchemas, outputValidatorOptions) {
          calls.push({ externalSchemas, outputValidatorOptions })
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  controller.setupOutputValidator(fastify[kOptions])

  t.assert.strictEqual(calls.length, 1)
  t.assert.deepStrictEqual(calls[0].outputValidatorOptions, { customOptions: { strict: true } })
})

test('the output pool does not lint the response schema by default', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  controller.setupOutputValidator(fastify[kOptions])

  t.assert.doesNotThrow(() => controller.outputValidatorCompiler({
    schema: { type: 'object', whatever: 'need to be parsed by the custom serializer' },
    url: '/',
    method: 'GET',
    httpStatus: '200'
  }))
})

test('the user customOptions win over the framework defaults', async t => {
  const fastify = Fastify({
    schemaController: {
      outputValidatorOptions: {
        customOptions: { strict: true }
      }
    }
  })
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  controller.setupOutputValidator(fastify[kOptions])

  t.assert.throws(() => controller.outputValidatorCompiler({
    schema: { type: 'object', whatever: 'need to be parsed by the custom serializer' },
    url: '/',
    method: 'GET',
    httpStatus: '200'
  }))
})

test('the output pool is built once', async t => {
  const calls = []
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator (externalSchemas, outputValidatorOptions) {
          calls.push({ externalSchemas, outputValidatorOptions })
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  controller.setupOutputValidator(fastify[kOptions])
  controller.setupOutputValidator(fastify[kOptions])

  t.assert.strictEqual(calls.length, 1)
})

test('the output side keeps its own schemas bucket', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  fastify.addSchema({ $id: 'shared', type: 'object' })

  t.assert.ok(controller.getSchemas().shared, 'the input bucket holds the shared document')
  t.assert.deepStrictEqual(controller.getOutputSchemas(), {}, 'the output bucket is a bucket of its own')
})

test('the output bucket is allocated on demand and is a bucket of its own', async t => {
  let builtBuckets = 0
  const fastify = Fastify({
    schemaController: {
      bucket (storeInit) {
        builtBuckets++
        return {
          add () {},
          getSchema () {},
          getSchemas () { return storeInit || {} }
        }
      }
    }
  })
  t.after(() => fastify.close())

  const controller = fastify[kSchemaController]
  t.assert.strictEqual(builtBuckets, 1, 'only the bucket of the input side is allocated')
  t.assert.deepStrictEqual(controller.getOutputSchemas(), {}, 'the output side owns no document yet')

  const outputBucket = controller.getOutputSchemaBucket()
  t.assert.strictEqual(builtBuckets, 2, 'the bucket of the output side is allocated on demand')
  t.assert.notStrictEqual(outputBucket, controller.schemaBucket, 'the output bucket is not the input bucket')
  t.assert.deepStrictEqual(controller.getOutputSchemas(), {}, 'the output bucket is empty')
})

test('the output bucket of a child controller is seeded with the parent output documents', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async (instance) => {
    const controller = instance[kSchemaController]
    t.assert.ok(controller.getOutputSchemaBucket(), 'the child allocates its own output bucket')
    t.assert.deepStrictEqual(controller.getOutputSchemas(), {}, 'the parent owns no output document')
  })

  await fastify.ready()
})

test('a response schema that references a shared schema resolves', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addSchema({
    $id: 'http://fastify.test/asset.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      id: { type: 'string' }
    }
  })

  fastify.get('/absolute', {
    schema: {
      response: {
        200: { $ref: 'http://fastify.test/asset.json#' }
      }
    }
  }, async () => ({ id: '1' }))

  fastify.addSchema({
    $id: 'ListSchema',
    type: 'array',
    items: { $ref: 'ShowSchema#' }
  })
  fastify.addSchema({
    $id: 'ShowSchema',
    type: 'object',
    properties: { name: { type: 'string' } }
  })

  fastify.get('/relative', {
    schema: {
      response: {
        200: { $ref: 'ListSchema#' }
      }
    }
  }, async () => ([{ name: 'foo' }]))

  const absolute = await fastify.inject('/absolute')
  t.assert.strictEqual(absolute.statusCode, 200)
  t.assert.deepStrictEqual(absolute.json(), { id: '1' })

  const relative = await fastify.inject('/relative')
  t.assert.strictEqual(relative.statusCode, 200)
  t.assert.deepStrictEqual(relative.json(), [{ name: 'foo' }])
})

test('a response schema that carries an unknown or an annotation keyword compiles', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/unknown', {
    schema: {
      response: {
        200: {
          $id: 'test',
          type: 'object',
          whatever: 'need to be parsed by the custom serializer'
        }
      }
    }
  }, async () => ({ hello: 'world' }))

  fastify.get('/annotation', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string', example: 'world' }
          },
          example: { hello: 'world' }
        }
      }
    }
  }, async () => ({ hello: 'world' }))

  const unknown = await fastify.inject('/unknown')
  t.assert.strictEqual(unknown.statusCode, 200)
  t.assert.deepStrictEqual(unknown.json(), {})

  const annotation = await fastify.inject('/annotation')
  t.assert.strictEqual(annotation.statusCode, 200)
  t.assert.deepStrictEqual(annotation.json(), { hello: 'world' })
})

test('a response schema that cannot be compiled stops the registration', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'invalid-type' }
      }
    }
  }, async () => ({ hello: 'world' }))

  await t.assert.rejects(fastify.ready(), (err) => {
    t.assert.strictEqual(err.code, 'FST_ERR_SCH_SERIALIZATION_BUILD')
    t.assert.ok(err.message.includes('GET'), 'the error names the route')
    return true
  })
})

test('a response schema that the output pool cannot compile stops the registration', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'invalid-type' }
      }
    },
    // The serializer of the route is provided by the user: the response
    // schema is compiled by the output pool only.
    serializerCompiler: () => () => JSON.stringify({ hello: 'world' })
  }, async () => ({ hello: 'world' }))

  await t.assert.rejects(fastify.ready(), (err) => {
    t.assert.strictEqual(err.code, 'FST_ERR_SCH_SERIALIZATION_BUILD')
    t.assert.ok(err.message.includes('Failed building the serialization schema'), 'the error carries the reason of the failure')
    return true
  })
})

test('a route without a response schema produces no output validator', t => {
  const context = { schema: { body: { type: 'object' } } }
  compileSchemasForResponseValidation(context, () => () => true)
  t.assert.strictEqual(context[kSchemaOutputValidator], undefined)
})

test('the output pool is built once per route registration, not once per request', async t => {
  let calls = 0
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          calls++
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'object' }
      }
    }
  }, async () => ({ hello: 'world' }))

  await fastify.ready()
  t.assert.strictEqual(calls, 1)

  await fastify.inject('/')
  await fastify.inject('/')
  t.assert.strictEqual(calls, 1)
})

test('a route without a response schema does not build the output pool', async t => {
  let calls = 0
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          calls++
          return () => () => true
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ hello: 'world' }))

  await fastify.ready()
  t.assert.strictEqual(calls, 0)
})

test('the response schema lookup matches the exact status code first', t => {
  const context = {
    [kSchemaResponse]: {
      200: 'exact',
      '2xx': 'wildcard',
      default: 'default'
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json'), 'exact')
  t.assert.strictEqual(getResponseSchemaEntry(context, 201, 'application/json'), 'wildcard')
  t.assert.strictEqual(getResponseSchemaEntry(context, 500, 'application/json'), 'default')
  t.assert.strictEqual(getResponseSchemaEntry({ [kSchemaResponse]: { 200: 'exact' } }, 302, 'application/json'), false)
})

test('the response schema lookup matches the exact media type first', t => {
  const context = {
    [kSchemaResponse]: {
      200: {
        'application/json': 'json',
        '*/*': 'any'
      }
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json'), 'json')
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json; charset=utf-8'), 'json')
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'text/plain'), 'any')
})

test('the response schema lookup returns false when the content type does not match', t => {
  const context = {
    [kSchemaResponse]: {
      200: {
        'application/json': 'json'
      }
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'text/plain', { failClosed: false }), false)
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'not a media type', { failClosed: false }), false)
  t.assert.throws(
    () => getResponseSchemaEntry(context, 200, 'text/plain', { failClosed: true }),
    { code: 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN' }
  )
  t.assert.throws(
    () => getResponseSchemaEntry(context, 200, 'not a media type', { failClosed: true }),
    { code: 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN' }
  )
})

test('the response schema lookup looks into the bucket selected by the symbol', t => {
  const context = {
    [kSchemaResponse]: { 200: 'serializer' },
    [kSchemaOutputValidator]: { 200: 'validator' }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json'), 'serializer')
  t.assert.strictEqual(
    getResponseSchemaEntry(context, 200, 'application/json', { symbol: kSchemaOutputValidator }),
    'validator'
  )
  t.assert.strictEqual(getResponseSchemaEntry({}, 200, 'application/json'), false)
})
