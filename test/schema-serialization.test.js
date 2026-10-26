'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const ContentType = require('../lib/content-type')
const { waitForCb } = require('./helper')

const echoBody = (req, reply) => { reply.send(req.body) }

test('basic test', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            name: { type: 'string' },
            work: { type: 'string' }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.code(200).send({ name: 'Foo', work: 'Bar', nick: 'Boo' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { name: 'Foo', work: 'Bar' })
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('the serializerOpts server option is rejected at boot', (t, testDone) => {
  t.plan(4)

  // The `serializerOpts` server option is gone with `fast-json-stringify`: it
  // is rejected at boot, it is never ignored with a warning.
  t.assert.throws(
    () => Fastify({
      serializerOpts: {
        rounding: 'ceil'
      }
    }),
    { code: 'FST_ERR_SERIALIZER_OPTS_REMOVED' }
  )

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        '2xx': {
          type: 'integer'
        }
      }
    }
  }, function (req, reply) {
    reply.send(4.2)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(JSON.parse(res.payload).code, 'FST_ERR_OUTPUT_VALIDATION')
    testDone()
  })
})

test('reuse parsed content type when selecting response serializer', async t => {
  const fastify = Fastify()
  const contentType = 'application/x-fastify-cache-test+json; version=1'

  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/x-fastify-cache-test+json': {
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
  }, function (request, reply) {
    reply.type(contentType).send({ hello: 'world', ignored: true })
  })

  const response = await fastify.inject('/')
  const normalizedContentType = response.headers['content-type']

  t.assert.deepStrictEqual(response.json(), { hello: 'world' })
  t.assert.ok(ContentType.cache.get(normalizedContentType))
})

test('Different content types', (t, testDone) => {
  t.plan(42)

  const fastify = Fastify()
  fastify.addSchema({
    $id: 'test',
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      verified: { type: 'boolean' }
    }
  })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  image: { type: 'string' },
                  address: { type: 'string' }
                }
              }
            },
            'application/vnd.v1+json': {
              schema: {
                type: 'array',
                items: { $ref: 'test' }
              }
            }
          }
        },
        201: {
          content: {
            '*/*': {
              schema: { type: 'string' }
            }
          }
        },
        202: {
          content: {
            '*/*': {
              schema: { const: 'Processing exclusive content' }
            }
          }
        },
        '3xx': {
          content: {
            'application/vnd.v2+json': {
              schema: {
                type: 'object',
                properties: {
                  fullName: { type: 'string' },
                  phone: { type: 'string' }
                }
              }
            }
          }
        },
        '4xx': {
          content: {
            '*/*': {
              schema: {
                type: 'object',
                properties: {
                  details: { type: 'string' }
                }
              }
            }
          }
        },
        default: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  details: { type: 'string' }
                }
              }
            },
            '*/*': {
              schema: {
                type: 'object',
                properties: {
                  desc: { type: 'string' },
                  details: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, function (req, reply) {
    switch (req.headers.accept) {
      case 'application/json':
        reply.header('Content-Type', 'application/json')
        reply.send({ id: 1, name: 'Foo', image: 'profile picture', address: 'New Node' })
        break
      case 'application/vnd.v1+json':
        reply.header('Content-Type', 'application/vnd.v1+json')
        reply.send([{ id: 2, name: 'Boo', age: 18, verified: false }, { id: 3, name: 'Woo', age: 30, verified: true }])
        break
      case 'application/vnd.v2+json':
        reply.header('Content-Type', 'application/vnd.v2+json')
        reply.code(300)
        reply.send({ fullName: 'Jhon Smith', phone: '01090000000', authMethod: 'google' })
        break
      case 'application/vnd.v3+json':
        reply.header('Content-Type', 'application/vnd.v3+json')
        reply.code(300)
        reply.send({ firstName: 'New', lastName: 'Hoo', country: 'eg', city: 'node' })
        break
      case 'application/vnd.v4+json':
        reply.header('Content-Type', 'application/vnd.v4+json')
        reply.code(201)
        reply.send({ boxId: 1, content: 'Games' })
        break
      case 'application/vnd.v5+json':
        reply.header('Content-Type', 'application/vnd.v5+json')
        reply.code(202)
        reply.send({ content: 'interesting content' })
        break
      case 'application/vnd.v6+json':
        reply.header('Content-Type', 'application/vnd.v6+json')
        reply.code(400)
        reply.send({ desc: 'age is missing', details: 'validation error' })
        break
      case 'application/vnd.v7+json':
        reply.code(400)
        reply.send({ details: 'validation error' })
        break
      case 'application/vnd.v8+json':
        reply.header('Content-Type', 'application/vnd.v8+json')
        reply.code(500)
        reply.send({ desc: 'age is missing', details: 'validation error' })
        break
      case 'application/vnd.v9+json':
        reply.code(500)
        reply.send({ details: 'validation error' })
        break
      default:
        // to test if schema not found
        reply.header('Content-Type', 'application/vnd.v3+json')
        reply.code(200)
        reply.send([{ type: 'student', grade: 6 }, { type: 'student', grade: 9 }])
    }
  })

  fastify.get('/test', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  image: { type: 'string' },
                  address: { type: 'string' }
                }
              }
            }
          }
        },
        default: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  details: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, function (req, reply) {
    switch (req.headers['code']) {
      case '200': {
        reply.header('Content-Type', 'application/json')
        reply.code(200).send({ name: 'Foo' })
        break
      }
      case '201': {
        reply.header('Content-Type', 'application/json')
        reply.code(201).send({ details: 'validation error' })
        break
      }
      default: {
        reply.header('Content-Type', 'application/vnd.v1+json')
        reply.code(201).send({ created: true })
        break
      }
    }
  })

  const completion = waitForCb({ steps: 14 })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ name: 'Foo', image: 'profile picture', address: 'New Node' }))
    t.assert.strictEqual(res.statusCode, 200)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v1+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify([{ name: 'Boo', age: 18, verified: false }, { name: 'Woo', age: 30, verified: true }]))
    t.assert.strictEqual(res.statusCode, 200)
    completion.stepIn()
  })
  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    // The content type of the answer is not declared in the `content` map of
    // the `200` entry and it is not covered by `*/*`: the lookup fails closed
    // and the request fails with a 500. The body is shaped by the `default`
    // entry of the response schema, which declares no property of the error.
    t.assert.strictEqual(res.payload, '{}')
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v2+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ fullName: 'Jhon Smith', phone: '01090000000' }))
    t.assert.strictEqual(res.statusCode, 300)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v3+json' } }, (err, res) => {
    t.assert.ifError(err)
    // The content type of the answer is not declared in the `content` map of
    // the `3xx` entry: the lookup fails closed and the request fails with a
    // 500.
    t.assert.strictEqual(res.payload, '{}')
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v4+json' } }, (err, res) => {
    t.assert.ifError(err)
    // The payload does not satisfy the response schema of the `201` entry
    // (a string): the output validation fails and the request fails with a
    // 500.
    t.assert.strictEqual(res.payload, '{}')
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v5+json' } }, (err, res) => {
    t.assert.ifError(err)
    // The payload does not satisfy the response schema of the `202` entry
    // (a constant): the output validation fails and the request fails with a
    // 500.
    t.assert.strictEqual(res.payload, '{}')
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v6+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ details: 'validation error' }))
    t.assert.strictEqual(res.statusCode, 400)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v7+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ details: 'validation error' }))
    t.assert.strictEqual(res.statusCode, 400)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v8+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ desc: 'age is missing', details: 'validation error' }))
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/', headers: { Accept: 'application/vnd.v9+json' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ details: 'validation error' }))
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/test', headers: { Code: '200' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ name: 'Foo' }))
    t.assert.strictEqual(res.statusCode, 200)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/test', headers: { Code: '201' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, JSON.stringify({ details: 'validation error' }))
    t.assert.strictEqual(res.statusCode, 201)
    completion.stepIn()
  })
  fastify.inject({ method: 'GET', url: '/test', headers: { Accept: 'application/vnd.v1+json' } }, (err, res) => {
    t.assert.ifError(err)
    // The content type of the answer is not declared in the `content` map of
    // the `default` entry: the lookup fails closed and the request fails with
    // a 500. The body is shaped by the response schema of the error, which
    // declares no property of the error.
    t.assert.strictEqual(res.payload, '{}')
    t.assert.strictEqual(res.statusCode, 500)
    completion.stepIn()
  })

  completion.patience.then(testDone)
})

test('Invalid multiple content schema, throw FST_ERR_SCH_CONTENT_MISSING_SCHEMA error', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.get('/testInvalid', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  fullName: { type: 'string' },
                  phone: { type: 'string' }
                }
              },
              example: {
                fullName: 'John Doe',
                phone: '201090243795'
              }
            },
            type: 'string'
          }
        }
      }
    }
  }, function (req, reply) {
    reply.header('Content-Type', 'application/json')
    reply.send({ fullName: 'Any name', phone: '0109001010' })
  })

  fastify.ready((err) => {
    t.assert.strictEqual(err.message, "Schema is missing for the content type 'type'")
    t.assert.strictEqual(err.statusCode, 500)
    t.assert.strictEqual(err.code, 'FST_ERR_SCH_CONTENT_MISSING_SCHEMA')
    testDone()
  })
})

test('Use the same schema id in different places', (t, testDone) => {
  t.plan(2)
  const fastify = Fastify()

  fastify.addSchema({
    $id: 'test',
    type: 'object',
    properties: {
      id: { type: 'number' }
    }
  })

  fastify.get('/:id', {
    handler (req, reply) {
      reply.send([{ id: 1 }, { id: 2 }, { what: 'is this' }])
    },
    schema: {
      response: {
        200: {
          type: 'array',
          items: { $ref: 'test' }
        }
      }
    }
  })

  fastify.inject({
    method: 'GET',
    url: '/123'
  }, (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), [{ id: 1 }, { id: 2 }, {}])
    testDone()
  })
})

test('Use shared schema and $ref with $id in response ($ref to $id)', (t, testDone) => {
  t.plan(5)
  const fastify = Fastify()

  fastify.addSchema({
    $id: 'http://foo/test',
    type: 'object',
    properties: {
      id: { type: 'number' }
    }
  })

  const complexSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'http://foo/user',
    type: 'object',
    definitions: {
      address: {
        $id: '#address',
        type: 'object',
        properties: {
          city: { type: 'string' }
        }
      }
    },
    properties: {
      test: { $ref: 'http://foo/test#' },
      address: { $ref: '#address' }
    },
    required: ['address', 'test']
  }

  fastify.post('/', {
    schema: {
      body: complexSchema,
      response: {
        200: complexSchema
      }
    },
    handler: (req, reply) => {
      req.body.removeThis = 'it should not be serialized'
      reply.send(req.body)
    }
  })

  const payload = {
    address: { city: 'New Node' },
    test: { id: Date.now() }
  }

  const completion = waitForCb({ steps: 2 })
  fastify.inject({
    method: 'POST',
    url: '/',
    payload
  }, (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), payload)
    completion.stepIn()
  })
  fastify.inject({
    method: 'POST',
    url: '/',
    payload: { test: { id: Date.now() } }
  }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 400)
    t.assert.deepStrictEqual(res.json(), {
      error: 'Bad Request',
      message: "body must have required property 'address'",
      statusCode: 400,
      code: 'FST_ERR_VALIDATION'
    })
    completion.stepIn()
  })

  completion.patience.then(testDone)
})

test('Shared schema should be pass to serializer and validator ($ref to shared schema /definitions)', (t, testDone) => {
  t.plan(5)
  const fastify = Fastify()

  fastify.addSchema({
    $id: 'http://fastify.test/asset.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Physical Asset',
    description: 'A generic representation of a physical asset',
    type: 'object',
    required: [
      'id',
      'model',
      'location'
    ],
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      model: {
        type: 'string'
      },
      location: { $ref: 'http://fastify.test/point.json#' }
    },
    definitions: {
      inner: {
        $id: '#innerId',
        type: 'string',
        format: 'email'
      }
    }
  })

  fastify.addSchema({
    $id: 'http://fastify.test/point.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Longitude and Latitude Values',
    description: 'A geographical coordinate.',
    type: 'object',
    required: [
      'latitude',
      'longitude'
    ],
    properties: {
      email: { $ref: 'http://fastify.test/asset.json#/definitions/inner' },
      latitude: {
        type: 'number',
        minimum: -90,
        maximum: 90
      },
      longitude: {
        type: 'number',
        minimum: -180,
        maximum: 180
      },
      altitude: {
        type: 'number'
      }
    }
  })

  const schemaLocations = {
    $id: 'http://fastify.test/locations.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'List of Asset locations',
    type: 'array',
    items: { $ref: 'http://fastify.test/asset.json#' }
  }

  fastify.post('/', {
    schema: {
      body: schemaLocations,
      response: { 200: schemaLocations }
    }
  }, (req, reply) => {
    reply.send(locations.map(_ => Object.assign({ serializer: 'remove me' }, _)))
  })

  const locations = [
    { id: '550e8400-e29b-41d4-a716-446655440000', model: 'mod', location: { latitude: 10, longitude: 10, email: 'foo@bar.it' } },
    { id: '550e8400-e29b-41d4-a716-446655440000', model: 'mod', location: { latitude: 10, longitude: 10, email: 'foo@bar.it' } }
  ]
  fastify.inject({
    method: 'POST',
    url: '/',
    payload: locations
  }, (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), locations)

    fastify.inject({
      method: 'POST',
      url: '/',
      payload: locations.map(_ => {
        _.location.email = 'not an email'
        return _
      })
    }, (err, res) => {
      t.assert.ifError(err)
      t.assert.strictEqual(res.statusCode, 400)
      t.assert.deepStrictEqual(res.json(), {
        error: 'Bad Request',
        message: 'body/0/location/email must match format "email"',
        statusCode: 400,
        code: 'FST_ERR_VALIDATION'
      })
      testDone()
    })
  })
})

test('setSerializerCompiler is not supported any more', (t, testDone) => {
  t.plan(1)
  const fastify = Fastify({ exposeHeadRoutes: false })

  // The serializer compiler is gone with `fast-json-stringify`: the method
  // fails explicitly, it is never a silent no-op.
  t.assert.throws(
    () => fastify.setSerializerCompiler(() => () => { }),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )

  testDone()
})

test('a custom reply serializer that returns an invalid payload is reported', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  const outSchema = {
    $id: 'test',
    type: 'object',
    whatever: 'need to be parsed by the custom serializer'
  }

  fastify.get('/:id', {
    handler (req, reply) {
      // The custom serializer of the reply owns the wire format: the output
      // validation is skipped for it.
      reply.serializer(() => ({ not: 'a string' }))
      reply.send({ id: 1 })
    },
    schema: {
      response: {
        200: outSchema
      }
    }
  })

  fastify.inject({
    method: 'GET',
    url: '/123'
  }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.deepStrictEqual(res.json(), {
      statusCode: 500,
      code: 'FST_ERR_REP_INVALID_PAYLOAD_TYPE',
      error: 'Internal Server Error',
      message: 'Attempted to send payload of invalid type \'object\'. Expected a string or Buffer.'
    })
    testDone()
  })
})

test('the output pool is built when a schema is added after the route registration', async t => {
  const fastify = Fastify({ exposeHeadRoutes: false })

  const outSchema = {
    $id: 'test',
    type: 'object',
    properties: {
      id: { type: 'number' }
    }
  }

  // provoke the re-creation of the output pool in setupOutputValidator
  fastify.addSchema({ $id: 'dummy', type: 'object' })

  fastify.get('/foo/:id', {
    handler (_req, reply) {
      reply.send({ id: 1, extra: 'stripped' })
    },
    schema: {
      response: {
        200: outSchema
      }
    }
  })

  const res = await fastify.inject({
    method: 'GET',
    url: '/foo/123'
  })
  t.assert.strictEqual(res.statusCode, 200)
  // The output validator shapes the payload: the property that the response
  // schema does not declare never reaches the wire.
  t.assert.strictEqual(res.payload, '{"id":1}')
})

test('Custom serializer per route', async t => {
  const fastify = Fastify()

  const outSchema = {
    $id: 'test',
    type: 'object',
    properties: {
      mean: { type: 'string' }
    }
  }

  fastify.get('/default', {
    handler (req, reply) { reply.send({ mean: 'default' }) },
    schema: { response: { 200: outSchema } }
  })

  // The serializer compilers are gone with `fast-json-stringify`: the
  // instance level and the route level ones are both rejected explicitly.
  t.assert.throws(
    () => fastify.setSerializerCompiler(() => () => { }),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )

  t.assert.throws(
    () => fastify.get('/route', {
      handler (req, reply) { reply.send({}) },
      serializerCompiler: () => () => { },
      schema: { response: { 200: outSchema } }
    }),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )

  const res = await fastify.inject('/default')
  t.assert.strictEqual(res.json().mean, 'default')
})

test('Reply serializer win over serializer ', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify()
  fastify.setReplySerializer(function (payload, statusCode) {
    t.assert.deepStrictEqual(payload, { name: 'Foo', work: 'Bar', nick: 'Boo' })
    return 'instance serializator'
  })

  fastify.get('/', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            name: { type: 'string' },
            work: { type: 'string' }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.code(200).send({ name: 'Foo', work: 'Bar', nick: 'Boo' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.payload, 'instance serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('Reply serializer win over serializer ', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify()
  fastify.setReplySerializer(function (payload, statusCode) {
    t.assert.deepStrictEqual(payload, { name: 'Foo', work: 'Bar', nick: 'Boo' })
    return 'instance serializator'
  })

  fastify.get('/', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            name: { type: 'string' },
            work: { type: 'string' }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.code(200).send({ name: 'Foo', work: 'Bar', nick: 'Boo' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.payload, 'instance serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

// The output validation is skipped when a custom serializer owns the wire
// format: the payload is handed over to the serializer untouched and the
// response keeps the status code the handler chose.
const outputValidationSchema = {
  response: {
    200: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }
            }
          }
        }
      }
    }
  }
}

const invalidPayload = { name: 42, nick: 'Boo' }

test('The reply serializer wins over the output validator', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the output validator must not be called when there is a reply serializer')
            return true
          }
        }
      }
    }
  })

  fastify.get('/', { schema: outputValidationSchema }, function (req, reply) {
    reply.serializer(function (payload) {
      t.assert.deepStrictEqual(payload, invalidPayload)
      return 'reply serializator'
    })
    reply.type('application/vnd.api+json').code(200).send(invalidPayload)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, 'reply serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('The instance reply serializer wins over the output validator', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the output validator must not be called when there is a reply serializer')
            return true
          }
        }
      }
    }
  })
  fastify.setReplySerializer(function (payload) {
    t.assert.deepStrictEqual(payload, invalidPayload)
    return 'instance serializator'
  })

  fastify.get('/', { schema: outputValidationSchema }, function (req, reply) {
    reply.type('application/vnd.api+json').code(200).send(invalidPayload)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, 'instance serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('The output validation fails closed when no custom serializer is installed', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()

  fastify.get('/', { schema: outputValidationSchema }, function (req, reply) {
    reply.type('application/vnd.api+json').code(200).send(invalidPayload)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(JSON.parse(res.payload).code, 'FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN')
    testDone()
  })
})

test('A serializer installed by a preHandler hook skips the output validation', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the output validator must not be called when there is a reply serializer')
            return true
          }
        }
      }
    }
  })

  fastify.addHook('preHandler', function (request, reply, done) {
    reply.serializer(function (payload) {
      t.assert.deepStrictEqual(payload, invalidPayload)
      return 'preHandler serializator'
    })
    done()
  })

  fastify.get('/', { schema: outputValidationSchema }, function (req, reply) {
    reply.type('application/vnd.api+json').code(200).send(invalidPayload)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, 'preHandler serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('A serializer installed by a preValidation hook skips the output validation', (t, testDone) => {
  t.plan(4)

  const fastify = Fastify({
    schemaController: {
      compilersFactory: {
        buildOutputValidator () {
          return () => () => {
            t.assert.fail('the output validator must not be called when there is a reply serializer')
            return true
          }
        }
      }
    }
  })

  fastify.addHook('preValidation', function (request, reply, done) {
    reply.serializer(function (payload) {
      t.assert.deepStrictEqual(payload, invalidPayload)
      return 'preValidation serializator'
    })
    done()
  })

  fastify.get('/', { schema: outputValidationSchema }, function (req, reply) {
    reply.type('application/vnd.api+json').code(200).send(invalidPayload)
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.payload, 'preValidation serializator')
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('the error serializer falls back to the default one when the content type does not match', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const contentSchema = {
    content: {
      'text/plain': {
        schema: { type: 'object' }
      }
    }
  }

  fastify.get('/exact', { schema: { response: { 500: contentSchema } } }, async () => { throw new Error('boom') })
  fastify.get('/wildcard', { schema: { response: { '5xx': contentSchema } } }, async () => { throw new Error('boom') })
  fastify.get('/default', { schema: { response: { default: contentSchema } } }, async () => { throw new Error('boom') })

  for (const url of ['/exact', '/wildcard', '/default']) {
    const res = await fastify.inject(url)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(JSON.parse(res.payload).message, 'boom')
  }
})

test('The schema compiler recreate itself if needed', (t, testDone) => {
  t.plan(1)
  const fastify = Fastify()

  fastify.options('/', {
    schema: {
      response: { '2xx': { hello: { type: 'string' } } }
    }
  }, echoBody)

  fastify.register(function (fastify, options, done) {
    fastify.addSchema({
      $id: 'identifier',
      type: 'string',
      format: 'uuid'
    })

    fastify.get('/', {
      schema: {
        response: {
          '2xx': {
            foobarId: { $ref: 'identifier#' }
          }
        }
      }
    }, echoBody)

    done()
  })

  fastify.ready(err => {
    t.assert.ifError(err)
    testDone()
  })
})

test('The schema changes the default error handler output', async t => {
  t.plan(4)
  const fastify = Fastify()

  fastify.get('/:code', {
    schema: {
      response: {
        '2xx': { hello: { type: 'string' } },
        501: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          }
        },
        '5xx': {
          type: 'object',
          properties: {
            customId: { type: 'number' },
            error: { type: 'string' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, (request, reply) => {
    if (request.params.code === '501') {
      return reply.code(501).send(new Error('501 message'))
    }
    const error = new Error('500 message')
    error.customId = 42
    reply.send(error)
  })

  let res = await fastify.inject('/501')
  t.assert.strictEqual(res.statusCode, 501)
  t.assert.deepStrictEqual(res.json(), { message: '501 message' })

  res = await fastify.inject('/500')
  t.assert.strictEqual(res.statusCode, 500)
  t.assert.deepStrictEqual(res.json(), { error: 'Internal Server Error', message: '500 message', customId: 42 })
})

test('do not crash if status code serializer errors', async t => {
  const fastify = Fastify()

  const requiresFoo = {
    type: 'object',
    properties: { foo: { type: 'string' } },
    required: ['foo']
  }

  const someUserErrorType2 = {
    type: 'object',
    properties: {
      customCode: { type: 'number' }
    },
    required: ['customCode']
  }

  fastify.get(
    '/',
    {
      schema: {
        query: requiresFoo,
        response: { 400: someUserErrorType2 }
      }
    },
    (request, reply) => {
      t.assert.fail('handler, should not be called')
    }
  )

  const res = await fastify.inject({
    path: '/',
    query: {
      notfoo: true
    }
  })
  t.assert.strictEqual(res.statusCode, 500)
  t.assert.deepStrictEqual(res.json(), {
    statusCode: 500,
    code: 'FST_ERR_FAILED_ERROR_SERIALIZATION',
    // The error body does not satisfy the error schema of the route: the
    // error path does not recurse, it answers the serialization failure.
    message: 'Failed to serialize an error. Error: the error body does not match the error schema: must have required property \'customCode\'. ' +
      'Original error: querystring must have required property \'foo\''
  })
})

test('custom schema serializer error, empty message', async t => {
  t.plan(2)
  const fastify = Fastify()

  fastify.get('/:code', {
    schema: {
      response: {
        '2xx': { hello: { type: 'string' } },
        501: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          }
        }
      }
    }
  }, (request, reply) => {
    if (request.params.code === '501') {
      return reply.code(501).send(new Error(''))
    }
  })

  const res = await fastify.inject('/501')
  t.assert.strictEqual(res.statusCode, 501)
  t.assert.deepStrictEqual(res.json(), { message: '' })
})

test('the route level serializer compiler is rejected at registration', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()

  // The serializer compiler is gone with `fast-json-stringify`: the route
  // that declares it is rejected at registration, it is never ignored.
  t.assert.throws(
    () => fastify.get('/', {
      schema: {
        response: {
          '2xx': {
            type: 'object',
            properties: {
              some: { type: 'string' }
            }
          },
          500: {
            type: 'object',
            properties: {
              message: { type: 'string' }
            }
          }
        }
      },
      serializerCompiler: () => {
        throw new Error('CUSTOM_ERROR')
      }
    }, function (req, reply) {
      reply.code(200).send({ some: 'thing' })
    }),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )

  fastify.ready((err) => {
    t.assert.ifError(err)
    // The accessor does not expose a serializer compiler that does not
    // exist: it fails explicitly.
    t.assert.throws(
      () => fastify.serializerCompiler,
      { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
    )
    testDone()
  })
})

test('Errors in the output validation send to errorHandler', async t => {
  let savedError

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            power: { type: 'string' }
          },
          required: ['name']
        }
      }
    }
  }, function (req, reply) {
    // The payload does not satisfy the response schema: the output
    // validation fails and the error of the validation reaches the error
    // handler.
    reply.code(200).send({ power: 'thing' })
  })
  fastify.setErrorHandler((error, request, reply) => {
    savedError = error
    reply.code(500).send(error)
  })

  const res = await fastify.inject('/')

  t.assert.strictEqual(res.statusCode, 500)

  t.assert.deepStrictEqual(res.json(), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: must have required property \'name\''
  })
  t.assert.ok(savedError, 'error presents')
  t.assert.ok(savedError.validation, 'the validation errors are presents')
})

test('capital X', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        '2XX': {
          type: 'object',
          properties: {
            name: { type: 'string' },
            work: { type: 'string' }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.code(200).send({ name: 'Foo', work: 'Bar', nick: 'Boo' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { name: 'Foo', work: 'Bar' })
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('allow default as status code and used as last fallback', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.route({
    url: '/',
    method: 'GET',
    schema: {
      response: {
        default: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            work: { type: 'string' }
          }
        }
      }
    },
    handler: (req, reply) => {
      reply.code(200).send({ name: 'Foo', work: 'Bar', nick: 'Boo' })
    }
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { name: 'Foo', work: 'Bar' })
    t.assert.strictEqual(res.statusCode, 200)
    testDone()
  })
})

test('response schema is applied when Content-Type has whitespace before parameters', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public'],
                additionalProperties: false,
                properties: {
                  public: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.header('Content-Type', 'application/json ; charset=utf-8')
    reply.send({ public: 'ok', secret: 'SHOULD_BE_STRIPPED' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), { public: 'ok' })
    testDone()
  })
})

test('response schema is applied when Content-Type has tab before semicolon', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public'],
                additionalProperties: false,
                properties: {
                  public: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.header('Content-Type', 'application/json\t; charset=utf-8')
    reply.send({ public: 'ok', secret: 'SHOULD_BE_STRIPPED' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), { public: 'ok' })
    testDone()
  })
})

test('response schema is applied when Content-Type has trailing semicolon only', (t, testDone) => {
  t.plan(3)

  const fastify = Fastify()
  fastify.get('/', {
    schema: {
      response: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public'],
                additionalProperties: false,
                properties: {
                  public: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, function (req, reply) {
    reply.header('Content-Type', 'application/json ;')
    reply.send({ public: 'ok', secret: 'SHOULD_BE_STRIPPED' })
  })

  fastify.inject('/', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), { public: 'ok' })
    testDone()
  })
})
