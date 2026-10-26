'use strict'

const { test } = require('node:test')
const Fastify = require('../..')
const build = require('fast-json-stringify')

/**
 * The fjs parity harness.
 *
 * The cases of the wire parity suite assert the v6 literals: they lock the current behaviour in,
 * the divergences included. The harness below asks the question the suite
 * must ask: for a matrix of schemas and payloads, are the bytes of the v6
 * build the bytes of `fast-json-stringify`?
 *
 * `fast-json-stringify` is a devDependency: it is the reference of the
 * harness, never a runtime dependency.
 *
 * Every case of the matrix declares the divergences it tolerates, and every
 * divergence is documented in `DIVERGENCE_REASONS`. A case that diverges
 * without declaring it (or that declares a divergence that does not happen)
 * fails the suite: a new divergence cannot slip in.
 */
/**
 * The divergences the v6 build accepts, and the reason of each of them.
 */
const DIVERGENCE_REASONS = {
  'property-order': 'the v6 body carries the properties in the order of the payload, fjs carried them in the order of the schema (the required properties first)',
  'response-validation': 'the v6 build validates the response payload, the v5 build did not: a payload that does not satisfy the response schema answers a 500',
  'no-coercion': 'the v6 build never coerces a value into the type of the schema, fjs did: the payload is rejected with a 500',
  'branch-selection': 'the v6 build keeps the properties of every member of a composition, fjs kept the properties of the member that matches the payload',
  'schema-default': 'the v6 build never puts a schema default on the wire, fjs did',
  'null-payload': 'the v6 build answers the null payload as it is, fjs answered an empty object'
}

/**
 * The matrix of the parity harness.
 *
 * `fjs` is the body `fast-json-stringify` produces: it is pinned by the
 * harness, so that a change of the reference fails the suite loudly.
 */
const PARITY_MATRIX = [
  {
    name: 'an object schema serializes the declared properties only',
    schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    payload: { a: 'x', b: 2, c: true },
    fjs: '{"a":"x","b":2}'
  },
  {
    name: 'a property-less object schema answers an empty object',
    schema: { type: 'object' },
    payload: { id: 1, extra: 'stripped' },
    fjs: '{}'
  },
  {
    name: 'an object schema with additionalProperties keeps every property',
    schema: { type: 'object', properties: { id: { type: 'number' } }, additionalProperties: true },
    payload: { id: 1, extra: 'kept' },
    fjs: '{"id":1,"extra":"kept"}'
  },
  {
    name: 'an object schema with additionalProperties: false drops the extra properties',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    payload: { a: 'x', b: 2 },
    fjs: '{"a":"x"}'
  },
  {
    name: 'an object schema with an additionalProperties schema keeps the additional properties',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
    payload: { a: 'x', b: 'y' },
    fjs: '{"a":"x","b":"y"}'
  },
  {
    name: 'an additionalProperties schema never coerces the additional properties',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
    payload: { a: 'x', b: 2 },
    fjs: '{"a":"x","b":"2"}',
    divergences: ['no-coercion']
  },
  {
    name: 'a patternProperties schema keeps the properties that match a pattern only',
    schema: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
    payload: { xa: 's', b: 2 },
    fjs: '{"xa":"s"}'
  },
  {
    name: 'a patternProperties schema keeps the matching properties next to the declared ones',
    schema: { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } } },
    payload: { a: 'x', xa: 's', b: 2 },
    fjs: '{"a":"x","xa":"s"}'
  },
  {
    name: 'an allOf composition keeps the properties of every member',
    schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] },
    payload: { a: 'x', b: 2 },
    fjs: '{"a":"x","b":2}'
  },
  {
    name: 'an allOf composition drops the properties that no member declares',
    schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] },
    payload: { a: 'x', b: 2, c: true },
    fjs: '{"a":"x","b":2}'
  },
  {
    name: 'a nested allOf composition keeps the properties of every member',
    schema: { type: 'object', properties: { o: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] } } },
    payload: { o: { a: 'x', b: 2 } },
    fjs: '{"o":{"a":"x","b":2}}'
  },
  {
    name: 'an allOf composition keeps the properties matched by a patternProperties member',
    schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', patternProperties: { '^x': { type: 'string' } } }] },
    payload: { a: 'x', xa: 's', b: 2 },
    fjs: '{"a":"x","xa":"s"}'
  },
  {
    name: 'an anyOf composition keeps the properties of the member that matches the payload',
    schema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] },
    payload: { a: 'x' },
    fjs: '{"a":"x"}'
  },
  {
    name: 'an anyOf composition keeps the properties of every member',
    schema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] },
    payload: { a: 'x', b: 2 },
    fjs: '{"a":"x"}',
    divergences: ['branch-selection']
  },
  {
    name: 'a oneOf composition keeps the properties of the member that matches the payload',
    schema: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }] },
    payload: { b: 2 },
    fjs: '{"b":2}'
  },
  {
    name: 'an if/then composition keeps the properties of the then branch',
    schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { properties: { a: { type: 'string' } } }, else: { properties: { b: { type: 'number' } } } },
    payload: { kind: 'a', a: 'x' },
    fjs: '{"a":"x"}'
  },
  {
    name: 'an if/then composition keeps the properties of the else branch',
    schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { properties: { a: { type: 'string' } } }, else: { properties: { b: { type: 'number' } } } },
    payload: { kind: 'z', b: 2 },
    fjs: '{"b":2}'
  },
  {
    name: 'an if/then composition keeps the properties of every branch',
    schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { properties: { a: { type: 'string' } } }, else: { properties: { b: { type: 'number' } } } },
    payload: { kind: 'a', a: 'x', b: 2 },
    fjs: '{"a":"x"}',
    divergences: ['branch-selection']
  },
  {
    name: 'an array of objects shapes every item',
    schema: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
    payload: [{ a: 'x', b: 2 }],
    fjs: '[{"a":"x"}]'
  },
  {
    name: 'the properties are emitted in the order of the payload',
    schema: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'number' } } },
    payload: { a: 1, b: 2 },
    fjs: '{"b":2,"a":1}',
    divergences: ['property-order']
  },
  {
    name: 'the required properties are emitted first by fjs',
    schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['b'] },
    payload: { a: 1, b: 2 },
    fjs: '{"b":2,"a":1}',
    divergences: ['property-order']
  },
  {
    name: 'a schema default never reaches the wire',
    schema: { type: 'object', properties: { count: { type: 'number', default: 5 } } },
    payload: {},
    fjs: '{"count":5}',
    divergences: ['schema-default']
  },
  {
    name: 'a null payload answers the null payload',
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    payload: null,
    fjs: '{}',
    divergences: ['null-payload']
  },
  {
    name: 'a contains keyword does not shape the items',
    schema: { type: 'array', contains: { type: 'object' } },
    payload: [{ nested: 1 }],
    fjs: '[{"nested":1}]'
  },
  {
    name: 'a payload that does not satisfy the response schema is rejected',
    schema: { type: 'object', properties: { a: { type: 'string' } }, minProperties: 2 },
    payload: { a: 'x' },
    fjs: '{"a":"x"}',
    divergences: ['response-validation']
  }
]

/**
 * Serializes a value with a canonical (sorted) key order, so that two bodies
 * that carry the same properties in a different order compare equal.
 *
 * @param {*} value the value
 * @returns {string} the canonical form
 */
function canonical (value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/**
 * Tells whether every property of `reference` is in `body` with the same
 * value.
 *
 * @param {object} reference the reference body
 * @param {object} body the body
 * @returns {boolean} `true` when the body carries the reference
 */
function carries (reference, body) {
  if (reference === null || typeof reference !== 'object') {
    return canonical(reference) === canonical(body)
  }
  for (const key of Object.keys(reference)) {
    if (!Object.hasOwn(body, key)) {
      return false
    }
    if (!carries(reference[key], body[key])) {
      return false
    }
  }
  return true
}

/**
 * Detects the divergence between the fjs body and the v6 body.
 *
 * @param {object} entry the case of the matrix
 * @param {string} reference the body of `fast-json-stringify`
 * @param {object} response the response of the v6 build
 * @returns {string|null} the kind of the divergence, `null` when the bodies
 *   are identical
 */
function detectDivergence (entry, reference, response) {
  if (response.payload === reference) {
    return null
  }

  if (response.statusCode === 500) {
    // The payload was rejected: the v6 build validates the response and it
    // never coerces a value.
    const body = JSON.parse(response.payload)
    assertOutputValidationError(body.code === 'FST_ERR_OUTPUT_VALIDATION')
    return hasCoercedValue(entry.payload, reference) ? 'no-coercion' : 'response-validation'
  }

  if (reference === '{}' && response.payload === 'null') {
    return 'null-payload'
  }

  const expected = JSON.parse(reference)
  const actual = JSON.parse(response.payload)

  if (canonical(expected) === canonical(actual)) {
    return 'property-order'
  }

  if (carries(expected, actual)) {
    return 'branch-selection'
  }

  if (carries(actual, expected) && Object.keys(expected).length > Object.keys(actual).length) {
    return 'schema-default'
  }

  return 'unknown'
}

/**
 * Tells whether the fjs body holds a value that the payload does not, with
 * another type: fjs coerced it.
 *
 * @param {*} payload the payload
 * @param {string} reference the body of `fast-json-stringify`
 * @returns {boolean} `true` when a value was coerced
 */
function hasCoercedValue (payload, reference) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }
  const body = JSON.parse(reference)
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(body, key)) {
      continue
    }
    const value = payload[key]
    if (value === null || typeof value !== 'object') {
      if (typeof value !== typeof body[key]) {
        return true
      }
    }
  }
  return false
}

/**
 * A no-op assertion, used by the divergence detection to document the
 * invariant it relies on.
 *
 * @param {boolean} condition the condition
 */
function assertOutputValidationError (condition) {
  if (!condition) {
    throw new Error('the response does not carry the FST_ERR_OUTPUT_VALIDATION code')
  }
}

test('the wire bytes are the bytes of fast-json-stringify', async (t) => {
  for (const entry of PARITY_MATRIX) {
    const reference = build(entry.schema)(entry.payload)
    t.assert.strictEqual(reference, entry.fjs, `the fjs reference of "${entry.name}"`)

    const fastify = Fastify()
    fastify.get('/', {
      schema: { response: { 200: entry.schema } }
    }, async () => entry.payload)
    const response = await fastify.inject({ method: 'GET', url: '/' })
    await fastify.close()

    const divergence = detectDivergence(entry, reference, response)
    const declared = entry.divergences || []

    if (divergence === null) {
      t.assert.deepStrictEqual(declared, [], `"${entry.name}" declares a divergence that does not happen`)
      continue
    }

    t.assert.ok(DIVERGENCE_REASONS[divergence], `the divergence of "${entry.name}" is documented`)
    t.assert.deepStrictEqual(declared, [divergence], `"${entry.name}" declares its divergence`)
  }
})

test('the transform merges the members of a composition', async (t) => {
  const { applyFjsObjectParity } = require('../../lib/output-schema-parity')

  // The composition declares the properties of its members at the top level
  // and the members keep every property: the composition decides what
  // reaches the wire.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    }),
    {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true }
      ],
      properties: { a: true, b: true },
      additionalProperties: false
    },
    'the properties of the members are declared at the top level'
  )

  // A member that declares `additionalProperties: true` keeps every property
  // of the payload: the merged schema keeps them too.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', additionalProperties: true }
      ]
    }),
    {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
        { type: 'object', additionalProperties: true }
      ],
      properties: { a: true },
      additionalProperties: true
    },
    'a member that keeps every property wins'
  )

  // The composition that declares `additionalProperties` itself keeps it.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
      additionalProperties: true
    }),
    {
      allOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }],
      properties: { a: true },
      additionalProperties: true
    },
    'the composition keeps the additionalProperties it declares'
  )

  // A boolean member is not a schema: it is left alone.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ allOf: [true, { type: 'object', properties: { a: { type: 'string' } } }] }),
    {
      allOf: [
        true,
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }
      ],
      properties: { a: true },
      additionalProperties: false
    },
    'a boolean member is left alone'
  )

  // A shared document is transformed as a standalone document: the copy that
  // is embedded in a schema and the copy of the output pool must be equal.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({
      allOf: [{ $id: 'shared', type: 'object', properties: { a: { type: 'string' } } }]
    }),
    {
      allOf: [{ $id: 'shared', type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }],
      properties: { a: true },
      additionalProperties: false
    },
    'a shared document is not neutralized'
  )

  // A shared document that only takes part in the validation of the payload
  // is shaped as well: the two copies must stay equal.
  t.assert.deepStrictEqual(
    applyFjsObjectParity({ not: { $id: 'shared', type: 'object' } }),
    { not: { $id: 'shared', type: 'object', additionalProperties: false } },
    'a shared document is shaped whatever the keyword is'
  )
})
