'use strict'

const { test } = require('node:test')
const Fastify = require('../..')
const { applyFjsObjectParity, PARITY_RECURSION_KEYWORDS } = require('../../lib/output-schema-parity')

/**
 * The wire parity suite of the Phase 2.
 *
 * Every case asserts the **body string**, not only the parsed object: a change
 * of the bytes is visible.
 */

async function request (t, fastify, url, payload) {
  const response = await fastify.inject({ method: 'GET', url, payload })
  return response
}

test('the extra properties of the payload are stripped', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ id: 1, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"id":1}')
})

test('a property-less object schema answers an empty object (the rule 1 of the parity)', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: 'object' }
      }
    }
  }, async () => ({ id: 1, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{}')
})

test('the rule 1 of the parity is applied recursively', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            a: { type: 'object' }
          }
        }
      }
    }
  }, async () => ({ a: { x: 1 } }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":{}}')
})

test('the rule 1 of the parity is applied inside an array', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: { type: 'object' }
        }
      }
    }
  }, async () => [{ x: 1 }])

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '[{}]')
})

test('an object schema with additionalProperties keeps every property (the rule 2 of the parity)', async (t) => {
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
  }, async () => ({ id: 1, extra: 'kept' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"id":1,"extra":"kept"}')
})

test('the parity reaches every recursion keyword', async (t) => {
  // One case per entry of the keyword list: the transform must reach the
  // subschema of the keyword. The list is asserted as well, so that a keyword
  // added to the module without a case here fails the suite.
  const cases = [
    { keyword: 'properties', schema: { type: 'object', properties: { child: { type: 'object' } } }, path: ['properties', 'child'] },
    { keyword: 'patternProperties', schema: { type: 'object', patternProperties: { '^x': { type: 'object' } } }, path: ['patternProperties', '^x'] },
    { keyword: 'items', schema: { type: 'array', items: { type: 'object' } }, path: ['items'] },
    { keyword: 'prefixItems', schema: { type: 'array', prefixItems: [{ type: 'object' }] }, path: ['prefixItems', 0] },
    { keyword: 'additionalItems', schema: { type: 'array', items: [{ type: 'number' }], additionalItems: { type: 'object' } }, path: ['additionalItems'] },
    { keyword: 'contains', schema: { type: 'array', contains: { type: 'object' } }, path: ['contains'] },
    { keyword: 'allOf', schema: { allOf: [{ type: 'object' }] }, path: ['allOf', 0] },
    { keyword: 'anyOf', schema: { anyOf: [{ type: 'object' }] }, path: ['anyOf', 0] },
    { keyword: 'oneOf', schema: { oneOf: [{ type: 'object' }] }, path: ['oneOf', 0] },
    { keyword: 'not', schema: { not: { type: 'object' } }, path: ['not'] },
    { keyword: 'if', schema: { if: { type: 'object' } }, path: ['if'] },
    { keyword: 'then', schema: { then: { type: 'object' } }, path: ['then'] },
    { keyword: 'else', schema: { else: { type: 'object' } }, path: ['else'] },
    { keyword: 'dependentSchemas', schema: { dependentSchemas: { child: { type: 'object' } } }, path: ['dependentSchemas', 'child'] },
    { keyword: 'propertyNames', schema: { propertyNames: { type: 'object' } }, path: ['propertyNames'] },
    { keyword: '$defs', schema: { $defs: { child: { type: 'object' } } }, path: ['$defs', 'child'] },
    { keyword: 'definitions', schema: { definitions: { child: { type: 'object' } } }, path: ['definitions', 'child'] }
  ]

  t.assert.deepStrictEqual(
    cases.map(entry => entry.keyword).sort(),
    [...PARITY_RECURSION_KEYWORDS].sort(),
    'every keyword of the list has a case'
  )

  for (const entry of cases) {
    const transformed = applyFjsObjectParity(entry.schema)
    let nested = transformed
    for (const step of entry.path) {
      nested = nested[step]
    }
    t.assert.deepStrictEqual(
      nested,
      { type: 'object', properties: {} },
      `the parity reaches the subschema of "${entry.keyword}"`
    )
  }
})

test('the parity reaches the subschema of a keyword at runtime', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/pattern-properties', {
    schema: {
      response: {
        200: {
          type: 'object',
          patternProperties: {
            '^x': { type: 'object' }
          }
        }
      }
    }
  }, async () => ({ xa: { nested: 1 } }))

  fastify.get('/contains', {
    schema: {
      response: {
        200: {
          type: 'array',
          contains: { type: 'object' }
        }
      }
    }
  }, async () => [{ nested: 1 }])

  const patternProperties = await request(t, fastify, '/pattern-properties')
  t.assert.strictEqual(patternProperties.payload, '{"xa":{}}')

  const contains = await request(t, fastify, '/contains')
  t.assert.strictEqual(contains.payload, '[{}]')
})

test('the transform never mutates the schema it receives', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      child: { type: 'object' }
    },
    required: ['child'],
    default: { child: { nested: true } }
  }
  const snapshot = JSON.stringify(schema)

  const transformed = applyFjsObjectParity(schema)

  t.assert.strictEqual(JSON.stringify(schema), snapshot, 'the schema of the user is untouched')
  t.assert.deepStrictEqual(transformed.properties.child, { type: 'object', properties: {} })
  t.assert.notStrictEqual(transformed, schema, 'the transform returns a copy')
  t.assert.notStrictEqual(transformed.properties, schema.properties, 'the copy is deep')
  t.assert.notStrictEqual(transformed.required, schema.required, 'the copy is deep')
  t.assert.notStrictEqual(transformed.default, schema.default, 'the copy is deep')
})

test('the transform leaves the schemas that are not object schemas alone', async (t) => {
  t.assert.strictEqual(applyFjsObjectParity(true), true, 'a boolean schema is untouched')
  t.assert.strictEqual(applyFjsObjectParity(null), null, 'a null schema is untouched')
  t.assert.deepStrictEqual(
    applyFjsObjectParity([{ type: 'object' }]),
    [{ type: 'object', properties: {} }],
    'a list of schemas is transformed'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: 'string' }),
    { type: 'string' },
    'a scalar schema is untouched'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: 'object', properties: null }),
    { type: 'object', properties: null },
    'a malformed map keyword is untouched'
  )
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
            b: { type: 'number' },
            a: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ a: 1, b: 2 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":1,"b":2}')
})

test('a schema default never reaches the wire', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'number', default: 5 }
          }
        }
      }
    }
  }, async () => ({}))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{}')
})

test('a wrongly typed payload is never coerced: it fails with FST_ERR_OUTPUT_VALIDATION', async (t) => {
  let capturedError = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', (request, reply, error, done) => {
    capturedError = error
    done()
  })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ id: 'not a number' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.deepStrictEqual(JSON.parse(response.payload), {
    statusCode: 500,
    code: 'FST_ERR_OUTPUT_VALIDATION',
    error: 'Internal Server Error',
    message: 'Response validation failed. Errors: /id must be number'
  })
  t.assert.ok(Array.isArray(capturedError.validation), 'the error carries the Ajv errors')
  t.assert.strictEqual(capturedError.validationContext, 'response')
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
  }, async () => null)

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, 'null')
  t.assert.strictEqual(validated, 0, 'the validator has never been invoked')
})

test('the payload is stripped before the preSerialization hooks and the hook may add a field', async (t) => {
  let payloadSeenByTheHook = null
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('preSerialization', (request, reply, payload, done) => {
    payloadSeenByTheHook = payload
    payload.addedByTheHook = true
    done(null, payload)
  })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ id: 1, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(payloadSeenByTheHook, { id: 1, addedByTheHook: true }, 'the hook receives the stripped object')
  t.assert.strictEqual(response.payload, '{"id":1,"addedByTheHook":true}')
})

test('a BigInt payload answers a 500: the native JSON.stringify throws', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ id: 1n }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 500)
})

test('a Date payload answers its ISO string', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ date: new Date('2024-01-02T03:04:05.000Z') }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"date":"2024-01-02T03:04:05.000Z"}')
})

test('an undefined property is omitted', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ id: 1, missing: undefined }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"id":1}')
})

test('NaN and Infinity become null', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async () => ({ nan: NaN, infinity: Infinity }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"nan":null,"infinity":null}')
})

test('a custom reply serializer owns the wire format', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'number' }
          }
        }
      }
    }
  }, async (request, reply) => {
    reply.serializer(() => '{"custom":true}')
    return { id: 'not a number', extra: 'not stripped' }
  })

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"custom":true}')
})

test('the reply serializer of the instance owns the wire format', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.setReplySerializer(() => '{"instance":true}')

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'number' }
          }
        }
      }
    }
  }, async () => ({ id: 'not a number', extra: 'not stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"instance":true}')
})
