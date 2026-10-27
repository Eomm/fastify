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
    { keyword: 'then', schema: { if: { type: 'object' }, then: { type: 'object' } }, path: ['then'] },
    { keyword: 'else', schema: { if: { type: 'object' }, else: { type: 'object' } }, path: ['else'] },
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

  // The subschemas of the keywords that only take part in the validation of
  // the payload are never shaped: `fast-json-stringify` ignores them. The
  // members of a composition keep every property: the composition decides
  // what reaches the wire.
  const validationOnly = new Set(['not', 'contains', 'dependentSchemas', 'if'])
  const compositionMembers = new Set(['allOf', 'anyOf', 'oneOf', 'then', 'else'])

  for (const entry of cases) {
    const transformed = applyFjsObjectParity(entry.schema)
    let nested = transformed
    for (const step of entry.path) {
      nested = nested[step]
    }
    t.assert.deepStrictEqual(
      nested,
      validationOnly.has(entry.keyword)
        ? { type: 'object' }
        : (compositionMembers.has(entry.keyword)
            ? { type: 'object', additionalProperties: true }
            : { type: 'object', additionalProperties: false }),
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

  // The `contains` keyword only takes part in the validation of the payload:
  // `fast-json-stringify` ignores it, so the items keep their properties.
  const contains = await request(t, fastify, '/contains')
  t.assert.strictEqual(contains.payload, '[{"nested":1}]')
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
  t.assert.deepStrictEqual(transformed.properties.child, { type: 'object', additionalProperties: false })
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
    [{ type: 'object', additionalProperties: false }],
    'a list of schemas is transformed'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: 'string' }),
    { type: 'string' },
    'a scalar schema is untouched'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: 'object', properties: null }),
    { type: 'object', properties: null, additionalProperties: false },
    'a malformed map keyword is copied as it is'
  )
})

test('the transform resolves the member of a composition that references another schema', async (t) => {
  // A member that references a definition of the document is copied into the
  // composition: the merge knows the properties it declares, and the copy
  // does not remove the properties of the other members.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [
        { $ref: '#/$defs/base' },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, b: true },
      additionalProperties: false
    },
    'the referenced definition is copied into the composition'
  )

  // A member that references a shared document is copied too: the copy does
  // not carry the identifier of the document (the document is registered
  // once, in the pool of the output side) and the references that are local
  // to the document are rebased.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      {
        allOf: [
          { $ref: 'base' },
          { type: 'object', properties: { b: { type: 'number' } } }
        ]
      },
      {
        sharedDocuments: {
          base: {
            $id: 'base',
            $defs: { inner: { type: 'object', properties: { deep: { type: 'string' } } } },
            type: 'object',
            properties: { nested: { $ref: '#/$defs/inner' } }
          }
        }
      }
    ),
    {
      allOf: [
        {
          $defs: { inner: { type: 'object', properties: { deep: { type: 'string' } }, additionalProperties: false } },
          type: 'object',
          properties: { nested: { $ref: 'base#/$defs/inner' } },
          additionalProperties: true
        },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { nested: true, b: true },
      additionalProperties: false
    },
    'the shared document is copied into the composition and its references are rebased'
  )

  // A member that references a subschema of a shared document is copied too.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'base#/$defs/x' }] },
      {
        sharedDocuments: {
          base: { $id: 'base', $defs: { x: { type: 'object', properties: { a: { type: 'string' } } } } }
        }
      }
    ),
    {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'a fragment of a shared document is copied into the composition'
  )

  // A member that references a nested identifier of a shared document is
  // copied too: the nested identifiers are indexed.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'nested' }] },
      {
        sharedDocuments: {
          base: {
            $id: 'base',
            $defs: { inner: { $id: 'nested', type: 'object', properties: { a: { type: 'string' } } } }
          }
        }
      }
    ),
    {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'a nested identifier of a shared document is resolved'
  )

  // A shared document that is embedded in the composition is resolved
  // through the index of the shared documents.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $id: 'base', type: 'object', properties: { a: { type: 'string' } } }] },
      { sharedDocuments: { base: { $id: 'base', type: 'object', properties: { a: { type: 'string' } } } } }
    ),
    {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'an embedded shared document is copied into the composition'
  )

  // A member whose reference cannot be resolved leaves the composition
  // without an `additionalProperties`: the parity layer never removes a
  // property it cannot prove to be extra. The reference itself is left in
  // the schema: the parity layer never drops a reference.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      allOf: [
        { $ref: 'nowhere' },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      allOf: [
        { $ref: 'nowhere' },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { b: true }
    },
    'an unresolvable reference leaves the composition open'
  )

  // A reference that is not a schema (a boolean one) is not resolved.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { flag: true },
      allOf: [{ $ref: '#/$defs/flag' }]
    }),
    {
      $defs: { flag: true },
      allOf: [{ $ref: '#/$defs/flag' }]
    },
    'a boolean reference is not resolved'
  )

  // A malformed reference is not resolved.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { list: [{ type: 'object' }] },
      allOf: [{ $ref: '#not-a-pointer' }, { $ref: '#/$defs/list' }]
    }),
    {
      $defs: { list: [{ type: 'object', additionalProperties: false }] },
      allOf: [{ $ref: '#not-a-pointer' }, { $ref: '#/$defs/list' }]
    },
    'a malformed reference is not resolved'
  )

  // A reference that points to something that is not a schema is not
  // resolved, and neither is a malformed reference to a shared document.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'base#not-a-pointer' }, { $ref: 'base#/$defs/list' }] },
      { sharedDocuments: { base: { $id: 'base', $defs: { list: [{ type: 'object' }] } } } }
    ),
    {
      allOf: [{ $ref: 'base#not-a-pointer' }, { $ref: 'base#/$defs/list' }]
    },
    'a malformed reference to a shared document is not resolved'
  )

  // A reference that walks into a value that is not a schema is not
  // resolved.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [{ $ref: '#/$defs/base/properties/a/type/extra' }, { $ref: '#/$defs/missing' }]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [{ $ref: '#/$defs/base/properties/a/type/extra' }, { $ref: '#/$defs/missing' }]
    },
    'a reference that walks into a value is not resolved'
  )

  // A shared document that carries an absolute identifier and a nested one
  // rebases the references of its copy.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'http://fastify.test/base' }] },
      {
        sharedDocuments: {
          'http://fastify.test/base': {
            $id: 'http://fastify.test/base',
            $defs: { inner: { $id: 'sub', type: 'object', properties: { a: { type: 'string' } } } },
            allOf: [{ type: 'object', properties: { nested: { $ref: '#/$defs/inner' } } }]
          }
        }
      }
    ),
    {
      allOf: [
        {
          $defs: { inner: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
          allOf: [
            {
              type: 'object',
              properties: { nested: { $ref: 'http://fastify.test/base#/$defs/inner' } },
              additionalProperties: true
            }
          ],
          additionalProperties: true,
          properties: { nested: true }
        }
      ],
      properties: { nested: true },
      additionalProperties: false
    },
    'the nested identifier of a shared document is rebased'
  )

  // A relative reference of a shared document is resolved against the base
  // of the document: the copy of the document lives in another document, so
  // the reference must carry the base of the source document, exactly like
  // the JSON Schema resolution rules do.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'http://fastify.test/base' }] },
      {
        sharedDocuments: {
          'http://fastify.test/base': {
            $id: 'http://fastify.test/base',
            type: 'object',
            properties: {
              nested: { $ref: 'other' },
              withFragment: { $ref: 'other#/$defs/x' },
              absolute: { $ref: 'http://fastify.test/absolute' }
            }
          }
        }
      }
    ),
    {
      allOf: [
        {
          type: 'object',
          properties: {
            nested: { $ref: 'http://fastify.test/other' },
            withFragment: { $ref: 'http://fastify.test/other#/$defs/x' },
            absolute: { $ref: 'http://fastify.test/absolute' }
          },
          additionalProperties: true
        }
      ],
      properties: { nested: true, withFragment: true, absolute: true },
      additionalProperties: false
    },
    'the relative references of a shared document are rebased'
  )

  // A base that carries an authority but no path resolves a relative
  // reference against the root of that authority: the resolved reference can
  // never point at another host than the base.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'http://fastify.test' }] },
      {
        sharedDocuments: {
          'http://fastify.test': {
            $id: 'http://fastify.test',
            type: 'object',
            properties: { nested: { $ref: 'other' } }
          }
        }
      }
    ),
    {
      allOf: [
        {
          type: 'object',
          properties: { nested: { $ref: 'http://fastify.test/other' } },
          additionalProperties: true
        }
      ],
      properties: { nested: true },
      additionalProperties: false
    },
    'a relative reference is resolved against the root of the authority of the base'
  )

  // The nested identifier of a document that carries an authority but no path
  // is resolved against the root of that authority too.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'http://fastify.test/sub' }] },
      {
        sharedDocuments: {
          'http://fastify.test': {
            $id: 'http://fastify.test',
            $defs: { inner: { $id: 'sub', type: 'object', properties: { a: { type: 'string' } } } }
          }
        }
      }
    ),
    {
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the nested identifier of a document that carries no path is resolved against the root of its authority'
  )

  // A shared document that is indexed under another identifier than its own
  // keeps the identifier of the document as the base of its references.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      { allOf: [{ $ref: 'alias' }] },
      {
        sharedDocuments: {
          alias: {
            $id: 'http://fastify.test/base',
            type: 'object',
            properties: { nested: { $ref: 'other' } }
          }
        }
      }
    ),
    {
      allOf: [
        {
          type: 'object',
          properties: { nested: { $ref: 'http://fastify.test/other' } },
          additionalProperties: true
        }
      ],
      properties: { nested: true },
      additionalProperties: false
    },
    'the identifier of the document is the base of its references'
  )

  // A circular reference is not resolved: the transform does not loop.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        a: { allOf: [{ $ref: '#/$defs/b' }] },
        b: { allOf: [{ $ref: '#/$defs/a' }] }
      },
      allOf: [{ $ref: '#/$defs/a' }]
    }),
    {
      $defs: {
        a: { allOf: [{ allOf: [{ allOf: [{ $ref: '#/$defs/b' }] }] }] },
        b: { allOf: [{ allOf: [{ allOf: [{ $ref: '#/$defs/a' }] }] }] }
      },
      allOf: [{ allOf: [{ allOf: [{ $ref: '#/$defs/a' }] }] }]
    },
    'a circular reference is not resolved'
  )

  // A member that carries the identifier of a shared document that could
  // not be resolved is left alone: its copy in the pool of the output side
  // must stay equal to this copy, or the validator refuses the schema.
  t.assert.deepStrictEqual(
    applyFjsObjectParity(
      {
        allOf: [
          { $id: 'sub', $ref: 'nowhere' },
          { type: 'object', properties: { b: { type: 'number' } } }
        ]
      },
      {
        sharedDocuments: {
          sub: { $id: 'sub', type: 'object', properties: { a: { type: 'string' } } }
        }
      }
    ),
    {
      allOf: [
        { $id: 'sub', $ref: 'nowhere' },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { b: true }
    },
    'a shared document that could not be resolved is left alone'
  )

  // The keywords that a member carries next to its reference are kept: a
  // reference does not replace them.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [
        { $ref: '#/$defs/base', description: 'the base', properties: { z: { type: 'number' } } },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
            z: { type: 'number' }
          },
          additionalProperties: true,
          description: 'the base'
        },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, z: true, b: true },
      additionalProperties: false
    },
    'the keywords that the member carries next to its reference are kept'
  )

  // The properties that the member declares next to its reference are merged
  // with the properties of the referenced schema: the referenced schema wins
  // for a property it already declares.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } } },
        broken: { type: 'object', properties: null }
      },
      allOf: [
        { $ref: '#/$defs/base', properties: { a: { type: 'number' }, z: { type: 'number' } } },
        { $ref: '#/$defs/broken', properties: { y: { type: 'number' } } },
        { $ref: '#/$defs/base', properties: null }
      ]
    }),
    {
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        broken: { type: 'object', properties: null, additionalProperties: false }
      },
      allOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
            z: { type: 'number' }
          },
          additionalProperties: true
        },
        {
          type: 'object',
          properties: { y: { type: 'number' } },
          additionalProperties: true
        },
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true
        }
      ],
      properties: { a: true, z: true, y: true },
      additionalProperties: false
    },
    'the properties of the member are merged with the properties of the referenced schema'
  )

  // The containers that hold the resources of a scope (`$defs`,
  // `definitions`, `dependentSchemas`) are merged with the copy of the
  // referenced schema, but the entries that declare an identifier are left
  // out: the copy of the member lives in the scope of the document that
  // embeds the composition, and the identifier would be declared twice — the
  // validator refuses a schema that resolves an identifier to two different
  // schemas ("reference \"...\" resolves to more than one schema").
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } } },
        x: { $id: 'urn:x', type: 'string' }
      },
      allOf: [
        { $ref: '#/$defs/base', $defs: { x: { $id: 'urn:x', type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        x: { $id: 'urn:x', type: 'string' }
      },
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, b: true },
      additionalProperties: false
    },
    'the entries of a sibling container that declare an identifier are not copied'
  )

  // The entries of a sibling container that declare no identifier are merged
  // with the copy of the referenced schema: the copy wins for an entry it
  // already declares.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: {
          $id: 'urn:base',
          $defs: { own: { type: 'string' } },
          type: 'object',
          properties: { a: { type: 'string' } }
        }
      },
      allOf: [
        {
          $ref: '#/$defs/base',
          $defs: { own: { type: 'number' }, other: { type: 'string' } }
        }
      ]
    }),
    {
      $defs: {
        base: {
          $id: 'urn:base',
          $defs: { own: { type: 'string' } },
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false
        }
      },
      allOf: [
        {
          $defs: { own: { type: 'string' }, other: { type: 'string' } },
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the entries of a sibling container that declare no identifier are merged'
  )

  // The copy of a local definition does not carry the identifier of the
  // definition: the copy is embedded in the scope of the document that holds
  // the composition, and the identifier would be declared twice (the
  // validator refuses a schema that resolves an identifier to two different
  // schemas).
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: {
          $id: 'urn:base',
          type: 'object',
          properties: { a: { type: 'string' } }
        }
      },
      allOf: [
        { $ref: '#/$defs/base' },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      $defs: {
        base: {
          $id: 'urn:base',
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false
        }
      },
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, b: true },
      additionalProperties: false
    },
    'the copy of a local definition does not carry its identifier'
  )

  // The pointers of the copy of a local definition are rewritten to the
  // pointer path of the definition in the root document: the copy lives in
  // another scope, and a pointer would otherwise resolve against the root
  // document and point at the wrong subschema.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: {
          $id: 'urn:base',
          $defs: { inner: { type: 'string' } },
          type: 'object',
          properties: { a: { $ref: '#/$defs/inner' } }
        }
      },
      allOf: [{ $ref: '#/$defs/base' }]
    }),
    {
      $defs: {
        base: {
          $id: 'urn:base',
          $defs: { inner: { type: 'string' } },
          type: 'object',
          properties: { a: { $ref: '#/$defs/inner' } },
          additionalProperties: false
        }
      },
      allOf: [
        {
          $defs: { inner: { type: 'string' } },
          type: 'object',
          properties: { a: { $ref: '#/$defs/base/$defs/inner' } },
          additionalProperties: true
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the pointers of the copy of a local definition are rewritten'
  )

  // The copy of a local definition does not carry the identifier of a
  // nested definition either: the nested definition keeps it, and it is
  // declared once in the scope of the document.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: {
          type: 'object',
          properties: { a: { type: 'string' } },
          $defs: { inner: { $id: 'urn:inner', type: 'string' } }
        }
      },
      allOf: [{ $ref: '#/$defs/base' }]
    }),
    {
      $defs: {
        base: {
          type: 'object',
          properties: { a: { type: 'string' } },
          $defs: { inner: { $id: 'urn:inner', type: 'string' } },
          additionalProperties: false
        }
      },
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          $defs: { inner: { type: 'string' } },
          additionalProperties: true
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the copy of a local definition does not carry the identifier of a nested definition'
  )

  // The relative references of the copy of a local definition are resolved
  // against the identifier of the scope the definition opens.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: {
          $id: 'http://fastify.test/base',
          type: 'object',
          properties: {
            nested: { $ref: 'other' },
            absolute: { $ref: 'http://fastify.test/absolute' }
          }
        }
      },
      allOf: [{ $ref: '#/$defs/base' }]
    }),
    {
      $defs: {
        base: {
          $id: 'http://fastify.test/base',
          type: 'object',
          properties: {
            nested: { $ref: 'other' },
            absolute: { $ref: 'http://fastify.test/absolute' }
          },
          additionalProperties: false
        }
      },
      allOf: [
        {
          type: 'object',
          properties: {
            nested: { $ref: 'http://fastify.test/other' },
            absolute: { $ref: 'http://fastify.test/absolute' }
          },
          additionalProperties: true
        }
      ],
      properties: { nested: true, absolute: true },
      additionalProperties: false
    },
    'the relative references of the copy of a local definition are resolved'
  )

  // An identifier that the scope declares once is not a duplicate: the entry
  // that declares it is copied into the copy of the referenced schema, and
  // the identifier stays declared once in the scope of the document.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [
        {
          $ref: '#/$defs/base',
          $defs: {
            nested: { $defs: { inner: { $id: 'urn:inner', type: 'string' } } },
            tuple: { prefixItems: [{ $id: 'urn:item', type: 'string' }] },
            flag: true
          }
        }
      ]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true,
          $defs: {
            nested: { $defs: { inner: { $id: 'urn:inner', type: 'string' } } },
            tuple: { prefixItems: [{ $id: 'urn:item', type: 'string' }] },
            flag: true
          }
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the entries that declare an identifier the scope declares once are copied'
  )

  // An identifier that the scope declares more than once is a duplicate: the
  // entry that declares it is not copied, or the copy would declare the
  // identifier a second time.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } } },
        inner: { $id: 'urn:inner', type: 'string' },
        item: { $id: 'urn:item', type: 'string' }
      },
      allOf: [
        {
          $ref: '#/$defs/base',
          $defs: {
            nested: { $defs: { inner: { $id: 'urn:inner', type: 'string' } } },
            tuple: { prefixItems: [{ $id: 'urn:item', type: 'string' }] }
          }
        }
      ]
    }),
    {
      $defs: {
        base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        inner: { $id: 'urn:inner', type: 'string' },
        item: { $id: 'urn:item', type: 'string' }
      },
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'an entry that declares a duplicated identifier is not copied'
  )

  // The other containers that hold the resources of a scope are merged as
  // well: their entries declare no identifier, and a constraint they carry
  // must stay effective.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [
        {
          $ref: '#/$defs/base',
          definitions: { legacy: { type: 'string' } },
          dependentSchemas: { a: { required: ['b'] } }
        }
      ]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true,
          definitions: { legacy: { type: 'string' } },
          dependentSchemas: { a: { required: ['b'] } }
        }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'the sibling containers that declare no identifier are merged'
  )

  // A sibling container that carries no map at all is ignored: the copy of
  // the referenced schema is not given an empty container.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      allOf: [
        { $ref: '#/$defs/base', $defs: null },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, b: true },
      additionalProperties: false
    },
    'a sibling container that carries no map is ignored'
  )

  // The `then` branch of an `if`/`then` composition is replaced too.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
      then: { $ref: '#/$defs/base' }
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
      then: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
      properties: { a: true },
      additionalProperties: false
    },
    'the then branch of an if/then composition is resolved'
  )

  // The `else` branch of an `if`/`else` composition is replaced too.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
      if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
      else: { $ref: '#/$defs/base' }
    }),
    {
      $defs: { base: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
      if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
      else: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
      properties: { a: true },
      additionalProperties: false
    },
    'the else branch of an if/else composition is resolved'
  )
})

test('a schema that describes an object without declaring the object type is an object schema', async (t) => {
  // A union type (`type: ['object', 'null']`, the shape of a nullable
  // response object) and the keywords that only make sense for an object
  // describe an object: the rule 1 of the parity applies to them.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: ['object', 'null'] }),
    { type: ['object', 'null'], additionalProperties: false },
    'a union type that carries the object type is an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ type: ['string', 'null'] }),
    { type: ['string', 'null'] },
    'a union type that does not carry the object type is not an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ minProperties: 1 }),
    { minProperties: 1, additionalProperties: false },
    'a schema that declares minProperties is an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ maxProperties: 1 }),
    { maxProperties: 1, additionalProperties: false },
    'a schema that declares maxProperties is an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ required: ['a'] }),
    { required: ['a'], additionalProperties: false },
    'a schema that declares required is an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ propertyNames: { pattern: '^a' } }),
    { propertyNames: { pattern: '^a' } },
    'a schema that declares propertyNames is not an object schema'
  )
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ dependencies: { b: ['a'] } }),
    { dependencies: { b: ['a'] }, additionalProperties: false },
    'a schema that declares dependencies is an object schema'
  )
})

test('a composition whose member references a definition keeps the properties of both members', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
          allOf: [
            { $ref: '#/$defs/base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member references a shared document keeps the properties of both members', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addSchema({ $id: 'base', type: 'object', properties: { a: { type: 'string' } } })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          allOf: [
            { $ref: 'base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member references a shared document that references another document keeps the properties', async (t) => {
  // The copy of the shared document lives in the schema of the route: the
  // relative reference it carries must be resolved against the base of the
  // source document, or the validator cannot resolve it at all.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addSchema({
    $id: 'http://fastify.test/base',
    type: 'object',
    properties: { nested: { $ref: 'other' } }
  })
  fastify.addSchema({ $id: 'http://fastify.test/other', type: 'string' })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          allOf: [
            { $ref: 'http://fastify.test/base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ nested: 's', b: 2 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"nested":"s","b":2}')
})

test('a composition whose member references a shared document that carries no path keeps the properties of both members', async (t) => {
  // The base of the source document carries an authority but no path: the
  // relative reference it carries must be resolved against the root of that
  // authority (`http://fastify.test/other`), and never against another host
  // (`http://other`), or the validator cannot resolve it at all.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addSchema({
    $id: 'http://fastify.test',
    type: 'object',
    properties: { nested: { $ref: 'other' } }
  })
  fastify.addSchema({ $id: 'http://fastify.test/other', type: 'string' })

  fastify.get('/', {
    schema: {
      response: {
        200: {
          allOf: [
            { $ref: 'http://fastify.test' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ nested: 's', b: 2 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"nested":"s","b":2}')
})

test('a composition whose member carries its own identifier keeps the properties of every member', async (t) => {
  // The member that carries its own identifier is not published through
  // `fastify.addSchema()`: it must not remove the properties that the other
  // members declare, or the body is a subset of the fjs body.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          allOf: [
            { $id: 'sub', type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member references a local definition that carries an identifier is built', async (t) => {
  // The copy of the local definition is embedded in the scope of the
  // document: it must not carry the identifier of the definition, or the
  // identifier would be declared twice and the route would not build at all
  // (`FST_ERR_SCH_SERIALIZATION_BUILD`).
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          $defs: {
            base: { $id: 'urn:base', type: 'object', properties: { a: { type: 'string' } } }
          },
          allOf: [
            { $ref: '#/$defs/base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member references a local definition that carries a nested identifier is built', async (t) => {
  // The identifier of a nested definition belongs to the nested definition
  // too: the copy of the local definition must not carry it, or the
  // identifier would be declared twice.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          $defs: {
            base: {
              type: 'object',
              properties: { a: { type: 'string' } },
              $defs: { inner: { $id: 'urn:inner', type: 'string' } }
            }
          },
          allOf: [
            { $ref: '#/$defs/base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member references a local definition that carries a pointer is built', async (t) => {
  // The pointer of the copy of the local definition is rewritten to the
  // pointer path of the definition in the document: the copy lives in
  // another scope, and the pointer would otherwise resolve against the root
  // document and point at the wrong subschema.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          $defs: {
            base: {
              $id: 'urn:base',
              $defs: { inner: { type: 'string' } },
              type: 'object',
              properties: { a: { $ref: '#/$defs/inner' } }
            }
          },
          allOf: [
            { $ref: '#/$defs/base' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a composition whose member carries a reference and a sibling container is built', async (t) => {
  // The copy of the referenced schema replaces the member of the composition
  // and it lives in the scope of the document: the entries of a sibling
  // container that declare an identifier are not copied into it, or the
  // identifier would be declared twice and the route would not build at all
  // (`FST_ERR_SCH_SERIALIZATION_BUILD`).
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          $defs: {
            base: { type: 'object', properties: { a: { type: 'string' } } },
            x: { $id: 'urn:x', type: 'string' }
          },
          allOf: [
            { $ref: '#/$defs/base', $defs: { x: { $id: 'urn:x', type: 'string' } } },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ a: 'x', b: 2, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":"x","b":2}')
})

test('a member that carries a reference and a sibling keyword still constrains the payload', async (t) => {
  // The keywords that the member carries next to its reference are kept: the
  // copy of the referenced schema does not replace them, or the payload would
  // not be constrained any more.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/required', {
    schema: {
      response: {
        200: {
          $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
          allOf: [
            {
              $ref: '#/$defs/base',
              required: ['b']
            }
          ]
        }
      }
    }
  }, async () => ({ a: 'x' }))

  fastify.get('/dependent', {
    schema: {
      response: {
        200: {
          $defs: { base: { type: 'object', properties: { a: { type: 'string' } } } },
          allOf: [
            {
              $ref: '#/$defs/base',
              dependencies: { a: { required: ['b'] } }
            }
          ]
        }
      }
    }
  }, async () => ({ a: 'x' }))

  const response = await request(t, fastify, '/required')
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.strictEqual(response.json().code, 'FST_ERR_OUTPUT_VALIDATION')

  const dependent = await request(t, fastify, '/dependent')
  t.assert.strictEqual(dependent.statusCode, 500)
  t.assert.strictEqual(dependent.json().code, 'FST_ERR_OUTPUT_VALIDATION')
})

test('a composition whose member carries an unresolvable reference does not compile', async (t) => {
  // The parity layer never drops a reference: a reference it cannot resolve
  // stays in the schema, so the validator cannot compile it. The route
  // answers a `FST_ERR_SCH_SERIALIZATION_BUILD` error instead of a body:
  // there is no body that could be a subset of the fjs body.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: {
          allOf: [
            { $ref: 'nowhere' },
            { type: 'object', properties: { b: { type: 'number' } } }
          ]
        }
      }
    }
  }, async () => ({ b: 2 }))

  await t.assert.rejects(
    fastify.ready(),
    (err) => {
      t.assert.strictEqual(err.code, 'FST_ERR_SCH_SERIALIZATION_BUILD')
      t.assert.match(err.message, /can't resolve reference nowhere/)
      return true
    }
  )
})

test('a schema that declares only propertyNames keeps every property', async (t) => {
  // `fast-json-stringify` ignores the `propertyNames` keyword: it does not
  // recognize an object through it, so it serializes the payload as it is.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { propertyNames: { pattern: '^a' } }
      }
    }
  }, async () => ({ a: 1 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"a":1}')
})

test('a schema that declares only dependencies answers an empty object', async (t) => {
  // `fast-json-stringify` recognizes an object through the `dependencies`
  // keyword: it serializes the declared properties only, and the schema
  // declares none.
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { dependencies: { b: ['a'] } }
      }
    }
  }, async () => ({ a: 1, b: 2 }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{}')
})

test('a nullable object schema answers an empty object', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', {
    schema: {
      response: {
        200: { type: ['object', 'null'] }
      }
    }
  }, async () => ({ id: 1, extra: 'stripped' }))

  const response = await request(t, fastify, '/')
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{}')
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
