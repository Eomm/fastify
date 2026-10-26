'use strict'

const { test } = require('node:test')
const Fastify = require('../../fastify')
const Reply = require('../../lib/reply')

// The reply serialization helpers are gone with `fast-json-stringify`: they
// fail explicitly until plan `02-02` removes them for good. The file is
// replaced by plan `02-02`, which asserts that the helpers do not exist any
// more on the reply prototype.
const REMOVED_HELPERS = [
  'getSerializationFunction',
  'compileSerializationSchema',
  'serializeInput'
]

test('the reply serialization helpers fail explicitly', async t => {
  t.plan(REMOVED_HELPERS.length + 1)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (request, reply) => {
    for (const helper of REMOVED_HELPERS) {
      t.assert.throws(
        () => reply[helper]({}),
        { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' },
        `reply.${helper}() fails explicitly`
      )
    }
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.statusCode, 200)
})

test('the reply serialization helpers fail explicitly on the prototype', async t => {
  t.plan(REMOVED_HELPERS.length)

  for (const helper of REMOVED_HELPERS) {
    t.assert.throws(
      () => Reply.prototype[helper]({}),
      { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' },
      `Reply.prototype.${helper}() fails explicitly`
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

test('Reply#serialize honours a custom reply serializer', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (request, reply) => {
    reply.serializer(payload => JSON.stringify({ serialized: payload }))
    t.assert.strictEqual(reply.serialize({ hello: 'world' }), '{"serialized":{"hello":"world"}}')
    return { hello: 'world' }
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.payload, '{"serialized":{"hello":"world"}}')
})
