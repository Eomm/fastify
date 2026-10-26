'use strict'

/**
 * The fjs parity layer of the output side.
 *
 * `fast-json-stringify` shaped the response payload with the schema: a
 * property-less object schema produced `{}` (every property was dropped) and
 * an object schema with `additionalProperties: true` kept every property.
 *
 * The Ajv output validator of Phase 1 shapes the payload with
 * `removeAdditional: 'all'`, which does not reproduce those two behaviours:
 *
 * - an object schema that declares no `properties` has nothing to remove, so
 *   every property of the payload survives;
 * - an object schema that declares `additionalProperties: true` loses every
 *   property that is not declared in `properties`.
 *
 * This module restores the fjs behaviour with two rules, applied to a **deep
 * copy** of the schema (the schema of the user is never mutated: the OpenAPI
 * documentation reads it):
 *
 * - rule 1: an object schema that declares no `properties`, no
 *   `patternProperties` and no `additionalProperties` gets `properties: {}`,
 *   so that the validator strips every property of the payload;
 * - rule 2: an object schema that declares `additionalProperties: true` and
 *   no `patternProperties` gets `patternProperties: { '': true }` instead, so
 *   that the validator keeps every property of the payload.
 *
 * The rules are applied recursively: the subschemas reachable through the
 * keywords of `PARITY_RECURSION_KEYWORDS` are transformed as well. A `$ref` is
 * not followed: the referenced document is transformed where it is defined, in
 * the copy of the external schemas that is seeded into the output pool.
 */

/**
 * The keywords whose subschemas are visited by the transform.
 *
 * The walk iterates over this list: the module has one recursion branch
 * instead of one branch per keyword, so that the reachable shapes are
 * enumerated in a single place.
 */
const PARITY_RECURSION_KEYWORDS = [
  'properties',
  'patternProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'propertyNames',
  '$defs',
  'definitions'
]

/**
 * The keywords of `PARITY_RECURSION_KEYWORDS` whose value is a map of
 * subschemas (a name, a pattern or a definition id → a schema) instead of a
 * single subschema or a list of subschemas.
 */
const PARITY_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions'
])

/**
 * Applies the fjs parity rules to a schema.
 *
 * @param {object|boolean} schema the schema to transform
 * @returns {object|boolean} a deep copy of the schema with the parity rules
 *   applied
 */
function applyFjsObjectParity (schema) {
  if (Array.isArray(schema)) {
    // A list of subschemas (`allOf`, `anyOf`, `oneOf`, `prefixItems`, ...).
    return schema.map(applyFjsObjectParity)
  }

  if (schema === null || typeof schema !== 'object') {
    // A boolean schema or a scalar: the rules never touch it.
    return schema
  }

  const copy = {}
  for (const key of Object.keys(schema)) {
    copy[key] = transformKeyword(key, schema[key])
  }

  applyObjectParityRules(copy)

  return copy
}

/**
 * Transforms the value of a keyword of a schema.
 *
 * @param {string} key the keyword
 * @param {*} value the value of the keyword
 * @returns {*} the transformed value
 */
function transformKeyword (key, value) {
  if (!PARITY_RECURSION_KEYWORDS.includes(key)) {
    return deepCopy(value)
  }

  if (Array.isArray(value)) {
    // A list of subschemas (`items` as a tuple, `prefixItems`, `allOf`, ...).
    return value.map(applyFjsObjectParity)
  }

  if (PARITY_MAP_KEYWORDS.has(key)) {
    if (value === null || typeof value !== 'object') {
      return value
    }
    const mapped = {}
    for (const name of Object.keys(value)) {
      mapped[name] = applyFjsObjectParity(value[name])
    }
    return mapped
  }

  // A single subschema (`not`, `if`, `then`, `else`, `contains`, `items`, ...).
  return applyFjsObjectParity(value)
}

/**
 * Copies a value of a schema that the transform does not visit.
 *
 * The copy is deep, so that the schema of the user is never reachable from
 * the transformed schema.
 *
 * @param {*} value the value to copy
 * @returns {*} the copy
 */
function deepCopy (value) {
  if (Array.isArray(value)) {
    return value.map(deepCopy)
  }

  if (value !== null && typeof value === 'object') {
    const copy = Object.create(Object.getPrototypeOf(value))
    for (const key of Object.keys(value)) {
      copy[key] = deepCopy(value[key])
    }
    return copy
  }

  return value
}

/**
 * Applies the two parity rules to a schema.
 *
 * @param {object} schema the copy of the schema
 */
function applyObjectParityRules (schema) {
  const hasProperties = schema.properties !== undefined
  const hasPatternProperties = schema.patternProperties !== undefined
  const hasAdditionalProperties = schema.additionalProperties !== undefined

  const isObjectSchema = schema.type === 'object' ||
    hasProperties ||
    hasPatternProperties ||
    hasAdditionalProperties

  if (!isObjectSchema) {
    // Not an object schema: the rules never touch an array or a scalar.
    return
  }

  if (!hasProperties && !hasPatternProperties && !hasAdditionalProperties) {
    // Rule 1: fjs emitted `{}` for a property-less object schema.
    schema.properties = {}
    return
  }

  if (hasAdditionalProperties && !hasPatternProperties && schema.additionalProperties === true) {
    // Rule 2: fjs kept every additional property.
    delete schema.additionalProperties
    schema.patternProperties = { '': true }
  }
}

module.exports = {
  applyFjsObjectParity,
  PARITY_RECURSION_KEYWORDS
}
