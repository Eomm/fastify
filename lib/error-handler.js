'use strict'

const statusCodes = require('node:http').STATUS_CODES
const wrapThenable = require('./wrap-thenable.js')
const { setErrorStatusCode } = require('./error-status.js')
const {
  kReplyHeaders,
  kReplyNextErrorHandler,
  kReplyIsRunningOnErrorHook,
  kRouteContext,
  kLogController,
  kDiagnosticsStore,
  kSchemaOutputValidator
} = require('./symbols.js')

const {
  FST_ERR_REP_INVALID_PAYLOAD_TYPE,
  FST_ERR_FAILED_ERROR_SERIALIZATION
} = require('./errors')

const { getResponseSchemaEntry } = require('./schemas')

const serializeError = require('./error-serializer')
const rootErrorHandler = {
  func: defaultErrorHandler,
  toJSON () {
    return this.func.name.toString() + '()'
  }
}

function handleError (reply, error, cb) {
  reply[kReplyIsRunningOnErrorHook] = false

  const context = reply[kRouteContext]
  if (reply[kReplyNextErrorHandler] === false) {
    fallbackErrorHandler(error, reply, function (reply, payload) {
      try {
        reply.raw.writeHead(reply.raw.statusCode, reply[kReplyHeaders])
      } catch (error) {
        reply.server[kLogController].writeHeadError(error, reply.request, reply)
        reply.raw.writeHead(reply.raw.statusCode)
      }
      reply.raw.end(payload)
    })
    return
  }
  const errorHandler = reply[kReplyNextErrorHandler] || context.errorHandler

  // In case the error handler throws, we set the next errorHandler so we can error again
  reply[kReplyNextErrorHandler] = Object.getPrototypeOf(errorHandler)

  // we need to remove content-type to allow content-type guessing for serialization
  delete reply[kReplyHeaders]['content-type']
  delete reply[kReplyHeaders]['content-length']

  const func = errorHandler.func

  if (!func) {
    reply[kReplyNextErrorHandler] = false
    fallbackErrorHandler(error, reply, cb)
    return
  }

  try {
    const result = func(error, reply.request, reply)
    if (result !== undefined) {
      if (result !== null && typeof result.then === 'function') {
        const store = reply[kDiagnosticsStore] || null
        wrapThenable(result, reply, store)
      } else {
        reply.send(result)
      }
    }
  } catch (err) {
    reply.send(err)
  }
}

function defaultErrorHandler (error, request, reply) {
  setErrorHeaders(error, reply)
  setErrorStatusCode(reply, error)
  request.server[kLogController].defaultErrorLog(error, request, reply)
  reply.send(error)
}

function fallbackErrorHandler (error, reply, cb) {
  const res = reply.raw
  const statusCode = reply.statusCode
  reply[kReplyHeaders]['content-type'] = reply[kReplyHeaders]['content-type'] ?? 'application/json; charset=utf-8'
  let payload
  try {
    // The lookup is lenient: it matches the status code and the content type,
    // and it returns false when nothing matches. The error path never fails
    // closed.
    const validator = getResponseSchemaEntry(
      reply[kRouteContext],
      statusCode,
      reply[kReplyHeaders]['content-type'],
      { failClosed: false, symbol: kSchemaOutputValidator }
    )
    if (!validator) {
      // Nothing matches: the built-in error serializer answers.
      payload = serializeError(buildErrorBody(error, statusCode))
    } else {
      const body = buildErrorBody(error, statusCode)
      const result = validator(body)
      if (result && typeof result.then === 'function') {
        // An asynchronous output schema is not awaited in the error path: the
        // error path is a synchronous callback flow. The built-in error
        // serializer answers, exactly as when nothing matches. The rejection
        // is swallowed, so that the error path never leaves an unhandled
        // rejection behind: it would take the process down.
        Promise.resolve(result).catch(() => {})
        payload = serializeError(buildErrorBody(error, statusCode))
      } else if (result === false) {
        // The error body does not satisfy its own error schema.
        throw new Error(`the error body does not match the error schema: ${summarizeValidationErrors(validator.errors)}`)
      } else {
        // The validator shaped the body: the shaped body is the one that
        // reaches the wire.
        payload = JSON.stringify(body)
      }
    }
  } catch (err) {
    // The caught error is the error of the output validation (or the error
    // raised by the validator itself): the route schemas are not looked at
    // again, so the error path never recurses.
    reply.server[kLogController].serializerError(err, reply.request, reply, { statusCode: res.statusCode })

    reply.code(500)
    payload = serializeError(new FST_ERR_FAILED_ERROR_SERIALIZATION(err.message, error.message))
  }

  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
    payload = serializeError(new FST_ERR_REP_INVALID_PAYLOAD_TYPE(typeof payload))
  }

  reply[kReplyHeaders]['content-length'] = '' + Buffer.byteLength(payload)

  cb(reply, payload)
}

/**
 * Builds the body of an error response.
 *
 * The body is a plain object with enumerable own properties: the properties
 * of an error object are not enumerable, so they would never reach the wire.
 * The `code` and the `error` are only part of the body when they are
 * defined: an undefined value must never reach the output validator.
 *
 * @param {Error} error the error
 * @param {number} statusCode the status code of the reply
 * @returns {object} the body of the error response
 */
function buildErrorBody (error, statusCode) {
  const body = {
    statusCode,
    code: error.code,
    error: statusCodes[statusCode + ''],
    message: error.message
  }
  // The own enumerable properties of the error that the body does not carry
  // yet are appended to it: the `fast-json-stringify` era serialized them, so
  // a route error schema could declare them (`{ world: { type: 'string' } }`
  // on an error that carries a `world` property, for example). The properties
  // of an `Error` that are not enumerable (`message`, `stack`) are not
  // copied: `message` is part of the body already.
  if (error !== null && typeof error === 'object') {
    for (const key of Object.keys(error)) {
      if (!Object.hasOwn(body, key)) {
        body[key] = error[key]
      }
    }
  }
  if (body.code === undefined) {
    delete body.code
  }
  if (body.error === undefined) {
    delete body.error
  }
  return body
}

/**
 * Summarizes the errors of a failed output validation.
 *
 * @param {Array} errors the Ajv errors array
 * @returns {string} the summary of the errors
 */
function summarizeValidationErrors (errors) {
  if (!Array.isArray(errors)) {
    return 'the payload is not valid'
  }
  return errors
    .map((error) => error.instancePath ? `${error.instancePath} ${error.message}` : error.message)
    .join('; ')
}

function buildErrorHandler (parent = rootErrorHandler, func) {
  if (!func) {
    return parent
  }

  const errorHandler = Object.create(parent)
  errorHandler.func = func
  return errorHandler
}

function setErrorHeaders (error, reply) {
  const res = reply.raw
  let statusCode = res.statusCode
  statusCode = (statusCode >= 400 && statusCode <= 599) ? statusCode : 500
  // treat undefined and null as same
  if (error != null) {
    if (error.headers !== undefined) {
      reply.headers(error.headers)
    }
    if (error.statusCode >= 400 && error.statusCode <= 599) {
      statusCode = error.statusCode
    } else if (error.status >= 400 && error.status <= 599) {
      statusCode = error.status
    }
  }
  res.statusCode = statusCode
}

module.exports = {
  buildErrorHandler,
  handleError
}
