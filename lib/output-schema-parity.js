'use strict'

/**
 * The fjs parity layer of the output side.
 *
 * `fast-json-stringify` shaped the response payload with the schema: it
 * serialized the declared properties, dropped the properties that the schema
 * does not describe and merged the members of a composition (`allOf`,
 * `anyOf`, `oneOf`, `if`/`then`/`else`) into a single schema.
 *
 * The Ajv output validator of Phase 1 shapes the payload with
 * `removeAdditional: 'all'`, whose semantics differ from the fjs ones:
 *
 * - `removeAdditional: 'all'` removes every property that is not declared in
 *   `properties` or matched by `patternProperties`, whatever the
 *   `additionalProperties` keyword says: a schema that declares
 *   `additionalProperties: <schema>` loses the properties it allows;
 * - a schema that declares only `patternProperties` has nothing to remove
 *   against, so the properties that match no pattern survive;
 * - `removeAdditional` is applied **inside every member of a composition**:
 *   each member strips the properties that belong to the other members, so
 *   the payload ends up empty.
 *
 * This module restores the fjs behaviour with an explicit transform, applied
 * to a **deep copy** of the schema (the schema of the user is never mutated:
 * the OpenAPI documentation reads it). The transform works with the
 * `removeAdditional: true` option of the output pool, which removes a
 * property only where the schema declares `additionalProperties: false`:
 *
 * - rule 1: an object schema that declares no `additionalProperties` gets
 *   `additionalProperties: false`, so that the validator drops every property
 *   that the schema does not describe (this covers the property-less object
 *   schema, which fjs answered with `{}`);
 * - rule 2: an object schema that declares `additionalProperties: true` or
 *   `additionalProperties: <schema>` keeps it, so that the validator keeps
 *   (and, for a schema, validates) the additional properties;
 * - rule 3: the members of a composition are merged at the top level of the
 *   composition, exactly like the fjs merge does: the properties (and the
 *   property patterns) of the members are declared at the top level, so that
 *   the validator keeps them, and the members themselves are told not to
 *   remove anything, so that they do not strip the properties of the other
 *   members.
 *
 * The rules are applied recursively: the subschemas reachable through the
 * keywords of `PARITY_RECURSION_KEYWORDS` are transformed as well. The
 * subschemas of `VALIDATION_ONLY_KEYWORDS` are transformed for their
 * validation only: `fast-json-stringify` ignores them, so they must not
 * remove anything from the payload. A `$ref` is not followed: the referenced
 * document is transformed where it is defined, in the copy of the external
 * schemas that is seeded into the output pool.
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
 * The keywords whose subschemas take part in the validation of the payload
 * and never in its shaping.
 *
 * `fast-json-stringify` ignores them: it serializes the payload with the
 * properties of the schema it merges, and nothing else. The subschemas of
 * these keywords must therefore not remove anything from the payload: they
 * would strip the properties that the shaping of the parent schema keeps.
 */
const VALIDATION_ONLY_KEYWORDS = new Set([
  'not',
  'contains',
  'dependentSchemas',
  'if'
])

/**
 * Applies the fjs parity rules to a schema.
 *
 * @param {object|boolean} schema the schema to transform
 * @returns {object|boolean} a deep copy of the schema with the parity rules
 *   applied
 */
function applyFjsObjectParity (schema) {
  return transformSchema(schema, true)
}

/**
 * Transforms a schema and its subschemas.
 *
 * @param {object|boolean} schema the schema to transform
 * @param {boolean} shaping `false` when the schema only takes part in the
 *   validation of the payload and never in its shaping
 * @returns {object|boolean} the transformed schema
 */
function transformSchema (schema, shaping) {
  if (Array.isArray(schema)) {
    // A list of subschemas (`allOf`, `anyOf`, `oneOf`, `prefixItems`, ...).
    return schema.map(item => transformSchema(item, shaping))
  }

  if (schema === null || typeof schema !== 'object') {
    // A boolean schema or a scalar: the rules never touch it.
    return schema
  }

  const copy = {}
  for (const key of Object.keys(schema)) {
    copy[key] = transformKeyword(key, schema[key], shaping)
  }

  applyParityRules(copy, shaping)

  return copy
}

/**
 * Transforms the value of a keyword of a schema.
 *
 * @param {string} key the keyword
 * @param {*} value the value of the keyword
 * @param {boolean} shaping `false` when the subschema of the keyword only
 *   takes part in the validation of the payload
 * @returns {*} the transformed value
 */
function transformKeyword (key, value, shaping) {
  if (!PARITY_RECURSION_KEYWORDS.includes(key)) {
    return deepCopy(value)
  }

  if (Array.isArray(value)) {
    // A list of subschemas (`items` as a tuple, `prefixItems`, `allOf`, ...).
    return value.map(item => transformSchema(item, childShaping(item, key, shaping)))
  }

  if (PARITY_MAP_KEYWORDS.has(key)) {
    if (value === null || typeof value !== 'object') {
      return value
    }
    const mapped = {}
    for (const name of Object.keys(value)) {
      mapped[name] = transformSchema(value[name], childShaping(value[name], key, shaping))
    }
    return mapped
  }

  // A single subschema (`not`, `if`, `then`, `else`, `contains`, `items`, ...).
  return transformSchema(value, childShaping(value, key, shaping))
}

/**
 * Tells whether the subschema of a keyword shapes the payload.
 *
 * A shared document always shapes it: the copy that is embedded in a schema
 * and the copy of the output pool must be equal, whatever the context of the
 * schema that embeds it is.
 *
 * @param {*} child the subschema
 * @param {string} key the keyword
 * @param {boolean} shaping `false` when the parent does not shape the payload
 * @returns {boolean} `true` when the subschema shapes the payload
 */
function childShaping (child, key, shaping) {
  if (isSharedDocument(child)) {
    return true
  }
  return shaping && !VALIDATION_ONLY_KEYWORDS.has(key)
}

/**
 * Tells whether a subschema is a shared document.
 *
 * A shared document carries an `$id`: it is published through
 * `fastify.addSchema()` and it can be embedded in another schema. The copy
 * that is embedded in a schema and the copy of the output pool must be equal:
 * Ajv refuses a schema that resolves an `$id` to two different schemas
 * ("reference \"...\" resolves to more than one schema"). A shared document is
 * therefore transformed as a standalone document: the context of the schema
 * that embeds it never changes it.
 *
 * @param {*} schema the subschema
 * @returns {boolean} `true` when the subschema is a shared document
 */
function isSharedDocument (schema) {
  return schema !== null &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    schema.$id !== undefined
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
 * Applies the parity rules to a schema.
 *
 * @param {object} schema the copy of the schema
 * @param {boolean} shaping `false` when the schema only takes part in the
 *   validation of the payload and never in its shaping
 */
function applyParityRules (schema, shaping) {
  if (!shaping) {
    // A validation-only subschema: it never shapes the payload.
    return
  }

  if (isCompositionSchema(schema)) {
    applyCompositionRules(schema)
    return
  }

  if (isObjectSchema(schema)) {
    applyObjectRules(schema)
  }
}

/**
 * Tells whether a schema is an object schema.
 *
 * @param {object} schema the schema
 * @returns {boolean} `true` when the schema describes an object
 */
function isObjectSchema (schema) {
  return schema.type === 'object' ||
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.additionalProperties !== undefined
}

/**
 * Tells whether a schema composes other schemas.
 *
 * @param {object} schema the schema
 * @returns {boolean} `true` when the schema merges other schemas
 */
function isCompositionSchema (schema) {
  return Array.isArray(schema.allOf) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf) ||
    (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined))
}

/**
 * Applies the rules of an object schema.
 *
 * @param {object} schema the copy of the schema
 */
function applyObjectRules (schema) {
  if (schema.additionalProperties === undefined) {
    // Rule 1: fjs serialized the declared properties only: every other
    // property of the payload was dropped. The keyword is declared
    // explicitly, so that the validator (with `removeAdditional: true`)
    // removes the extra properties instead of rejecting them.
    schema.additionalProperties = false
  }

  // Rule 2: an `additionalProperties: true` or an `additionalProperties:
  // <schema>` is kept as it is: the validator keeps the additional
  // properties (and validates them against the schema).
}

/**
 * Applies the rules of a composition schema.
 *
 * The fjs merge collects the members of the composition into a single
 * schema: the properties of the members are serialized together. The
 * transform reproduces the merged schema at the top level of the
 * composition, and the members are told not to remove anything, so that they
 * do not strip the properties of the other members.
 *
 * @param {object} schema the copy of the schema
 */
function applyCompositionRules (schema) {
  const branches = collectCompositionBranches(schema)

  // The merged schema keeps the `additionalProperties` of the first member
  // that declares one: `false` (the default of the merged schema) drops the
  // extra properties, `true` keeps them and a schema keeps and validates
  // them.
  let mergedAdditionalProperties = schema.additionalProperties
  for (const branch of branches) {
    if (mergedAdditionalProperties !== undefined) {
      break
    }
    if (!isPlainObject(branch)) {
      continue
    }
    if (branch.additionalProperties !== undefined && branch.additionalProperties !== false) {
      mergedAdditionalProperties = branch.additionalProperties
    }
  }
  schema.additionalProperties = mergedAdditionalProperties === undefined ? false : mergedAdditionalProperties

  // The properties and the property patterns of the members are declared at
  // the top level of the composition, so that the validator keeps them. The
  // hoisted properties are declared without a constraint: the member that
  // owns the property validates it, and hoisting the constraint would
  // strengthen the validation of a `anyOf` or a `oneOf`.
  for (const branch of branches) {
    if (!isPlainObject(branch)) {
      continue
    }
    for (const key of Object.keys(branch.properties || {})) {
      if (schema.properties === undefined) {
        schema.properties = {}
      }
      if (!Object.hasOwn(schema.properties, key)) {
        schema.properties[key] = true
      }
    }
    for (const pattern of Object.keys(branch.patternProperties || {})) {
      if (schema.patternProperties === undefined) {
        schema.patternProperties = {}
      }
      if (!Object.hasOwn(schema.patternProperties, pattern)) {
        schema.patternProperties[pattern] = true
      }
    }
  }

  // The members must not remove anything: the merged schema, declared at the
  // top level of the composition, decides what reaches the wire. A shared
  // document is left alone: it is transformed as a standalone document, so
  // that its embedded copy and the copy of the output pool stay equal.
  for (const branch of branches) {
    if (!isPlainObject(branch)) {
      continue
    }
    if (isSharedDocument(branch)) {
      continue
    }
    if (branch.additionalProperties === false) {
      branch.additionalProperties = true
    }
  }
}

/**
 * Collects the members of a composition schema.
 *
 * @param {object} schema the schema
 * @returns {Array} the members of the composition
 */
function collectCompositionBranches (schema) {
  if (Array.isArray(schema.allOf)) {
    return schema.allOf
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
  }
  const branches = []
  if (schema.then !== undefined) {
    branches.push(schema.then)
  }
  if (schema.else !== undefined) {
    branches.push(schema.else)
  }
  return branches
}

/**
 * Tells whether a value is a plain object.
 *
 * @param {*} value the value
 * @returns {boolean} `true` when the value is a non-null object
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  applyFjsObjectParity,
  PARITY_RECURSION_KEYWORDS
}
