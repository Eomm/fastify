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
      error: 'Internal Server Error',
      message: 'The value "world" cannot be converted to a number.'
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
