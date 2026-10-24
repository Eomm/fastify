'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const { kSchemaController, kOptions } = require('../lib/symbols')
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
