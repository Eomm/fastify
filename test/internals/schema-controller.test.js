'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

test('the renamed key builds the input pool: the custom factory is honoured end to end', async t => {
  t.plan(7)

  const compiledSchemas = []
  let factoryCalls = 0

  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildInputValidator: function (externalSchemas, options) {
          factoryCalls++
          t.assert.deepStrictEqual(externalSchemas, {}, 'the factory receives the external schemas of the pool')
          t.assert.ok(options !== undefined, 'the factory receives the input validator options')

          return function validatorCompiler ({ schema }) {
            compiledSchemas.push(schema)
            return function customValidator () {
              // The custom validator always rejects the payload: the route
              // answers with the verdict of the custom factory, not with the
              // verdict of the default Ajv pool.
              return { error: new Error('rejected by the custom validator') }
            }
          }
        }
      }
    }
  })

  fastify.get('/custom', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    }
  }, (request, reply) => {
    reply.send({ hello: 'world' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/custom?id=42'
  })

  t.assert.strictEqual(factoryCalls, 1, 'the custom factory built the input pool')
  t.assert.ok(compiledSchemas.length >= 1, 'the custom factory compiled the schema of the route')
  t.assert.deepStrictEqual(compiledSchemas[0], {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id']
  })
  // The payload matches the schema: the default pool would have accepted it.
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(response.json().message, 'rejected by the custom validator')
})

test('the old key is a hard error at startup', t => {
  t.plan(3)

  t.assert.throws(
    () => Fastify({ schemaController: { compilersFactory: { buildValidator: () => () => {} } } }),
    (error) => {
      t.assert.strictEqual(error.code, 'FST_ERR_BUILD_VALIDATOR_RENAMED')
      t.assert.ok(error.message.includes('buildInputValidator'), 'the error names the replacement key')
      return true
    }
  )
})

test('the legacy setter still installs the input compiler', async t => {
  t.plan(2)

  const fastify = Fastify()

  let compiled = 0

  // The legacy API installs the compiler through the internal alias of the
  // factory: the alias uses the renamed key.
  fastify.setValidatorCompiler(function validatorCompiler ({ schema }) {
    compiled++
    return function customValidator () {
      return { error: new Error('rejected by the legacy compiler') }
    }
  })

  fastify.get('/legacy', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    }
  }, (request, reply) => {
    reply.send({ hello: 'world' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/legacy?id=42'
  })

  t.assert.ok(compiled >= 1, 'the compiler installed by the legacy setter compiled the schema')
  t.assert.strictEqual(response.statusCode, 400)
})
