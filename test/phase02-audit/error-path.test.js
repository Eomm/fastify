'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

/**
 * The error path of the Phase 2.
 *
 * The error path joins the output pipeline: an error response whose route
 * error schema matches is validated and shaped by the output validator, and
 * everything else keeps the built-in error serializer.
 */

function buildError (statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

test('an error body is shaped by the error schema of the route', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        400: {
          type: 'object',
          properties: {
            statusCode: { type: 'number' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(response.payload, '{"statusCode":400,"message":"the error message"}')
})

test('an error body that does not satisfy its own schema answers FST_ERR_FAILED_ERROR_SERIALIZATION', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        400: {
          type: 'object',
          properties: {
            message: { type: 'number' }
          }
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":500,"code":"FST_ERR_FAILED_ERROR_SERIALIZATION","message":"Failed to serialize an error. Error: the error body does not match the error schema: /message must be number. Original error: the error message"}'
  )
})

test('a route without an error schema answers the built-in error body', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => {
    throw buildError(404, 'FST_ERR_NOT_FOUND', 'Not Found')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 404)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":404,"code":"FST_ERR_NOT_FOUND","error":"Not Found","message":"Not Found"}'
  )
})

test('the lookup is lenient on the status code', async (t) => {
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
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":400,"code":"FST_ERR_TEST","error":"Bad Request","message":"the error message"}'
  )
})

test('the lookup is lenient on the content type', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        400: {
          content: {
            'application/xml': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":400,"code":"FST_ERR_TEST","error":"Bad Request","message":"the error message"}',
    'the built-in body answers, and it is not an error'
  )
})

test('a failed output validation is shaped by the error schema of the route', async (t) => {
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
        },
        500: {
          type: 'object',
          properties: {
            statusCode: { type: 'number' },
            code: { type: 'string' }
          }
        }
      }
    }
  }, async () => ({ hello: 42 }))

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":500,"code":"FST_ERR_OUTPUT_VALIDATION"}'
  )
})

test('an asynchronous error schema is not awaited: the built-in body answers', async (t) => {
  const fastify = Fastify({
    schemaController: {
      outputValidatorOptions: {
        plugins: [
          (ajv) => {
            ajv.addKeyword({
              keyword: 'alwaysValid',
              async: true,
              validate: async () => true
            })
          }
        ]
      }
    }
  })
  t.after(() => fastify.close())

  // The unique shared document makes the key of the output pool unique, so
  // that this server owns an Ajv instance built with the plugin above.
  fastify.addSchema({ $id: 'http://fastify.test/async-error-fixture.json', type: 'object' })

  fastify.get('/', {
    schema: {
      response: {
        400: {
          $async: true,
          type: 'object',
          properties: {
            statusCode: { type: 'number' }
          },
          alwaysValid: true
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":400,"code":"FST_ERR_TEST","error":"Bad Request","message":"the error message"}'
  )
})

test('an error without a code has no code in the body', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => {
    const error = new Error('the error message')
    error.statusCode = 400
    throw error
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":400,"error":"Bad Request","message":"the error message"}'
  )
})

test('an unknown status code has no error in the body', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => {
    throw buildError(599, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 599)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":599,"code":"FST_ERR_TEST","message":"the error message"}'
  )
})

test('a validator that fails without an error array answers FST_ERR_FAILED_ERROR_SERIALIZATION', async (t) => {
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

  fastify.get('/', {
    schema: {
      response: {
        400: {
          type: 'object',
          properties: {
            statusCode: { type: 'number' }
          }
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.ok(response.payload.includes('FST_ERR_FAILED_ERROR_SERIALIZATION'))
  t.assert.ok(response.payload.includes('the payload is not valid'))
})

test('a rejected asynchronous error schema leaves no unhandled rejection', async (t) => {
  const unhandledRejections = []
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  t.after(() => {
    process.removeListener('unhandledRejection', onUnhandledRejection)
  })

  const fastify = Fastify({
    schemaController: {
      outputValidatorOptions: {
        plugins: [
          (ajv) => {
            ajv.addKeyword({
              keyword: 'alwaysFails',
              async: true,
              validate: async () => {
                throw new Error('the asynchronous validator failed')
              }
            })
          }
        ]
      }
    }
  })
  t.after(() => fastify.close())

  fastify.addSchema({ $id: 'http://fastify.test/async-error-failure-fixture.json', type: 'object' })

  fastify.get('/', {
    schema: {
      response: {
        400: {
          $async: true,
          type: 'object',
          properties: {
            statusCode: { type: 'number' }
          },
          alwaysFails: true
        }
      }
    }
  }, async () => {
    throw buildError(400, 'FST_ERR_TEST', 'the error message')
  })

  const response = await fastify.inject('/')
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(
    response.payload,
    '{"statusCode":400,"code":"FST_ERR_TEST","error":"Bad Request","message":"the error message"}'
  )

  // The rejection of the asynchronous validator is swallowed by the error
  // path: it must never reach the process.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  t.assert.deepStrictEqual(unhandledRejections, [], 'the process has seen no unhandled rejection')
})
