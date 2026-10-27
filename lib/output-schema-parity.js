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
 *   members;
 * - rule 4: a member of a composition that **references** another schema (a
 *   `$ref`) is resolved before the merge: the referenced schema is copied
 *   into the composition, so that the merge knows the properties it declares
 *   and so that the copy does not remove the properties of the other
 *   members. A reference that cannot be resolved is **left in the schema**:
 *   the parity layer never drops a reference, because dropping it would
 *   weaken the validation of the payload. The validator cannot resolve it
 *   either, so such a schema does not compile: the route answers a
 *   `FST_ERR_SCH_SERIALIZATION_BUILD` error and the server does not start.
 *   The composition is nevertheless left without an `additionalProperties`,
 *   as a defensive measure: a reference that the validator resolves and the
 *   parity layer does not must never remove a property that the parity layer
 *   cannot prove to be extra.
 *
 * The rules are applied recursively: the subschemas reachable through the
 * keywords of `PARITY_RECURSION_KEYWORDS` are transformed as well. The
 * subschemas of `VALIDATION_ONLY_KEYWORDS` are transformed for their
 * validation only: `fast-json-stringify` ignores them, so they must not
 * remove anything from the payload.
 *
 * A `$ref` is not followed outside of a composition: the referenced document
 * is transformed where it is defined, in the copy of the external schemas
 * that is seeded into the output pool. Inside a composition, the reference is
 * resolved, because the merge of the composition needs the properties of the
 * member (rule 4).
 */

/**
 * The keywords whose value is a map of subschemas (a name → a schema) whose
 * entries are merged, and never replaced, when the keywords that a member of
 * a composition carries next to its reference are kept.
 */
const SIBLING_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties'
])

/**
 * The keywords whose value is a map of subschemas that may declare an
 * identifier of their own.
 *
 * The copy of a referenced schema replaces the member of the composition, and
 * it lives in the scope of the document that embeds the composition: an
 * entry that declares an identifier (`$id`) the scope declares more than once
 * would declare that identifier a second time, and Ajv refuses a schema that
 * resolves an identifier to two different schemas ("reference \"...\" resolves
 * to more than one schema"). The other entries are merged, like the maps of
 * the properties.
 */
const SIBLING_IDENTIFIER_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas'
])

/**
 * The pattern of an identifier that carries an authority: the scheme, the
 * `//` that follows it, and the authority itself.
 */
const AUTHORITY_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/?#]*/

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
 * @param {object} [options] the options of the transform
 * @param {object} [options.sharedDocuments] the shared documents of the
 *   output side, by identifier: a composition whose member references a
 *   shared document resolves it through this index
 * @returns {object|boolean} a deep copy of the schema with the parity rules
 *   applied
 */
function applyFjsObjectParity (schema, options) {
  const context = {
    root: schema,
    shared: buildSharedIndex(options && options.sharedDocuments),
    resolving: new Set(),
    incomplete: new Set(),
    identifiers: countIdentifiers(schema)
  }
  return transformSchema(schema, true, context)
}

/**
 * Transforms a schema and its subschemas.
 *
 * @param {object|boolean} schema the schema to transform
 * @param {boolean} shaping `false` when the schema only takes part in the
 *   validation of the payload and never in its shaping
 * @param {object} context the context of the transform
 * @returns {object|boolean} the transformed schema
 */
function transformSchema (schema, shaping, context) {
  if (Array.isArray(schema)) {
    // A list of subschemas (`allOf`, `anyOf`, `oneOf`, `prefixItems`, ...).
    return schema.map(item => transformSchema(item, shaping, context))
  }

  if (schema === null || typeof schema !== 'object') {
    // A boolean schema or a scalar: the rules never touch it.
    return schema
  }

  // A schema that carries an identifier opens a scope: the references that
  // are local to it are resolved against it, not against the document that
  // embeds it.
  const scope = scopeContext(schema, context)

  const copy = {}
  for (const key of Object.keys(schema)) {
    copy[key] = transformKeyword(key, schema[key], shaping, scope)
  }

  applyParityRules(copy, shaping, scope)

  return copy
}

/**
 * Computes the context of the subschemas of a schema.
 *
 * A schema that carries an `$id` is the root of a scope: a local reference
 * (`#/...`) is resolved against it. The context of the scope is used by the
 * resolution of the members of a composition.
 *
 * @param {object} schema the schema
 * @param {object} context the context of the parent
 * @returns {object} the context of the subschemas of the schema
 */
function scopeContext (schema, context) {
  if (typeof schema.$id !== 'string') {
    return context
  }
  return {
    root: schema,
    shared: context.shared,
    resolving: context.resolving,
    incomplete: context.incomplete,
    identifiers: countIdentifiers(schema)
  }
}

/**
 * Transforms the value of a keyword of a schema.
 *
 * @param {string} key the keyword
 * @param {*} value the value of the keyword
 * @param {boolean} shaping `false` when the subschema of the keyword only
 *   takes part in the validation of the payload
 * @param {object} context the context of the transform
 * @returns {*} the transformed value
 */
function transformKeyword (key, value, shaping, context) {
  if (!PARITY_RECURSION_KEYWORDS.includes(key)) {
    return deepCopy(value)
  }

  if (Array.isArray(value)) {
    // A list of subschemas (`items` as a tuple, `prefixItems`, `allOf`, ...).
    return value.map(item => transformSchema(item, childShaping(item, key, shaping), context))
  }

  if (PARITY_MAP_KEYWORDS.has(key)) {
    if (value === null || typeof value !== 'object') {
      return value
    }
    const mapped = {}
    for (const name of Object.keys(value)) {
      mapped[name] = transformSchema(value[name], childShaping(value[name], key, shaping), context)
    }
    return mapped
  }

  // A single subschema (`not`, `if`, `then`, `else`, `contains`, `items`, ...).
  return transformSchema(value, childShaping(value, key, shaping), context)
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
 * @param {object} context the context of the transform
 */
function applyParityRules (schema, shaping, context) {
  if (!shaping) {
    // A validation-only subschema: it never shapes the payload.
    return
  }

  if (isCompositionSchema(schema)) {
    applyCompositionRules(schema, context)
    return
  }

  if (isObjectSchema(schema)) {
    applyObjectRules(schema)
  }
}

/**
 * Tells whether a schema is an object schema.
 *
 * A schema that describes an object is an object schema, even when it does
 * not declare the `object` type: a union type (`type: ['object', 'null']`,
 * the shape a nullable response object takes) and the keywords that only
 * make sense for an object (`required`, `minProperties`, ...) describe an
 * object too.
 *
 * The keywords are the ones `fast-json-stringify` uses to recognize an
 * object: `propertyNames` is not one of them (`fast-json-stringify` ignores
 * it), so a schema that declares only `propertyNames` does not describe an
 * object and must not strip the properties of the payload. `dependencies` is
 * one of them: a schema that declares only `dependencies` describes an
 * object and strips the properties of the payload, exactly as
 * `fast-json-stringify` does.
 *
 * @param {object} schema the schema
 * @returns {boolean} `true` when the schema describes an object
 */
function isObjectSchema (schema) {
  const type = schema.type
  const isObjectType = type === 'object' ||
    (Array.isArray(type) && type.includes('object'))
  return isObjectType ||
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.minProperties !== undefined ||
    schema.maxProperties !== undefined ||
    schema.required !== undefined ||
    schema.dependencies !== undefined
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
  // <schema>` is kept as it is: the validator keeps (and, for a schema,
  // validates) the additional properties.
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
 * A member that references another schema is resolved (rule 4): the
 * referenced schema is copied into the composition, so that the merge knows
 * the properties it declares and so that the copy does not remove the
 * properties of the other members.
 *
 * @param {object} schema the copy of the schema
 * @param {object} context the context of the transform
 */
function applyCompositionRules (schema, context) {
  const composition = collectCompositionBranches(schema)
  const members = []
  let complete = true

  for (let index = 0; index < composition.list.length; index++) {
    const member = composition.list[index]
    const referenced = resolveMember(member, context)

    if (referenced === null) {
      // The member does not reference another schema: it is used as it is.
      members.push({
        schema: member,
        additionalProperties: isPlainObject(member) ? member.additionalProperties : undefined
      })
      continue
    }

    if (referenced.member === null) {
      // The reference cannot be resolved: it is left in the schema (the
      // parity layer never drops a reference, because dropping it would
      // weaken the validation of the payload), so the validator cannot
      // compile the schema. The merge does not know the properties of the
      // member either, so the composition must not remove anything.
      complete = false
      members.push({ schema: member, additionalProperties: undefined })
      continue
    }

    if (context.incomplete.has(referenced.member)) {
      // The referenced schema is a composition that does not know every
      // property either: the merge of this composition does not know them
      // either.
      complete = false
    }

    composition.replace(index, referenced.member)
    members.push({
      schema: referenced.member,
      additionalProperties: referenced.additionalProperties
    })
  }

  // The merged schema keeps the `additionalProperties` of the first member
  // that declares one: `false` (the default of the merged schema) drops the
  // extra properties, `true` keeps them and a schema keeps and validates
  // them.
  let mergedAdditionalProperties = schema.additionalProperties
  for (const member of members) {
    if (mergedAdditionalProperties !== undefined) {
      break
    }
    if (member.additionalProperties !== undefined && member.additionalProperties !== false) {
      mergedAdditionalProperties = member.additionalProperties
    }
  }

  if (complete) {
    schema.additionalProperties = mergedAdditionalProperties === undefined ? false : mergedAdditionalProperties
  } else {
    // The composition does not know every property: it declares no
    // `additionalProperties`, so that it removes nothing. The parity layer
    // never destroys the data: a property it cannot prove to be extra is
    // kept. A composition that reaches this branch carries a reference that
    // cannot be resolved, so the schema does not compile and no body is ever
    // sent: the guarantee that the body is never a subset of the fjs body
    // holds because there is no body at all.
    delete schema.additionalProperties
    context.incomplete.add(schema)
  }

  // The properties and the property patterns of the members are declared at
  // the top level of the composition, so that the validator keeps them. The
  // hoisted properties are declared without a constraint: the member that
  // owns the property validates it, and hoisting the constraint would
  // strengthen the validation of a `anyOf` or a `oneOf`.
  for (const member of members) {
    if (!isPlainObject(member.schema)) {
      continue
    }
    for (const key of Object.keys(member.schema.properties || {})) {
      if (schema.properties === undefined) {
        schema.properties = {}
      }
      if (!Object.hasOwn(schema.properties, key)) {
        schema.properties[key] = true
      }
    }
    for (const pattern of Object.keys(member.schema.patternProperties || {})) {
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
  // document that is published through `fastify.addSchema()` is left alone
  // when it could not be resolved: its copy in the pool of the output side
  // must stay equal to this copy, or the validator refuses the schema.
  for (const member of members) {
    if (!isPlainObject(member.schema)) {
      continue
    }
    if (isSharedDocument(member.schema) && context.shared[member.schema.$id] !== undefined) {
      continue
    }
    if (member.schema.additionalProperties === false) {
      member.schema.additionalProperties = true
    }
  }
}

/**
 * Resolves the member of a composition that references another schema.
 *
 * @param {*} member the member of the composition
 * @param {object} context the context of the transform
 * @returns {object|null} `null` when the member does not reference another
 *   schema, the resolution of the member otherwise. The resolution carries a
 *   `null` member when the reference cannot be resolved.
 */
function resolveMember (member, context) {
  if (!isPlainObject(member)) {
    return null
  }

  let reference = null
  if (typeof member.$ref === 'string') {
    reference = member.$ref
  } else if (typeof member.$id === 'string' && context.shared[member.$id] !== undefined) {
    // A shared document that is embedded in the composition: the copy of the
    // output pool is the same document, and it is resolved like a reference.
    reference = member.$id
  }

  if (reference === null) {
    return null
  }

  if (context.resolving.has(reference)) {
    // A circular reference: the member is left as it is.
    return { member: null }
  }

  const resolution = resolveReference(reference, context)
  if (resolution === null) {
    return { member: null }
  }

  context.resolving.add(reference)
  const copy = buildReferencedMember(resolution, context, member)
  context.resolving.delete(reference)

  return copy
}

/**
 * Resolves a reference.
 *
 * A local reference (`#/...`) is resolved against the document that is being
 * transformed, an external reference against the shared documents of the
 * output side.
 *
 * @param {string} reference the reference
 * @param {object} context the context of the transform
 * @returns {object|null} the resolution of the reference, `null` when it
 *   cannot be resolved
 */
function resolveReference (reference, context) {
  const hash = reference.indexOf('#')

  if (hash === 0) {
    const segments = parsePointer(reference.slice(1))
    if (segments === null) {
      return null
    }
    const target = navigate(context.root, segments)
    if (!isPlainObject(target)) {
      return null
    }
    return {
      schema: target,
      document: context.root,
      local: true,
      base: '',
      pointer: formatPointer(segments)
    }
  }

  const id = hash === -1 ? reference : reference.slice(0, hash)
  const pointer = hash === -1 ? '' : reference.slice(hash + 1)
  const document = context.shared[id]
  if (document === undefined) {
    return null
  }
  const segments = parsePointer(pointer)
  if (segments === null) {
    return null
  }
  const target = navigate(document, segments)
  if (!isPlainObject(target)) {
    return null
  }
  return { schema: target, document, local: false, base: id }
}

/**
 * Builds the copy of a referenced schema that becomes a member of a
 * composition.
 *
 * The copy keeps the constraints of the referenced schema (the member still
 * validates the payload) but it never removes anything: the merged schema of
 * the composition decides what reaches the wire. The keywords that the
 * member carries next to its reference are kept: a reference does not
 * replace them.
 *
 * @param {object} resolution the resolution of the reference
 * @param {object} context the context of the transform
 * @param {object} sibling the member of the composition that carries the
 *   reference
 * @returns {object} the copy of the referenced schema
 */
function buildReferencedMember (resolution, context, sibling) {
  const member = transformSchema(resolution.schema, true, {
    root: resolution.document,
    shared: context.shared,
    resolving: context.resolving,
    incomplete: context.incomplete,
    identifiers: countIdentifiers(resolution.document)
  })

  if (resolution.local) {
    // The copy of a local definition is embedded in the scope of the
    // document that holds the composition: the identifier of the definition
    // belongs to the original definition only, or it would be declared
    // twice. The references of the copy are rewritten, so that they resolve
    // to the same subschemas as the references of the definition.
    rebaseLocalReferences(member, {
      pointer: resolution.pointer,
      path: '',
      scopePath: null,
      scopeId: null
    })
  } else {
    // The copy of a shared document must not carry the identifier of the
    // document: the document is registered once, in the pool of the output
    // side, and Ajv refuses a schema that resolves an identifier to two
    // different schemas. The references that are local to the document are
    // rebased, so that they still resolve to the same schema.
    rebaseReferences(member, resolution.base)
  }

  // The keywords that the member carries next to its reference are kept.
  mergeSiblingKeywords(member, sibling, context.identifiers)

  const additionalProperties = member.additionalProperties

  // The member must not remove anything: the merged schema of the composition
  // decides what reaches the wire.
  if (member.additionalProperties !== undefined) {
    member.additionalProperties = true
  }

  return { member, additionalProperties }
}

/**
 * Merges the keywords that a member of a composition carries next to its
 * reference into the copy of the referenced schema.
 *
 * A reference does not replace the keywords that the member carries next to
 * it (`{$ref: '#/$defs/base', description: '...'}`): they are kept. The
 * copy of the referenced schema wins for the keywords it declares, so that
 * no constraint of the referenced schema is lost, and the maps of the
 * properties are merged, so that no property is lost either.
 *
 * The containers that hold the resources of a scope (`$defs`, `definitions`,
 * `dependentSchemas`) are merged as well, but the entries that declare an
 * identifier the scope declares more than once are left out: the copy of the
 * member lives in the scope of the document that embeds the composition, and
 * the identifier would be declared twice (`SIBLING_IDENTIFIER_MAP_KEYWORDS`).
 *
 * @param {object} copy the copy of the referenced schema
 * @param {object} member the member of the composition
 * @param {object} identifiers the identifiers the scope of the copy declares,
 *   by identifier
 */
function mergeSiblingKeywords (copy, member, identifiers) {
  for (const key of Object.keys(member)) {
    if (key === '$ref' || key === '$id') {
      // The reference itself and the identifier of the member are not
      // keywords of the referenced schema.
      continue
    }

    if (SIBLING_MAP_KEYWORDS.has(key)) {
      const map = isPlainObject(copy[key]) ? { ...copy[key] } : {}
      for (const name of Object.keys(member[key] || {})) {
        if (!Object.hasOwn(map, name)) {
          map[name] = member[key][name]
        }
      }
      copy[key] = map
      continue
    }

    if (SIBLING_IDENTIFIER_MAP_KEYWORDS.has(key)) {
      // The container holds the resources of a scope: an entry that declares
      // an identifier the scope declares more than once is not copied into
      // the copy, because the copy would declare that identifier a second
      // time (see `SIBLING_IDENTIFIER_MAP_KEYWORDS`). The other entries are
      // merged, like the maps of the properties: the copy of the referenced
      // schema wins for an entry it already declares.
      const map = isPlainObject(copy[key]) ? { ...copy[key] } : {}
      for (const name of Object.keys(member[key] || {})) {
        if (Object.hasOwn(map, name)) {
          continue
        }
        if (declaresDuplicatedIdentifier(member[key][name], identifiers)) {
          continue
        }
        map[name] = member[key][name]
      }
      if (Object.keys(map).length > 0) {
        copy[key] = map
      }
      continue
    }

    if (copy[key] === undefined) {
      copy[key] = member[key]
    }
  }
}

/**
 * Counts the identifiers that a document declares.
 *
 * An identifier must be declared once in a scope: the validator refuses a
 * schema that resolves an identifier to two different schemas ("reference
 * \"...\" resolves to more than one schema"). The identifiers of a document
 * are counted, so that the declarations the parity layer copies can be
 * compared with the declarations of the scope they are copied into.
 *
 * @param {*} document the document
 * @returns {object} the number of declarations, by identifier
 */
function countIdentifiers (document) {
  const identifiers = Object.create(null)
  collectDocumentIdentifiers(document, identifiers)
  return identifiers
}

/**
 * Collects the identifiers that a document declares.
 *
 * @param {*} node the node of the document
 * @param {object} identifiers the number of declarations, by identifier
 */
function collectDocumentIdentifiers (node, identifiers) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectDocumentIdentifiers(item, identifiers)
    }
    return
  }

  if (!isPlainObject(node)) {
    return
  }

  if (typeof node.$id === 'string') {
    identifiers[node.$id] = (identifiers[node.$id] || 0) + 1
  }

  for (const key of Object.keys(node)) {
    collectDocumentIdentifiers(node[key], identifiers)
  }
}

/**
 * Tells whether a subschema declares an identifier that the scope declares
 * more than once.
 *
 * A subschema that carries an identifier (`$id`) declares a resource of the
 * scope of the document that holds it: the identifier must be declared once
 * in a scope, or the validator refuses the schema. The identifier of a
 * nested subschema declares a resource too, so the whole subschema is
 * walked.
 *
 * @param {*} node the subschema
 * @param {object} identifiers the identifiers the scope declares, by
 *   identifier
 * @returns {boolean} `true` when the subschema declares an identifier that
 *   the scope declares more than once
 */
function declaresDuplicatedIdentifier (node, identifiers) {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (declaresDuplicatedIdentifier(item, identifiers)) {
        return true
      }
    }
    return false
  }

  if (!isPlainObject(node)) {
    return false
  }

  if (typeof node.$id === 'string' && identifiers[node.$id] > 1) {
    return true
  }

  for (const key of Object.keys(node)) {
    if (declaresDuplicatedIdentifier(node[key], identifiers)) {
      return true
    }
  }

  return false
}

/**
 * Rebases the references of a copy of a shared document.
 *
 * The copy lives in another document: a reference that is local to the
 * source document (`#/...`) becomes a reference of the source document
 * (`<id>#/...`), a relative reference (`other`) is resolved against the base
 * of the source document (the JSON Schema resolution rules), and the
 * identifiers of the copy are removed.
 *
 * @param {*} node the copy
 * @param {string} base the identifier of the document the copy comes from
 */
function rebaseReferences (node, base) {
  if (Array.isArray(node)) {
    for (const item of node) {
      rebaseReferences(item, base)
    }
    return
  }

  if (!isPlainObject(node)) {
    return
  }

  let currentBase = base
  if (typeof node.$id === 'string') {
    // The identifier of the document itself is the base of its own
    // references: it is not resolved against itself. The identifier of a
    // nested subschema is resolved against the base of its parent.
    currentBase = node.$id === base ? base : resolveUri(base, node.$id)
    delete node.$id
  }

  if (typeof node.$ref === 'string') {
    node.$ref = rebaseReference(node.$ref, currentBase)
  }

  for (const key of Object.keys(node)) {
    rebaseReferences(node[key], currentBase)
  }
}

/**
 * Rebases a reference against the base identifier of a document.
 *
 * A reference that is local to its document (`#/...`) becomes a reference of
 * the document (`<id>#/...`); a relative reference (`other`) is resolved
 * against the base of the document, exactly like the JSON Schema resolution
 * rules do (`<id>` → `<dir>/other`); an absolute reference is left alone: it
 * resolves to the same document wherever it is written.
 *
 * @param {string} reference the reference
 * @param {string} base the base identifier of the document
 * @returns {string} the rebased reference
 */
function rebaseReference (reference, base) {
  if (reference.startsWith('#')) {
    return base + reference
  }

  if (isAbsoluteUri(reference)) {
    return reference
  }

  const hash = reference.indexOf('#')
  const path = hash === -1 ? reference : reference.slice(0, hash)
  const fragment = hash === -1 ? '' : reference.slice(hash)

  return resolveUri(base, path) + fragment
}

/**
 * Rebases the references of the copy of a local definition.
 *
 * The copy of a local definition is embedded in the scope of the document
 * that holds the composition: the identifier of the definition belongs to the
 * original definition only (the copy would declare it a second time, and the
 * validator refuses a schema that resolves an identifier to two different
 * schemas).
 *
 * The references of the copy are resolved like the references of the
 * definition:
 *
 * - a pointer (`#/…`) is rewritten to the pointer path of the definition in
 *   the root document: the copy lives in another scope, and the pointer
 *   would otherwise resolve against the root document and point at the wrong
 *   subschema;
 * - a relative reference is resolved against the identifier of the scope the
 *   definition opens, when the definition opens one;
 * - an absolute reference is left alone: it resolves to the same document
 *   wherever it is written.
 *
 * @param {*} node the copy
 * @param {object} context the context of the copy
 * @param {string} context.pointer the pointer path of the definition in the
 *   root document
 * @param {string} context.path the pointer path of the node in the copy
 * @param {string|null} context.scopePath the pointer path of the scope the
 *   node belongs to, `null` when the definition opens no scope
 * @param {string|null} context.scopeId the identifier of the scope the node
 *   belongs to, `null` when the definition opens no scope
 */
function rebaseLocalReferences (node, context) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      rebaseLocalReferences(node[index], {
        pointer: context.pointer,
        path: context.path + '/' + index,
        scopePath: context.scopePath,
        scopeId: context.scopeId
      })
    }
    return
  }

  if (!isPlainObject(node)) {
    return
  }

  let scopePath = context.scopePath
  let scopeId = context.scopeId

  if (typeof node.$id === 'string') {
    // The identifier belongs to the original definition: the copy is
    // embedded in the scope of the document that holds the composition, and
    // the identifier would be declared twice.
    scopePath = context.path
    scopeId = node.$id
    delete node.$id
  }

  if (typeof node.$ref === 'string') {
    node.$ref = rebaseLocalReference(node.$ref, context.pointer, scopePath, scopeId)
  }

  for (const key of Object.keys(node)) {
    rebaseLocalReferences(node[key], {
      pointer: context.pointer,
      path: context.path + '/' + key,
      scopePath,
      scopeId
    })
  }
}

/**
 * Rebases a reference of the copy of a local definition.
 *
 * @param {string} reference the reference
 * @param {string} pointer the pointer path of the definition in the root
 *   document
 * @param {string|null} scopePath the pointer path of the scope the reference
 *   belongs to, `null` when the definition opens no scope
 * @param {string|null} scopeId the identifier of the scope the reference
 *   belongs to, `null` when the definition opens no scope
 * @returns {string} the rebased reference
 */
function rebaseLocalReference (reference, pointer, scopePath, scopeId) {
  if (scopeId === null) {
    // The definition opens no scope: the copy lives in the scope of the
    // definition, and the references resolve against the same scope.
    return reference
  }

  if (reference.startsWith('#')) {
    // A pointer: it resolves against the scope of the definition, whose
    // location in the root document is known.
    return '#' + pointer + scopePath + reference.slice(1)
  }

  if (isAbsoluteUri(reference)) {
    // An absolute reference: it resolves to the same document wherever it
    // is written.
    return reference
  }

  // A relative reference: it resolves against the identifier of the scope.
  return resolveUri(scopeId, reference)
}

/**
 * Formats the segments of a JSON pointer as a pointer path.
 *
 * @param {Array} segments the segments of the pointer
 * @returns {string} the pointer path
 */
function formatPointer (segments) {
  return segments
    .map(segment => '/' + segment.replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('')
}

/**
 * Tells whether an identifier is an absolute URI.
 *
 * An absolute URI carries a scheme (`http:`, `urn:`, ...): it resolves to the
 * same document wherever it is written.
 *
 * @param {string} uri the identifier
 * @returns {boolean} `true` when the identifier is an absolute URI
 */
function isAbsoluteUri (uri) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)
}

/**
 * Resolves an identifier against a base identifier.
 *
 * The resolution follows the rules of RFC 3986, through the URL parser of
 * Node: a relative identifier is resolved against the *directory* of the base
 * (the part of the path of the base that precedes its last `/`), a root
 * relative identifier (`/other`) against the **root** of the authority of the
 * base, and the dot segments of the identifier are removed.
 *
 * A base that carries an authority but no path (`http://fastify.test`)
 * resolves the identifier against the root of that authority
 * (`http://fastify.test/other`): the authority of the base is never replaced,
 * so a resolved identifier can never point at another host than the base.
 *
 * A base that the URL parser cannot resolve (a non-hierarchical base such as
 * `urn:…`, or a relative base) merges the identifier with the path of the
 * base, exactly like the rules of RFC 3986 do: the identifier keeps its own
 * form, so that a relative base keeps resolving the identifiers it declares
 * and a reference against a base that cannot be resolved stays unresolvable.
 *
 * @param {string} base the base identifier
 * @param {string} identifier the identifier
 * @returns {string} the resolved identifier
 */
function resolveUri (base, identifier) {
  if (isAbsoluteUri(identifier)) {
    // An absolute identifier: it resolves to the same document wherever it
    // is written.
    return identifier
  }

  if (identifier === '') {
    // An empty identifier resolves to the base itself: the URL parser would
    // append a trailing slash to an authority that carries no path, and the
    // identifier would no longer be the one that is registered.
    return base
  }

  if (identifier.startsWith('//')) {
    // A network path reference: the authority of the base is never replaced
    // (see the known limitations of the module), so the reference is
    // resolved against the root of the authority of the base.
    const authority = authorityPrefix(base)
    return authority === null ? identifier : authority + '/' + identifier
  }

  try {
    // The URL parser of Node follows the rules of RFC 3986.
    return new URL(identifier, base).href
  } catch {
    // The base is not one the URL parser can resolve: a non-hierarchical
    // base (`urn:…`) or a relative base.
    return mergeUri(base, identifier)
  }
}

/**
 * Merges an identifier with the path of a base that the URL parser cannot
 * resolve.
 *
 * The merge follows the rules of RFC 3986: the identifier replaces the last
 * segment of the path of the base. A base that carries no path keeps the
 * identifier as it is: the reference stays relative, and therefore
 * unresolvable.
 *
 * @param {string} base the base identifier
 * @param {string} identifier the identifier
 * @returns {string} the merged identifier
 */
function mergeUri (base, identifier) {
  const path = base.split('#')[0].split('?')[0]
  const slash = path.lastIndexOf('/')

  if (slash === -1) {
    // The base carries no path: the identifier is kept as it is.
    return identifier
  }

  return path.slice(0, slash + 1) + identifier
}

/**
 * Locates the scheme and the authority of an identifier.
 *
 * The scheme and the authority of an identifier that carries one: the
 * scheme, the `//` that follows it, and the host (and the port) itself.
 *
 * @param {string} base the identifier
 * @returns {string|null} the scheme and the authority of the identifier,
 *   `null` when the identifier carries none
 */
function authorityPrefix (base) {
  const match = AUTHORITY_PATTERN.exec(base)
  return match === null ? null : match[0]
}

/**
 * Builds the index of the shared documents.
 *
 * The index holds the documents by identifier, and the nested identifiers
 * too: a reference can point to a subschema that carries its own `$id`.
 *
 * @param {object} documents the shared documents, by identifier
 * @returns {object} the index
 */
function buildSharedIndex (documents) {
  const index = {}
  if (documents === null || typeof documents !== 'object') {
    return index
  }
  for (const id of Object.keys(documents)) {
    index[id] = documents[id]
    collectIdentifiers(documents[id], id, index)
  }
  return index
}

/**
 * Collects the nested identifiers of a shared document.
 *
 * @param {*} document the document
 * @param {string} base the identifier of the document
 * @param {object} index the index of the shared documents
 */
function collectIdentifiers (document, base, index) {
  if (Array.isArray(document)) {
    for (const item of document) {
      collectIdentifiers(item, base, index)
    }
    return
  }

  if (!isPlainObject(document)) {
    return
  }

  let currentBase = base
  if (typeof document.$id === 'string') {
    currentBase = resolveUri(base, document.$id)
    if (index[currentBase] === undefined) {
      index[currentBase] = document
    }
  }

  for (const key of Object.keys(document)) {
    collectIdentifiers(document[key], currentBase, index)
  }
}

/**
 * Parses a JSON pointer.
 *
 * @param {string} pointer the pointer
 * @returns {Array|null} the segments of the pointer, `null` when the pointer
 *   is malformed
 */
function parsePointer (pointer) {
  if (pointer === '') {
    return []
  }
  if (!pointer.startsWith('/')) {
    return null
  }
  return pointer
    .slice(1)
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/**
 * Navigates a document with the segments of a JSON pointer.
 *
 * @param {*} document the document
 * @param {Array} segments the segments of the pointer
 * @returns {*} the target of the pointer, `undefined` when it does not exist
 */
function navigate (document, segments) {
  let current = document
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = current[segment]
    if (current === undefined) {
      return undefined
    }
  }
  return current
}

/**
 * Collects the members of a composition schema.
 *
 * @param {object} schema the schema
 * @returns {object} the members of the composition and the function that
 *   replaces one of them
 */
function collectCompositionBranches (schema) {
  if (Array.isArray(schema.allOf)) {
    return {
      list: schema.allOf,
      replace: (index, member) => { schema.allOf[index] = member }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    return {
      list: schema.anyOf,
      replace: (index, member) => { schema.anyOf[index] = member }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    return {
      list: schema.oneOf,
      replace: (index, member) => { schema.oneOf[index] = member }
    }
  }
  const list = []
  const keys = []
  if (schema.then !== undefined) {
    list.push(schema.then)
    keys.push('then')
  }
  if (schema.else !== undefined) {
    list.push(schema.else)
    keys.push('else')
  }
  return {
    list,
    replace: (index, member) => {
      schema[keys[index]] = member
    }
  }
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
