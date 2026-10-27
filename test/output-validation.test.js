'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const { kSchemaController, kOptions, kSchemaOutputValidator } = require('../lib/symbols')
const { getResponseSchemaEntry } = require('../lib/schemas')
const { compileSchemasForResponseValidation } = require('../lib/validation')

// The bucket of a second lookup: the helper is schema agnostic, the symbol
// selects the bucket it looks into.
const kOtherSchemaBucket = Symbol('other-response-schema')
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
  // `fast-json-stringify` added the default to the wire: the serializer is
  // gone, so the default never reaches the wire. The divergence from the v5
  // behaviour is intentional and it is documented in the V5 to V6 migration
  // guide.
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
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

test('a property-less object schema answers an empty object (the first parity rule)', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'object' }
      }
    }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  // `fast-json-stringify` emitted `{}` for a property-less object schema: the
  // parity keeps that behaviour.
  t.assert.strictEqual(result.payload, '{}')
})

test('an object schema with additionalProperties true keeps every property (the second parity rule)', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          additionalProperties: true
        }
      }
    }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  // `fast-json-stringify` kept every property of an object schema that
  // declares `additionalProperties: true`: the parity keeps that behaviour.
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
})

test('the properties are emitted in the order of the payload, not in the order of the schema', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            b: { type: 'string' },
            a: { type: 'string' }
          }
        }
      }
    }
  }, async () => ({ a: 'world', b: 'moon' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  // The order of the bytes follows the payload: `fast-json-stringify` used
  // the order of the schema.
  t.assert.strictEqual(result.payload, '{"a":"world","b":"moon"}')
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

test('the output validator is selected for the NXX wildcard entry', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/invalid', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async (req, reply) => {
    reply.code(201).send({ hello: 42 })
  })

  fastify.get('/valid', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async (req, reply) => {
    reply.code(201).send({ hello: 'world' })
  })

  // The `2xx` entry is the one that applies to a `201` response: the payload
  // that violates it is rejected...
  const invalid = await fastify.inject('/invalid')
  t.assert.strictEqual(invalid.statusCode, 500)
  t.assert.strictEqual(JSON.parse(invalid.payload).code, 'FST_ERR_OUTPUT_VALIDATION')

  // ... and the payload that satisfies it is accepted.
  const valid = await fastify.inject('/valid')
  t.assert.strictEqual(valid.statusCode, 201)
  t.assert.strictEqual(valid.payload, '{"hello":"world"}')
})

test('the output validator is selected for the default entry', async (t) => {
  let capturedError = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/invalid', {
    schema: {
      response: {
        default: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async (req, reply) => {
    reply.code(201).send({ hello: 42 })
  })

  fastify.get('/valid', {
    schema: {
      response: {
        default: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        }
      }
    }
  }, async (req, reply) => {
    reply.code(201).send({ hello: 'world' })
  })

  // The `default` entry is the last fallback of the lookup: it applies to a
  // status code that matches no other entry. The error is captured through
  // the `onError` hook, because the error path picks the `default` entry up
  // too: the body of the error is shaped by it.
  const invalid = await fastify.inject('/invalid')
  t.assert.strictEqual(invalid.statusCode, 500)
  t.assert.ok(capturedError, 'the error hook received the error')
  t.assert.strictEqual(capturedError.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(capturedError.validationContext, 'response')

  const valid = await fastify.inject('/valid')
  t.assert.strictEqual(valid.statusCode, 201)
  t.assert.strictEqual(valid.payload, '{"hello":"world"}')
})

test('the exact status code wins over the NXX wildcard entry', async (t) => {
  let capturedError = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/exact', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        },
        '2xx': {
          type: 'object'
        }
      }
    }
  }, async (req, reply) => {
    reply.code(200).send({ hello: 42 })
  })

  fastify.get('/wildcard', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' }
          },
          required: ['hello']
        },
        '2xx': {
          type: 'object'
        }
      }
    }
  }, async (req, reply) => {
    reply.code(201).send({ hello: 42 })
  })

  // The `200` entry wins over the `2xx` one: the payload that violates the
  // strict entry is rejected.
  const exact = await fastify.inject('/exact')
  t.assert.strictEqual(exact.statusCode, 500)
  t.assert.ok(capturedError, 'the error hook received the error')
  t.assert.strictEqual(capturedError.code, 'FST_ERR_OUTPUT_VALIDATION')

  // The `2xx` entry applies to the `201` response: the same payload is
  // accepted, because the `2xx` entry does not constrain it. The property-less
  // object schema drops every property, exactly like `fast-json-stringify`
  // did.
  const wildcard = await fastify.inject('/wildcard')
  t.assert.strictEqual(wildcard.statusCode, 201)
  t.assert.strictEqual(wildcard.payload, '{}')
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
  // The null payload is not validated: it is the carve-out of the output
  // side. The body is the one of the native `JSON.stringify`, which emits
  // `null` where `fast-json-stringify` emitted `{}`.
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, 'null')
  t.assert.strictEqual(validated, 0, 'the validator has never been invoked')
})

test('an async response schema is awaited and its rejection fails the response', async (t) => {
  let capturedError = null
  const fastify = Fastify({
    schemaController: {
      outputValidatorOptions: {
        plugins: [
          (ajv) => {
            ajv.addKeyword({
              keyword: 'isEven',
              async: true,
              validate: async (schema, data) => {
                await new Promise(resolve => setImmediate(resolve))
                return data % 2 === 0
              }
            })
          }
        ]
      }
    }
  })
  t.after(() => fastify.close())

  // The unique shared document makes the key of the output pool unique, so
  // that this server owns an Ajv instance built with the plugin above.
  fastify.addSchema({ $id: 'http://fastify.test/async-output-fixture.json', type: 'object' })

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  const schema = {
    $async: true,
    type: 'object',
    properties: {
      count: { type: 'number', isEven: true }
    }
  }

  fastify.get('/valid', { schema: { response: { 200: schema } } }, async () => ({ count: 4 }))
  fastify.get('/invalid', { schema: { response: { 200: schema } } }, async () => ({ count: 3 }))

  const valid = await fastify.inject('/valid')
  t.assert.strictEqual(valid.statusCode, 200)
  t.assert.strictEqual(valid.payload, '{"count":4}')

  // The keyword is really registered: the payload that violates it is
  // rejected, the case cannot pass vacuously.
  const invalid = await fastify.inject('/invalid')
  t.assert.strictEqual(invalid.statusCode, 500)
  const body = JSON.parse(invalid.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(body.statusCode, 500)
  t.assert.ok(capturedError, 'the error hook received the error')
  t.assert.ok(Array.isArray(capturedError.validation), 'the error carries the Ajv errors')
  t.assert.strictEqual(capturedError.validation.length, 1)
  t.assert.strictEqual(capturedError.validation[0].instancePath, '/count')
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

test('an async response schema accepts the payload whose validated value is false', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const schema = {
    $async: true,
    type: 'boolean'
  }

  fastify.get('/false', { schema: { response: { 200: schema } } }, async () => false)
  fastify.get('/true', { schema: { response: { 200: schema } } }, async () => true)

  // An Ajv `$async` validator resolves with the validated data: the resolved
  // value is not a verdict. The boolean `false` is a valid payload.
  const falsy = await fastify.inject('/false')
  t.assert.strictEqual(falsy.statusCode, 200)
  t.assert.strictEqual(falsy.payload, 'false')

  const truthy = await fastify.inject('/true')
  t.assert.strictEqual(truthy.statusCode, 200)
  t.assert.strictEqual(truthy.payload, 'true')
})

test('an async response schema that the payload violates fails the response with the Ajv errors', async (t) => {
  let capturedError = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  const schema = {
    $async: true,
    type: 'boolean'
  }

  fastify.get('/', { schema: { response: { 200: schema } } }, async () => 42)

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.ok(capturedError, 'the error hook received the error')
  t.assert.strictEqual(capturedError.validation.length, 1)
  t.assert.strictEqual(capturedError.validation[0].keyword, 'type')
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

test('the output validation awaits a validator that returns a promise', async (t) => {
  let resolved = false
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => async () => {
            await new Promise(resolve => setTimeout(resolve, 20))
            resolved = true
            return true
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: { response: { 200: { type: 'object', properties: { hello: { type: 'string' } } } } }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 200)
  t.assert.strictEqual(result.payload, '{"hello":"world"}')
  t.assert.ok(resolved, 'the response has been sent after the promise settled')
})

test('a rejected output validator that carries an Ajv error array fails the response', async (t) => {
  let capturedError = null
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => async () => {
            const error = new Error('validation failed')
            error.errors = [{ instancePath: '/hello', message: 'must be string' }]
            throw error
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/', {
    schema: { response: { 200: { type: 'object' } } }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.strictEqual(body.message, 'Response validation failed. Errors: /hello must be string')
  t.assert.deepStrictEqual(capturedError.validation, [{ instancePath: '/hello', message: 'must be string' }])
  t.assert.strictEqual(capturedError.validationContext, 'response')
})

test('an output validator that throws an unrelated error is not relabelled', async (t) => {
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            const error = new Error('the validator is broken')
            error.statusCode = 503
            throw error
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: { response: { 200: { type: 'object' } } }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 503)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.message, 'the validator is broken')
  t.assert.strictEqual(body.code, undefined, 'the error has not been relabelled')
})

test('an output validator that returns false without an error array fails the response', async (t) => {
  let capturedError = null
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => false
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/', {
    schema: { response: { 200: { type: 'object', properties: { hello: { type: 'string' } } } } }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.deepStrictEqual(capturedError.validation, [])
  t.assert.strictEqual(capturedError.validationContext, 'response')
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

  // The output pool compiles the response schemas itself: a schema that it
  // cannot compile stops the registration.
  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'invalid-type' }
      }
    }
  }, async () => ({ hello: 'world' }))

  await t.assert.rejects(fastify.ready(), (err) => {
    t.assert.strictEqual(err.code, 'FST_ERR_SCH_SERIALIZATION_BUILD')
    t.assert.ok(err.message.includes('Failed building the serialization schema'), 'the error carries the reason of the failure')
    return true
  })
})

test('the route level serializerCompiler option is rejected at registration', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  // The serializer of the route is gone with `fast-json-stringify`: the
  // option is rejected at registration, the response schema is never
  // compiled by a user provided serializer.
  t.assert.throws(
    () => fastify.get('/', {
      schema: {
        response: {
          200: { type: 'invalid-type' }
        }
      },
      serializerCompiler: () => () => JSON.stringify({ hello: 'world' })
    }, async () => ({ hello: 'world' })),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )

  t.assert.throws(
    () => fastify.get('/', {
      schema: {
        response: {
          200: { type: 'invalid-type' }
        }
      },
      serializerCompiler: () => () => JSON.stringify({ hello: 'world' })
    }, async () => ({ hello: 'world' })),
    { message: /serializerCompiler/ }
  )
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
    [kOtherSchemaBucket]: {
      200: 'exact',
      '2xx': 'wildcard',
      default: 'default'
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json', { symbol: kOtherSchemaBucket }), 'exact')
  t.assert.strictEqual(getResponseSchemaEntry(context, 201, 'application/json', { symbol: kOtherSchemaBucket }), 'wildcard')
  t.assert.strictEqual(getResponseSchemaEntry(context, 500, 'application/json', { symbol: kOtherSchemaBucket }), 'default')
  t.assert.strictEqual(getResponseSchemaEntry({ [kOtherSchemaBucket]: { 200: 'exact' } }, 302, 'application/json', { symbol: kOtherSchemaBucket }), false)
})

test('the response schema lookup matches the exact media type first', t => {
  const context = {
    [kOtherSchemaBucket]: {
      200: {
        'application/json': 'json',
        '*/*': 'any'
      }
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json', { symbol: kOtherSchemaBucket }), 'json')
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json; charset=utf-8', { symbol: kOtherSchemaBucket }), 'json')
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'text/plain', { symbol: kOtherSchemaBucket }), 'any')
})

test('the response schema lookup returns false when the content type does not match', t => {
  const context = {
    [kOtherSchemaBucket]: {
      200: {
        'application/json': 'json'
      }
    }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'text/plain', { failClosed: false, symbol: kOtherSchemaBucket }), false)
  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'not a media type', { failClosed: false, symbol: kOtherSchemaBucket }), false)
  t.assert.throws(
    () => getResponseSchemaEntry(context, 200, 'text/plain', { failClosed: true, symbol: kOtherSchemaBucket }),
    { code: 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN' }
  )
  t.assert.throws(
    () => getResponseSchemaEntry(context, 200, 'not a media type', { failClosed: true, symbol: kOtherSchemaBucket }),
    { code: 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN' }
  )
})

test('the response schema lookup looks into the bucket selected by the symbol', t => {
  const context = {
    [kOtherSchemaBucket]: { 200: 'other' },
    [kSchemaOutputValidator]: { 200: 'validator' }
  }

  t.assert.strictEqual(getResponseSchemaEntry(context, 200, 'application/json'), 'validator')
  t.assert.strictEqual(
    getResponseSchemaEntry(context, 200, 'application/json', { symbol: kOtherSchemaBucket }),
    'other'
  )
  t.assert.strictEqual(getResponseSchemaEntry({}, 200, 'application/json'), false)
})

test('the user customOptions reach the output pool and win over the framework defaults', async (t) => {
  const responseSchema = {
    200: {
      type: 'object',
      properties: {
        hello: { type: 'string' },
        world: { type: 'number' }
      }
    }
  }

  // The route declares two independent violations: the payload has a string
  // where a number is expected and a number where a string is expected.
  const run = async (outputValidatorOptions) => {
    const errors = []
    const fastify = Fastify({
      schemaController: { outputValidatorOptions }
    })

    fastify.addHook('onError', (request, reply, error, done) => {
      errors.push(error)
      done()
    })

    fastify.get('/', {
      schema: { response: responseSchema }
    }, async () => ({ hello: 42, world: 'not a number' }))

    const fastifyServer = await fastify.listen({ port: 0 })
    const result = await fetch(fastifyServer + '/')
    const body = await result.text()
    await fastify.close()

    return { status: result.status, body, errors }
  }

  const withDefaults = await run(undefined)
  t.assert.strictEqual(withDefaults.status, 500)
  t.assert.strictEqual(withDefaults.errors.length, 1)
  t.assert.strictEqual(
    withDefaults.errors[0].validation.length,
    1,
    'the framework default reports the first violation only'
  )
  t.assert.strictEqual(withDefaults.errors[0].validationContext, 'response')

  const withUserOptions = await run({ customOptions: { allErrors: true } })
  t.assert.strictEqual(withUserOptions.status, 500)
  t.assert.strictEqual(withUserOptions.errors.length, 1)
  t.assert.strictEqual(
    withUserOptions.errors[0].validation.length,
    2,
    'the user option reports every violation'
  )
  t.assert.deepStrictEqual(
    withUserOptions.errors[0].validation.map((error) => error.instancePath).sort(),
    ['/hello', '/world']
  )
  t.assert.strictEqual(withUserOptions.errors[0].validationContext, 'response')
  t.assert.deepStrictEqual(JSON.parse(withUserOptions.body), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: /hello must be string; /world must be number'
  })
})

test('a user supplied buildOutputValidator replaces the default output factory', async (t) => {
  const factoryCalls = []
  const compilerCalls = []
  let validatorCalls = 0

  const fastify = Fastify({
    exposeHeadRoutes: false,
    schemaController: {
      outputValidatorOptions: { customOptions: { allErrors: true } },
      compilersFactory: {
        buildOutputValidator (externalSchemas, outputValidatorOptions) {
          factoryCalls.push({ externalSchemas, outputValidatorOptions })
          return function compileOutputValidator ({ schema, method, url, httpStatus, contentType }) {
            compilerCalls.push({ schema, method, url, httpStatus, contentType })
            return function validateOutput (data) {
              validatorCalls++
              if (data && data.hello === 'invalid') {
                validateOutput.errors = [{
                  instancePath: '/hello',
                  schemaPath: '#/properties/hello/type',
                  params: { type: 'string' },
                  message: 'must be string'
                }]
                return false
              }
              return true
            }
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  const responseSchema = {
    200: {
      type: 'object',
      properties: { hello: { type: 'string' } }
    }
  }

  fastify.get('/valid', { schema: { response: responseSchema } }, async () => ({ hello: 'world' }))

  // The payload violates the response schema, but the validator of the user
  // accepts it: the default output factory is not installed next to the
  // factory of the user.
  fastify.get('/wrong-type', { schema: { response: responseSchema } }, async () => ({ hello: 42 }))

  fastify.get('/invalid', { schema: { response: responseSchema } }, async () => ({ hello: 'invalid' }))

  fastify.get('/content', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': { schema: { type: 'object', properties: { hello: { type: 'string' } } } }
          }
        }
      }
    }
  }, async () => ({ hello: 'world' }))

  await fastify.ready()

  t.assert.strictEqual(factoryCalls.length, 1, 'the factory is called once, when the pool is built')
  t.assert.deepStrictEqual(
    factoryCalls[0].outputValidatorOptions,
    { customOptions: { allErrors: true } },
    'the factory receives the user options'
  )

  t.assert.strictEqual(compilerCalls.length, 4, 'the compiler is called once per status code and media type')
  t.assert.deepStrictEqual(
    compilerCalls.map((call) => [call.url, call.method, call.httpStatus, call.contentType]),
    [
      ['/valid', 'GET', '200', undefined],
      ['/wrong-type', 'GET', '200', undefined],
      ['/invalid', 'GET', '200', undefined],
      ['/content', 'GET', '200', 'application/json']
    ]
  )

  const fastifyServer = await fastify.listen({ port: 0 })

  const valid = await fetch(fastifyServer + '/valid')
  t.assert.strictEqual(valid.status, 200)
  t.assert.deepStrictEqual(JSON.parse(await valid.text()), { hello: 'world' })

  const wrongType = await fetch(fastifyServer + '/wrong-type')
  t.assert.strictEqual(wrongType.status, 200, 'the validator of the user accepts the payload')
  // The bytes on the wire are produced by the native `JSON.stringify`: the
  // payload is not shaped any more, the validator of the user only decides
  // whether the payload is accepted. The value is not coerced.
  t.assert.deepStrictEqual(JSON.parse(await wrongType.text()), { hello: 42 })

  const content = await fetch(fastifyServer + '/content')
  t.assert.strictEqual(content.status, 200)

  const invalid = await fetch(fastifyServer + '/invalid')
  t.assert.strictEqual(invalid.status, 500)
  const invalidBody = await invalid.text()
  t.assert.deepStrictEqual(JSON.parse(invalidBody), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: /hello must be string'
  })

  t.assert.strictEqual(compilerCalls.length, 4, 'the compiler is not called again at request time')
  t.assert.strictEqual(validatorCalls, 4, 'the validator runs on every response')
})

test('the user factory resolves the shared schema documents in its own pool', async (t) => {
  const Ajv = require('ajv').default
  let factoryCalls = 0
  const factoryDocuments = []
  const factoryOptions = []

  const fastify = Fastify({
    exposeHeadRoutes: false,
    schemaController: {
      outputValidatorOptions: { customOptions: { allErrors: true } },
      compilersFactory: {
        buildOutputValidator (externalSchemas, outputValidatorOptions) {
          factoryCalls++
          factoryDocuments.push(externalSchemas)
          factoryOptions.push(outputValidatorOptions)
          const ajv = new Ajv({ allErrors: true })
          for (const externalSchema of Object.values(externalSchemas)) {
            ajv.addSchema(externalSchema)
          }
          return function compileOutputValidator ({ schema }) {
            return ajv.compile(schema)
          }
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addSchema({
    $id: 'http://fastify.test/asset.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      id: { type: 'string' }
    },
    required: ['id']
  })

  fastify.get('/asset', {
    schema: {
      response: {
        200: { $ref: 'http://fastify.test/asset.json#' }
      }
    }
  }, async () => ({ id: 42 }))

  await fastify.ready()
  t.assert.strictEqual(factoryCalls, 1)
  t.assert.ok(
    factoryDocuments[0]['http://fastify.test/asset.json'],
    'the factory receives the shared schema documents'
  )
  t.assert.deepStrictEqual(
    factoryOptions[0],
    { customOptions: { allErrors: true } },
    'the factory receives the user options'
  )

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/asset')
  t.assert.strictEqual(result.status, 500)
  t.assert.deepStrictEqual(JSON.parse(await result.text()), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: /id must be string'
  })
})

test('an output validator that resolves false fails the response', async (t) => {
  let capturedError = null
  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => async () => false
        }
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/', {
    schema: { response: { 200: { type: 'object', properties: { hello: { type: 'string' } } } } }
  }, async () => ({ hello: 'world' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  const body = JSON.parse(result.payload)
  t.assert.strictEqual(body.code, 'FST_ERR_OUTPUT_VALIDATION')
  t.assert.deepStrictEqual(capturedError.validation, [])
  t.assert.strictEqual(capturedError.validationContext, 'response')
  t.assert.strictEqual(
    body.message,
    'Response validation failed.',
    'the message does not end with an empty list of errors'
  )
})

test('the output validator options given to setSchemaController reach the output pool', async (t) => {
  const errors = []
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.setSchemaController({
    outputValidatorOptions: { customOptions: { allErrors: true } }
  })

  fastify.addHook('onError', (request, reply, error, done) => {
    errors.push(error)
    done()
  })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hello: { type: 'string' },
            world: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ hello: 42, world: 'not a number' }))

  const result = await fastify.inject('/')
  t.assert.strictEqual(result.statusCode, 500)
  t.assert.strictEqual(errors.length, 1)
  t.assert.strictEqual(
    errors[0].validation.length,
    2,
    'the option given to setSchemaController reports every violation'
  )
  t.assert.strictEqual(errors[0].validationContext, 'response')
})
