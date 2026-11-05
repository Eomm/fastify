'use strict'

const { test } = require('node:test')
const Fastify = require('../../fastify')
const Reply = require('../../lib/reply')

// The reply serialization helpers are gone with `fast-json-stringify`: they
// are not deprecated aliases, they do not exist any more. The file asserts
// their absence and the new behaviour of the surviving `reply.serialize()`.
const REMOVED_HELPERS = [
  'getSerializationFunction',
  'compileSerializationSchema',
  'serializeInput'
]

test('the reply serialization helpers do not exist any more', async t => {
  t.plan(REMOVED_HELPERS.length + 1)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (request, reply) => {
    for (const helper of REMOVED_HELPERS) {
      t.assert.strictEqual(
        typeof reply[helper],
        'undefined',
        `reply.${helper}() is not a function any more`
      )
    }
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.statusCode, 200)
})

test('the reply serialization helpers do not exist on the prototype', t => {
  t.plan(REMOVED_HELPERS.length)

  for (const helper of REMOVED_HELPERS) {
    t.assert.strictEqual(
      typeof Reply.prototype[helper],
      'undefined',
      `Reply.prototype.${helper}() is not a function any more`
    )
  }
})

test('Reply#serialize is the alias of JSON.stringify', async t => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (request, reply) => {
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), JSON.stringify({ hello: 'world' }))
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.payload, '{"hello":"world"}')
})

test('Reply#serialize keeps the native JSON.stringify semantics', async t => {
  t.plan(7)

  const fastify = Fastify()
  t.after(() => fastify.close())

  const date = new Date('2026-10-26T00:00:00.000Z')

  fastify.get('/', async (request, reply) => {
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), '{"hello":"world"}')
    t.assert.strictEqual(reply.serialize([1, 2, 3]), '[1,2,3]')
    t.assert.strictEqual(reply.serialize(null), 'null')
    t.assert.strictEqual(reply.serialize(date), JSON.stringify(date))
    t.assert.strictEqual(reply.serialize({ hello: undefined, world: 'world' }), '{"world":"world"}')
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), JSON.stringify({ hello: 'world' }))
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.statusCode, 200)
})

test('Reply#serialize is the JSON alias even with a custom reply serializer', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (request, reply) => {
    reply.serializer(payload => JSON.stringify({ serialized: payload }))
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), '{"hello":"world"}')
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.payload, '{"serialized":{"hello":"world"}}')
})

test('Reply#serialize ignores the response schema of the route', async t => {
  t.plan(2)

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
  }, async (request, reply) => {
    t.assert.strictEqual(reply.serialize({ hello: 'world', extra: true }), '{"hello":"world","extra":true}')
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.payload, '{"hello":"world"}')
})

test('Reply#serialize ignores the route level reply serializer', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.setReplySerializer((payload) => JSON.stringify({ serialized: payload }))

  fastify.get('/', async (request, reply) => {
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), '{"hello":"world"}')
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.payload, '{"serialized":{"hello":"world"}}')
})

test('the route level serializerCompiler is rejected at registration', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  try {
    fastify.get('/', { serializerCompiler: () => () => JSON.stringify({}) }, () => {})
    t.assert.fail('the route level serializerCompiler option is accepted')
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('serializerCompiler'))
  }
})

test('setSerializerCompiler is rejected', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  try {
    fastify.setSerializerCompiler(() => () => JSON.stringify({}))
    t.assert.fail('the serializer compiler is accepted')
  } catch (error) {
    t.assert.strictEqual(error.code, 'FST_ERR_SERIALIZER_COMPILER_REMOVED')
    t.assert.ok(error.message.includes('migration guide'))
  }
})
