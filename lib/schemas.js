'use strict'

const fastClone = require('rfdc')({ circles: false, proto: true })
const { kSchemaVisited, kSchemaResponse } = require('./symbols')
const kFluentSchema = Symbol.for('fluent-schema-object')

const {
  FST_ERR_SCH_MISSING_ID,
  FST_ERR_SCH_ALREADY_PRESENT,
  FST_ERR_SCH_DUPLICATE,
  FST_ERR_SCH_CONTENT_MISSING_SCHEMA,
  FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN
} = require('./errors')
const ContentType = require('./content-type')

const SCHEMAS_SOURCE = ['params', 'body', 'querystring', 'query', 'headers']

function Schemas (initStore) {
  this.store = initStore || {}
}

Schemas.prototype.add = function (inputSchema) {
  const schema = fastClone((inputSchema.isFluentSchema || inputSchema.isFluentJSONSchema || inputSchema[kFluentSchema])
    ? inputSchema.valueOf()
    : inputSchema
  )

  // developers can add schemas without $id, but with $def instead
  const id = schema.$id
  if (!id) {
    throw new FST_ERR_SCH_MISSING_ID()
  }

  if (this.store[id]) {
    throw new FST_ERR_SCH_ALREADY_PRESENT(id)
  }

  this.store[id] = schema
}

Schemas.prototype.getSchemas = function () {
  return Object.assign({}, this.store)
}

Schemas.prototype.getSchema = function (schemaId) {
  return this.store[schemaId]
}

/**
 * Checks whether a schema is a non-plain object.
 *
 * @param {*} schema the schema to check
 * @returns {boolean} true if schema has a custom prototype
 */
function isCustomSchemaPrototype (schema) {
  return typeof schema === 'object' && Object.getPrototypeOf(schema) !== Object.prototype
}

function normalizeSchema (routeSchemas, serverOptions) {
  if (routeSchemas[kSchemaVisited]) {
    return routeSchemas
  }

  // alias query to querystring schema
  // A JSON Schema boolean (`false` or `true`) is a valid schema and must still
  // be aliased, so presence is determined from an explicit `undefined` check
  // rather than truthiness.
  if (routeSchemas.query !== undefined) {
    // check if our schema has both querystring and query
    if (routeSchemas.querystring !== undefined) {
      throw new FST_ERR_SCH_DUPLICATE('querystring')
    }
    routeSchemas.querystring = routeSchemas.query
  }

  generateFluentSchema(routeSchemas)

  for (const key of SCHEMAS_SOURCE) {
    const schema = routeSchemas[key]
    if (schema && !isCustomSchemaPrototype(schema)) {
      if (key === 'body' && schema.content) {
        const contentProperty = schema.content
        const keys = Object.keys(contentProperty)
        for (let i = 0; i < keys.length; i++) {
          const contentType = keys[i]
          const contentSchema = contentProperty[contentType].schema
          if (!contentSchema) {
            throw new FST_ERR_SCH_CONTENT_MISSING_SCHEMA(contentType)
          }
        }
        continue
      }
    }
  }

  if (routeSchemas.response) {
    const httpCodes = Object.keys(routeSchemas.response)
    for (const code of httpCodes) {
      if (isCustomSchemaPrototype(routeSchemas.response[code])) {
        continue
      }

      const contentProperty = routeSchemas.response[code].content

      if (contentProperty) {
        const keys = Object.keys(contentProperty)
        for (let i = 0; i < keys.length; i++) {
          const mediaName = keys[i]
          if (!contentProperty[mediaName].schema) {
            throw new FST_ERR_SCH_CONTENT_MISSING_SCHEMA(mediaName)
          }
        }
      }
    }
  }

  routeSchemas[kSchemaVisited] = true
  return routeSchemas
}

function generateFluentSchema (schema) {
  for (const key of SCHEMAS_SOURCE) {
    if (schema[key] && (schema[key].isFluentSchema || schema[key][kFluentSchema])) {
      schema[key] = schema[key].valueOf()
    }
  }

  if (schema.response) {
    const httpCodes = Object.keys(schema.response)
    for (const code of httpCodes) {
      if (schema.response[code].isFluentSchema || schema.response[code][kFluentSchema]) {
        schema.response[code] = schema.response[code].valueOf()
      }
    }
  }
}

/**
 * Search for the right JSON schema compiled function in the request context
 * setup by the route configuration `schema.response`.
 * It will look for the exact match (eg 200) or generic (eg 2xx)
 *
 * @param {object} context the request context
 * @param {number} statusCode the http status code
 * @param {string} [contentType] the reply content type
 * @returns {function|false} the right JSON Schema function to serialize
 * the reply or false if it is not set
 */
function getSchemaSerializer (context, statusCode, contentType) {
  const responseSchemaDef = context[kSchemaResponse]
  if (!responseSchemaDef) {
    return false
  }
  if (responseSchemaDef[statusCode]) {
    if (responseSchemaDef[statusCode].constructor === Object) {
      const ct = ContentType.from(contentType)
      if (ct.isValid) {
        if (responseSchemaDef[statusCode][ct.mediaType]) {
          return responseSchemaDef[statusCode][ct.mediaType]
        }

        // fallback to match all media-type
        if (responseSchemaDef[statusCode]['*/*']) {
          return responseSchemaDef[statusCode]['*/*']
        }

        return false
      }
    }
    return responseSchemaDef[statusCode]
  }
  const fallbackStatusCode = (statusCode + '')[0] + 'xx'
  if (responseSchemaDef[fallbackStatusCode]) {
    if (responseSchemaDef[fallbackStatusCode].constructor === Object) {
      const ct = ContentType.from(contentType)
      if (ct.isValid) {
        if (responseSchemaDef[fallbackStatusCode][ct.mediaType]) {
          return responseSchemaDef[fallbackStatusCode][ct.mediaType]
        }

        // fallback to match all media-type
        if (responseSchemaDef[fallbackStatusCode]['*/*']) {
          return responseSchemaDef[fallbackStatusCode]['*/*']
        }

        return false
      }
    }

    return responseSchemaDef[fallbackStatusCode]
  }
  if (responseSchemaDef.default) {
    if (responseSchemaDef.default.constructor === Object) {
      const ct = ContentType.from(contentType)
      if (ct.isValid) {
        if (responseSchemaDef.default[ct.mediaType]) {
          return responseSchemaDef.default[ct.mediaType]
        }

        // fallback to match all media-type
        if (responseSchemaDef.default['*/*']) {
          return responseSchemaDef.default['*/*']
        }

        return false
      }
    }

    return responseSchemaDef.default
  }
  return false
}

/**
 * Search for the entry of a response schema bucket that applies to a reply.
 *
 * The lookup is schema agnostic: the bucket it looks into is selected with the
 * `symbol` option, so the very same logic serves the `fast-json-stringify`
 * serializers and the compiled output validators.
 *
 * The status code is matched leniently: the exact code first, then the `NXX`
 * wildcard, then `default`. When the matched entry is a `content` map, the
 * media type is matched exactly first and then through the catch-all media
 * type wildcard.
 *
 * @param {object} context the request context
 * @param {number|string} statusCode the http status code
 * @param {string} [contentType] the reply content type
 * @param {object} [options] the lookup options
 * @param {boolean} [options.failClosed] when true, a content map that matches
 *   neither the content type nor the catch-all media type wildcard raises
 *   `FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN` instead of returning false
 * @param {symbol} [options.symbol] the symbol of the bucket to look into
 * @returns {object|false} the matching entry or false if there is none
 */
function getResponseSchemaEntry (
  context,
  statusCode,
  contentType,
  { failClosed = false, symbol = kSchemaResponse } = {}
) {
  const bucket = context[symbol]
  if (!bucket) {
    return false
  }

  const entry = getBucketEntry(bucket, statusCode)
  if (entry === undefined) {
    // No entry for this status code: the lookup is lenient, no validation
    // runs and nothing is thrown.
    return false
  }

  if (entry.constructor !== Object) {
    // The entry is a plain schema, it applies to every media type.
    return entry
  }

  // The entry is a content map: the media type must match.
  const ct = ContentType.from(contentType)
  if (ct.isValid) {
    if (entry[ct.mediaType]) {
      return entry[ct.mediaType]
    }

    // fallback to match all media-type
    if (entry['*/*']) {
      return entry['*/*']
    }
  }

  if (failClosed) {
    throw new FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN(statusCode, contentType)
  }

  return false
}

/**
 * Look for the entry of a status code in a response schema bucket.
 *
 * @param {object} bucket the response schema bucket
 * @param {number|string} statusCode the http status code
 * @returns {object|undefined} the entry or undefined when nothing matches
 */
function getBucketEntry (bucket, statusCode) {
  if (bucket[statusCode]) {
    return bucket[statusCode]
  }
  const fallbackStatusCode = (statusCode + '')[0] + 'xx'
  if (bucket[fallbackStatusCode]) {
    return bucket[fallbackStatusCode]
  }
  if (bucket.default) {
    return bucket.default
  }
  return undefined
}

module.exports = {
  buildSchemas (initStore) { return new Schemas(initStore) },
  getSchemaSerializer,
  getResponseSchemaEntry,
  normalizeSchema
}
