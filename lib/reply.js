'use strict'

const eos = require('node:stream').finished

const {
  kFourOhFourContext,
  kReplyErrorHandlerCalled,
  kReplyHijacked,
  kReplyStartTime,
  kReplyEndTime,
  kReplySerializer,
  kReplySerializerDefault,
  kReplyIsError,
  kReplyHeaders,
  kReplyTrailers,
  kReplyHasStatusCode,
  kReplyIsRunningOnErrorHook,
  kReplyNextErrorHandler,
  kSchemaOutputValidator,
  kRouteContext,
  kTimeoutTimer,
  kOnAbort,
  kRequestSignal,
  kLogController
} = require('./symbols.js')
const {
  onSendHookRunner,
  onResponseHookRunner,
  preHandlerHookRunner,
  preSerializationHookRunner,
  preResponseValidationHookRunner
} = require('./hooks')

const internals = require('./handle-request.js')[Symbol.for('internals')]
const loggerUtils = require('./logger-factory')
const now = loggerUtils.now
const { handleError } = require('./error-handler')
const { getResponseSchemaEntry } = require('./schemas')

const CONTENT_TYPE = {
  JSON: 'application/json; charset=utf-8',
  PLAIN: 'text/plain; charset=utf-8',
  OCTET: 'application/octet-stream'
}
const {
  FST_ERR_REP_INVALID_PAYLOAD_TYPE,
  FST_ERR_REP_RESPONSE_BODY_CONSUMED,
  FST_ERR_REP_READABLE_STREAM_LOCKED,
  FST_ERR_REP_ALREADY_SENT,
  FST_ERR_SEND_INSIDE_ONERR,
  FST_ERR_BAD_STATUS_CODE,
  FST_ERR_BAD_TRAILER_NAME,
  FST_ERR_BAD_TRAILER_VALUE,
  FST_ERR_OUTPUT_VALIDATION,
  FST_ERR_DEC_UNDECLARED,
  FST_ERR_SERIALIZER_COMPILER_REMOVED
} = require('./errors')
const decorators = require('./decorate')
const ContentType = require('./content-type.js')

const toString = Object.prototype.toString
const HTTP2_WRITE_CHUNK_SIZE = 64 * 1024

function Reply (res, request, log) {
  this.raw = res
  this[kReplySerializer] = null
  this[kReplyErrorHandlerCalled] = false
  this[kReplyIsError] = false
  this[kReplyIsRunningOnErrorHook] = false
  this.request = request
  this[kReplyHeaders] = {}
  this[kReplyTrailers] = null
  this[kReplyHasStatusCode] = false
  this[kReplyStartTime] = undefined
  this.log = log
}
Reply.props = []
Reply.instanceProperties = new Set(['raw', 'request', 'log'])

Object.defineProperties(Reply.prototype, {
  [kRouteContext]: {
    get () {
      return this.request[kRouteContext]
    }
  },
  elapsedTime: {
    get () {
      if (this[kReplyStartTime] === undefined) {
        return 0
      }
      return (this[kReplyEndTime] || now()) - this[kReplyStartTime]
    }
  },
  mediaType: {
    get () {
      const contentTypeHeader = this.getHeader('content-type')
      return ContentType.from(contentTypeHeader).mediaType
    }
  },
  server: {
    get () {
      return this.request[kRouteContext].server
    }
  },
  sent: {
    enumerable: true,
    get () {
      // We are checking whether reply was hijacked or the response has ended.
      return (this[kReplyHijacked] || this.raw.writableEnded) === true
    }
  },
  statusCode: {
    get () {
      return this.raw.statusCode
    },
    set (value) {
      this.code(value)
    }
  },
  routeOptions: {
    get () {
      return this.request.routeOptions
    }
  }
})

Reply.prototype.writeEarlyHints = function (hints, callback) {
  this.raw.writeEarlyHints(hints, callback)
  return this
}

Reply.prototype.hijack = function () {
  this[kReplyHijacked] = true
  // Clear handler timeout and signal — hijacked replies manage their own lifecycle
  if (this.request[kRequestSignal]) {
    clearTimeout(this.request[kTimeoutTimer])
    this.request[kTimeoutTimer] = null
    if (this.request[kOnAbort]) {
      this.request.raw.removeListener('close', this.request[kOnAbort])
      this.request[kOnAbort] = null
    }
  }
  // Clear socket._meta so hijacked replies (e.g. WebSocket upgrades) do not
  // retain request/reply objects for the lifetime of the keep-alive socket
  // when an onTimeout hook is registered.
  const socket = this.request.raw.socket
  if (socket?._meta?.request === this.request) {
    socket.removeListener('timeout', socket._meta.onTimeout)
    socket._meta = null
  }
  return this
}

Reply.prototype.send = function (payload) {
  if (this[kReplyIsRunningOnErrorHook]) {
    throw new FST_ERR_SEND_INSIDE_ONERR()
  }

  if (this.sent === true) {
    this.log.warn({ err: new FST_ERR_REP_ALREADY_SENT(this.request.url, this.request.method) })
    return this
  }

  if (this[kReplyIsError] || payload instanceof Error) {
    this[kReplyIsError] = false
    onErrorHook(this, payload, onSendHook)
    return this
  }

  if (payload === undefined) {
    onSendHook(this, payload)
    return this
  }

  const contentType = ContentType.from(this.getHeader('content-type'))
  const hasContentType = contentType.isEmpty === false

  if (payload !== null) {
    if (
      // node:stream
      typeof payload.pipe === 'function' ||
      // node:stream/web
      typeof payload.getReader === 'function' ||
      // Response
      (typeof payload === 'object' && toString.call(payload) === '[object Response]')
    ) {
      onSendHook(this, payload)
      return this
    }

    if (payload.buffer instanceof ArrayBuffer) {
      if (!hasContentType) {
        this[kReplyHeaders]['content-type'] = CONTENT_TYPE.OCTET
      }
      const payloadToSend = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      onSendHook(this, payloadToSend)
      return this
    }

    if (!hasContentType && typeof payload === 'string') {
      this[kReplyHeaders]['content-type'] = CONTENT_TYPE.PLAIN
      onSendHook(this, payload)
      return this
    }
  }

  if (this[kReplySerializer] !== null) {
    if (typeof payload !== 'string') {
      preSerializationHook(this, payload)
      return this
    }
    payload = this[kReplySerializer](payload)

    // The indexOf below also matches custom json mimetypes such as 'application/hal+json' or 'application/ld+json'
  } else if (!hasContentType || contentType.mediaType.indexOf('json') !== -1) {
    if (!hasContentType) {
      this[kReplyHeaders]['content-type'] = CONTENT_TYPE.JSON
    } else if (contentType.parameters.has('charset') === false) {
      // The lookup is case-insensitive because HTTP parameter names are
      // case-insensitive (RFC 9110 section 5.6.6).
      // If user doesn't set charset, we will set charset to utf-8
      const customContentType = contentType.toString()
      // ContentType.toString already handle the trailing ;
      // We can safely append the charset parameter to the end of the string
      this[kReplyHeaders]['content-type'] = `${customContentType}; charset=utf-8`
    }

    if (typeof payload !== 'string') {
      preSerializationHook(this, payload)
      return this
    }
  }

  onSendHook(this, payload)

  return this
}

Reply.prototype.getHeader = function (key) {
  key = key.toLowerCase()
  const value = this[kReplyHeaders][key]
  return value !== undefined ? value : this.raw.getHeader(key)
}

Reply.prototype.getHeaders = function () {
  return {
    ...this.raw.getHeaders(),
    ...this[kReplyHeaders]
  }
}

Reply.prototype.hasHeader = function (key) {
  key = key.toLowerCase()

  return this[kReplyHeaders][key] !== undefined || this.raw.hasHeader(key)
}

Reply.prototype.removeHeader = function (key) {
  key = key.toLowerCase()
  // Node.js does not like headers with keys set to undefined,
  // so we have to delete the key.
  delete this[kReplyHeaders][key]
  if (!this.raw.headersSent) {
    this.raw.removeHeader(key)
  }
  return this
}

Reply.prototype.header = function (key, value = '') {
  key = key.toLowerCase()

  if (this[kReplyHeaders][key] && key === 'set-cookie') {
    // https://datatracker.ietf.org/doc/html/rfc7230#section-3.2.2
    if (typeof this[kReplyHeaders][key] === 'string') {
      this[kReplyHeaders][key] = [this[kReplyHeaders][key]]
    }

    if (Array.isArray(value)) {
      Array.prototype.push.apply(this[kReplyHeaders][key], value)
    } else {
      this[kReplyHeaders][key].push(value)
    }
  } else if (key === 'set-cookie' && Array.isArray(value)) {
    // Copy the array: later calls push into the stored one, and the caller's
    // array (often a module-level constant) must not grow across requests.
    this[kReplyHeaders][key] = value.slice()
  } else {
    this[kReplyHeaders][key] = value
  }

  return this
}

Reply.prototype.headers = function (headers) {
  const keys = Object.keys(headers)
  for (let i = 0; i !== keys.length; ++i) {
    const key = keys[i]
    this.header(key, headers[key])
  }

  return this
}

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Trailer#directives
// https://datatracker.ietf.org/doc/html/rfc7230.html#chunked.trailer.part
const INVALID_TRAILERS = new Set([
  'transfer-encoding',
  'content-length',
  'host',
  'cache-control',
  'max-forwards',
  'te',
  'authorization',
  'set-cookie',
  'content-encoding',
  'content-type',
  'content-range',
  'trailer'
])

Reply.prototype.trailer = function (key, fn) {
  key = key.toLowerCase()
  if (INVALID_TRAILERS.has(key)) {
    throw new FST_ERR_BAD_TRAILER_NAME(key)
  }
  if (typeof fn !== 'function') {
    throw new FST_ERR_BAD_TRAILER_VALUE(key, typeof fn)
  }
  if (this[kReplyTrailers] === null) this[kReplyTrailers] = {}
  this[kReplyTrailers][key] = fn
  return this
}

Reply.prototype.hasTrailer = function (key) {
  return this[kReplyTrailers]?.[key.toLowerCase()] !== undefined
}

Reply.prototype.removeTrailer = function (key) {
  if (this[kReplyTrailers] === null) return this
  this[kReplyTrailers][key.toLowerCase()] = undefined
  return this
}

Reply.prototype.code = function (code) {
  const statusCode = +code
  if (!(statusCode >= 100 && statusCode <= 599)) {
    throw new FST_ERR_BAD_STATUS_CODE(code || String(code))
  }

  this.raw.statusCode = statusCode
  this[kReplyHasStatusCode] = true
  return this
}

Reply.prototype.status = Reply.prototype.code

Reply.prototype.getSerializationFunction = function () {
  // The reply serialization helpers are gone with `fast-json-stringify`: they
  // fail explicitly until plan 02-02 removes them for good.
  throw new FST_ERR_SERIALIZER_COMPILER_REMOVED('reply.getSerializationFunction()')
}

Reply.prototype.compileSerializationSchema = function () {
  throw new FST_ERR_SERIALIZER_COMPILER_REMOVED('reply.compileSerializationSchema()')
}

Reply.prototype.serializeInput = function () {
  throw new FST_ERR_SERIALIZER_COMPILER_REMOVED('reply.serializeInput()')
}

Reply.prototype.serialize = function (payload) {
  if (this[kReplySerializer] !== null) {
    return this[kReplySerializer](payload)
  } else {
    if (this[kRouteContext] && this[kRouteContext][kReplySerializerDefault]) {
      return this[kRouteContext][kReplySerializerDefault](payload, this.raw.statusCode)
    } else {
      return JSON.stringify(payload)
    }
  }
}

Reply.prototype.serializer = function (fn) {
  this[kReplySerializer] = fn
  return this
}

Reply.prototype.type = function (type) {
  this[kReplyHeaders]['content-type'] = type
  return this
}

Reply.prototype.redirect = function (url, code) {
  if (!code) {
    code = this[kReplyHasStatusCode] ? this.raw.statusCode : 302
  }

  return this.header('location', url).code(code).send()
}

Reply.prototype.callNotFound = function () {
  notFound(this)
  return this
}

// Make reply a thenable, so it could be used with async/await.
// See
// - https://github.com/fastify/fastify/issues/1864 for the discussions
// - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/then for the signature
Reply.prototype.then = function (fulfilled, rejected) {
  if (this.sent) {
    fulfilled()
    return
  }

  eos(this.raw, (err) => {
    // We must not treat ERR_STREAM_PREMATURE_CLOSE as
    // an error because it is created by eos, not by the stream.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      if (rejected) {
        rejected(err)
      } else {
        this.log && this.log.warn('unhandled rejection on reply.then')
      }
    } else {
      fulfilled()
    }
  })
}

Reply.prototype.getDecorator = function (name) {
  if (!decorators.hasKey(this, name) && !decorators.exist(this, name)) {
    throw new FST_ERR_DEC_UNDECLARED(name, 'reply')
  }

  const decorator = this[name]
  if (typeof decorator === 'function') {
    return decorator.bind(this)
  }

  return decorator
}

/**
 * The response pipeline, between the handler payload and the serialization.
 *
 * The `preResponseValidation` hooks run *before* the output validation, so
 * that a hook can shape the payload that will be validated, and the output
 * validation runs *before* the `preSerialization` hooks, so that a hook cannot
 * scrub a malformed payload out of the validation, and so that the payload a
 * hook produces is never validated.
 *
 * @param {Reply} reply the reply
 * @param {*} payload the payload returned by the handler
 */
function preSerializationHook (reply, payload) {
  const context = reply[kRouteContext]

  // The `preResponseValidation` hooks observe the payload the handler returned
  // and they may replace it. They run before the output validation, so the
  // payload they produce is validated as well.
  if (context.preResponseValidation !== null) {
    preResponseValidationHookRunner(
      context.preResponseValidation,
      reply.request,
      reply,
      payload,
      preResponseValidationHookEnd
    )
  } else {
    preResponseValidationHookEnd(null, undefined, reply, payload)
  }
}

/**
 * The end of the `preResponseValidation` stage.
 *
 * A hook that fails (a thrown error or a `done(err)`) routes the error through
 * the standard error handler and the output validation is skipped for that
 * request only.
 *
 * @param {Error} err the error raised by the hook, if any
 * @param {*} _request the request
 * @param {Reply} reply the reply
 * @param {*} payload the payload the hooks produced
 */
function preResponseValidationHookEnd (err, _request, reply, payload) {
  if (err != null) {
    onErrorHook(reply, err)
    return
  }

  outputValidation(reply, payload)
}

/**
 * The output validation stage: the payload is checked against
 * `schema.response` before it is serialized.
 *
 * @param {Reply} reply the reply
 * @param {*} payload the payload to validate
 */
function outputValidation (reply, payload) {
  const context = reply[kRouteContext]

  // A reply that is handled by a custom serializer owns the wire format: the
  // output validation is skipped entirely. The check happens *before* the
  // lookup, so no fail closed error can be raised for it. The decision is
  // taken when the response is produced, so a serializer installed by a
  // `preHandler` or a `preValidation` hook is honoured.
  if (reply[kReplySerializer] !== null ||
    (context && context[kReplySerializerDefault])) {
    runPreSerializationHooks(reply, payload)
    return
  }

  // The `null` payload is never validated: it keeps the body that
  // `fast-json-stringify` produces for it today.
  if (payload === null) {
    runPreSerializationHooks(reply, payload)
    return
  }

  let validator
  try {
    validator = getResponseSchemaEntry(
      context,
      reply.raw.statusCode,
      reply.getHeader('content-type'),
      { failClosed: true, symbol: kSchemaOutputValidator }
    )
  } catch (err) {
    // The lookup fails closed: the content type is neither declared in the
    // `content` map of the matched status code nor covered by `*/*`.
    onErrorHook(reply, err)
    return
  }

  if (!validator) {
    // No entry matches the status code: the lookup is lenient, no validation
    // runs and the payload is sent as it is.
    runPreSerializationHooks(reply, payload)
    return
  }

  let result
  try {
    result = validator(payload)
  } catch (err) {
    onErrorHook(reply, normalizeOutputValidationError(err))
    return
  }

  if (result && typeof result.then === 'function') {
    // An async output validator is awaited before the response continues: the
    // payload is never sent with an unresolved validation result.
    result.then(
      (value) => {
        // A validator that resolves `false` has rejected the payload, exactly
        // as a synchronous validator that returns `false` does.
        if (value === false) {
          onErrorHook(reply, buildOutputValidationError(validator.errors))
          return
        }
        runPreSerializationHooks(reply, payload)
      },
      (err) => { onErrorHook(reply, normalizeOutputValidationError(err)) }
    )
    return
  }

  if (result === false) {
    onErrorHook(reply, buildOutputValidationError(validator.errors))
    return
  }

  runPreSerializationHooks(reply, payload)
}

function runPreSerializationHooks (reply, payload) {
  if (reply[kRouteContext].preSerialization !== null) {
    preSerializationHookRunner(
      reply[kRouteContext].preSerialization,
      reply.request,
      reply,
      payload,
      preSerializationHookEnd
    )
  } else {
    preSerializationHookEnd(null, undefined, reply, payload)
  }
}

/**
 * Builds the framework error of a failed output validation.
 *
 * @param {Array} errors the Ajv errors array
 * @returns {Error} the `FST_ERR_OUTPUT_VALIDATION` error
 */
function buildOutputValidationError (errors) {
  const validation = Array.isArray(errors) ? errors : []
  const summary = summarizeOutputValidationErrors(validation)
  const error = new FST_ERR_OUTPUT_VALIDATION(summary)
  if (!summary) {
    // A validator that rejects without describing the violation produces no
    // summary: the message must not end with an empty list of errors.
    error.message = 'Response validation failed.'
  }
  error.validation = validation
  error.validationContext = 'response'
  return error
}

/**
 * Normalizes an error thrown (or a promise rejected) by the output validator.
 *
 * An error that carries an Ajv errors array is reported with the framework
 * error shape, any other error is passed through unchanged: a validator that
 * fails for its own reason must not be relabelled.
 *
 * @param {Error} error the error raised by the validator
 * @returns {Error} the error to send to the error handler
 */
function normalizeOutputValidationError (error) {
  if (error && Array.isArray(error.errors)) {
    return buildOutputValidationError(error.errors)
  }
  return error
}

function summarizeOutputValidationErrors (errors) {
  return errors
    .map((error) => error.instancePath ? `${error.instancePath} ${error.message}` : error.message)
    .join('; ')
}

function preSerializationHookEnd (err, _request, reply, payload) {
  if (err != null) {
    onErrorHook(reply, err)
    return
  }

  try {
    if (reply[kReplySerializer] !== null) {
      payload = reply[kReplySerializer](payload)
    } else if (reply[kRouteContext] && reply[kRouteContext][kReplySerializerDefault]) {
      payload = reply[kRouteContext][kReplySerializerDefault](payload, reply.raw.statusCode)
    } else {
      payload = JSON.stringify(payload)
    }
  } catch (e) {
    wrapSerializationError(e, reply)
    onErrorHook(reply, e)
    return
  }

  onSendHook(reply, payload)
}

function wrapSerializationError (error, reply) {
  error.serialization = reply[kRouteContext].config
}

function onSendHook (reply, payload) {
  if (reply[kRouteContext].onSend !== null) {
    onSendHookRunner(
      reply[kRouteContext].onSend,
      reply.request,
      reply,
      payload,
      wrapOnSendEnd
    )
  } else {
    onSendEnd(reply, payload)
  }
}

function wrapOnSendEnd (err, request, reply, payload) {
  if (err != null) {
    onErrorHook(reply, err)
  } else {
    onSendEnd(reply, payload)
  }
}

function safeWriteHead (reply, statusCode) {
  const res = reply.raw
  try {
    res.writeHead(statusCode, reply[kReplyHeaders])
  } catch (err) {
    if (err.code === 'ERR_HTTP_HEADERS_SENT') {
      reply.log.warn(`Reply was already sent, did you forget to "return reply" in the "${reply.request.raw.url}" (${reply.request.raw.method}) route?`)
    }
    throw err
  }
}

function onSendEnd (reply, payload) {
  const res = reply.raw
  const req = reply.request

  // we check if we need to update the trailers header and set it
  if (reply[kReplyTrailers] !== null) {
    const trailerHeaders = Object.keys(reply[kReplyTrailers])
    let header = ''
    for (const trailerName of trailerHeaders) {
      if (typeof reply[kReplyTrailers][trailerName] !== 'function') continue
      header += ' '
      header += trailerName
    }
    if (header !== '') {
      // HTTP/1 must use chunked encoding for trailers. HTTP/2 forbids
      // the transfer-encoding header and handles trailers natively.
      if (!isHttp2Reply(reply)) {
        reply.header('Transfer-Encoding', 'chunked')
      }
      reply.header('Trailer', header.trim())
    } else {
      reply[kReplyTrailers] = null
    }
  }

  // since Response contain status code, headers and body,
  // we need to update the status, add the headers and use it's body as payload
  // before continuing
  if (payload != null && typeof payload === 'object' && toString.call(payload) === '[object Response]') {
    // https://developer.mozilla.org/en-US/docs/Web/API/Response/status
    if (typeof payload.status === 'number') {
      reply.code(payload.status)
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/Response/headers
    if (typeof payload.headers === 'object' && typeof payload.headers.forEach === 'function') {
      for (const [headerName, headerValue] of payload.headers) {
        reply.header(headerName, headerValue)
      }
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/Response/body
    if (payload.body !== null) {
      if (payload.bodyUsed) {
        throw new FST_ERR_REP_RESPONSE_BODY_CONSUMED()
      }
    }
    // Keep going, body is either null or ReadableStream
    payload = payload.body
  }
  const statusCode = res.statusCode

  if (payload === undefined || payload === null) {
    // according to https://datatracker.ietf.org/doc/html/rfc7230#section-3.3.2
    // we cannot send a content-length for 304 and 204, and all status code
    // < 200
    // A sender MUST NOT send a Content-Length header field in any message
    // that contains a Transfer-Encoding header field.
    // For HEAD we don't overwrite the `content-length`
    if (statusCode >= 200 && statusCode !== 204 && statusCode !== 304 && req.method !== 'HEAD' && reply[kReplyTrailers] === null) {
      reply[kReplyHeaders]['content-length'] = '0'
    }

    safeWriteHead(reply, statusCode)
    sendTrailer(payload, res, reply)
    return
  }

  if ((statusCode >= 100 && statusCode < 200) || statusCode === 204) {
    // Responses without a content body must not send content-type
    // or content-length headers.
    // See https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6.
    reply.removeHeader('content-type')
    reply.removeHeader('content-length')
    safeWriteHead(reply, statusCode)
    sendTrailer(undefined, res, reply)
    if (typeof payload.resume === 'function') {
      payload.on('error', noop)
      payload.resume()
    }
    return
  }

  // node:stream
  if (typeof payload.pipe === 'function') {
    sendStream(payload, res, reply)
    return
  }

  // node:stream/web
  if (typeof payload.getReader === 'function') {
    sendWebStream(payload, res, reply)
    return
  }

  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
    throw new FST_ERR_REP_INVALID_PAYLOAD_TYPE(typeof payload)
  }

  if (reply[kReplyTrailers] === null) {
    const contentLength = reply[kReplyHeaders]['content-length']
    if (!contentLength ||
      (req.raw.method !== 'HEAD' &&
        Number(contentLength) !== Buffer.byteLength(payload)
      )
    ) {
      reply[kReplyHeaders]['content-length'] = '' + Buffer.byteLength(payload)
    }
  }

  safeWriteHead(reply, statusCode)
  // write payload first
  writePayload(payload, res, reply)
}

function isHttp2Reply (reply) {
  return reply.request.raw?.httpVersionMajor === 2
}

function writePayload (payload, res, reply) {
  if (!isHttp2Reply(reply) || Buffer.byteLength(payload) <= HTTP2_WRITE_CHUNK_SIZE) {
    if (reply[kReplyTrailers] === null) {
      // end(payload) corks the socket, so headers, payload and the
      // finishing chunk are flushed with a single write
      res.end(payload, null, null) // avoid ArgumentsAdaptorTrampoline from V8
      return
    }
    res.write(payload)
    // then send trailers
    sendTrailer(payload, res, reply)
    return
  }

  writeHttp2Payload(payload, res, () => {
    // then send trailers
    sendTrailer(payload, res, reply)
  })
}

function writeHttp2Payload (payload, res, done) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let offset = 0

  function writeChunk () {
    while (offset < buffer.length) {
      /* c8 ignore next 3 - defensive guard for aborted responses */
      if (res.destroyed || res.writableEnded) {
        return
      }

      const end = Math.min(offset + HTTP2_WRITE_CHUNK_SIZE, buffer.length)
      const shouldContinue = res.write(buffer.subarray(offset, end))
      offset = end

      if (shouldContinue === false) {
        res.once('drain', writeChunk)
        return
      }
    }

    done()
  }

  writeChunk()
}

function logStreamError (err, reply, res) {
  reply.server[kLogController].streamError(err, reply.request, reply)
}

function sendWebStream (payload, res, reply) {
  if (payload.locked) {
    throw new FST_ERR_REP_READABLE_STREAM_LOCKED()
  }

  let sourceOpen = true
  let errorLogged = false
  let waitingDrain = false
  const reader = payload.getReader()

  eos(res, function (err) {
    if (sourceOpen) {
      if (err != null && res.headersSent && !errorLogged) {
        errorLogged = true
        logStreamError(err, reply, res)
      }
      reader.cancel().catch(noop)
    }
  })

  if (!res.headersSent) {
    for (const key in reply[kReplyHeaders]) {
      res.setHeader(key, reply[kReplyHeaders][key])
    }
  } else {
    reply.log.warn('response will send, but you shouldn\'t use res.writeHead in stream mode')
  }

  function onRead (result) {
    if (result.done) {
      sourceOpen = false
      sendTrailer(null, res, reply)
      return
    }
    /* c8 ignore next 5 - race condition: eos handler typically fires first */
    if (res.destroyed) {
      sourceOpen = false
      reader.cancel().catch(noop)
      return
    }
    const shouldContinue = res.write(result.value)
    if (shouldContinue === false) {
      waitingDrain = true
      res.once('drain', onDrain)
      return
    }
    reader.read().then(onRead, onReadError)
  }

  function onDrain () {
    if (!waitingDrain || !sourceOpen || res.destroyed) {
      return
    }
    waitingDrain = false
    reader.read().then(onRead, onReadError)
  }

  function onReadError (err) {
    sourceOpen = false
    if (res.headersSent || reply.request.raw.aborted === true) {
      if (!errorLogged) {
        errorLogged = true
        logStreamError(err, reply, reply)
      }
      res.destroy()
    } else {
      onErrorHook(reply, err)
    }
  }

  reader.read().then(onRead, onReadError)
}

function sendStream (payload, res, reply) {
  let sourceOpen = true
  let errorLogged = false

  eos(payload, { readable: true, writable: false }, function (err) {
    sourceOpen = false
    if (err != null) {
      if (res.headersSent || reply.request.raw.aborted === true) {
        if (!errorLogged) {
          errorLogged = true
          logStreamError(err, reply, reply)
        }
        res.destroy()
      } else {
        onErrorHook(reply, err)
      }
      return
    }
    // eos fires even for a stream that already ended
    if (reply[kReplyTrailers] !== null) {
      sendTrailer(null, res, reply)
    }
  })

  eos(res, function (err) {
    if (sourceOpen) {
      if (err != null && res.headersSent && !errorLogged) {
        errorLogged = true
        logStreamError(err, reply, res)
      }
      if (typeof payload.destroy === 'function') {
        payload.destroy()
      } else if (typeof payload.close === 'function') {
        payload.close(noop)
      } else if (typeof payload.abort === 'function') {
        payload.abort()
      } else {
        reply.log.warn('stream payload does not end properly')
      }
    }
  })

  // streams will error asynchronously, and we want to handle that error
  // appropriately, e.g. a 404 for a missing file. So we cannot use
  // writeHead, and we need to resort to setHeader, which will trigger
  // a writeHead when there is data to send.
  if (!res.headersSent) {
    for (const key in reply[kReplyHeaders]) {
      res.setHeader(key, reply[kReplyHeaders][key])
    }
  } else {
    reply.log.warn('response will send, but you shouldn\'t use res.writeHead in stream mode')
  }
  // trailers set: the eos listener above ends the response, not pipe
  if (reply[kReplyTrailers] !== null) {
    payload.pipe(res, { end: false })
  } else {
    payload.pipe(res)
  }
}

function sendTrailer (payload, res, reply) {
  if (reply[kReplyTrailers] === null) {
    // when no trailer, we close the stream
    res.end(null, null, null) // avoid ArgumentsAdaptorTrampoline from V8
    return
  }
  const trailerHeaders = Object.keys(reply[kReplyTrailers])
  const trailers = {}
  let handled = 0
  let skipped = true
  let sent = false
  function send () {
    // add trailers when all handler handled
    /* istanbul ignore else */
    if (handled === 0 && !sent) {
      sent = true
      res.addTrailers(trailers)
      // we need to properly close the stream
      // after trailers sent
      res.end(null, null, null) // avoid ArgumentsAdaptorTrampoline from V8
    }
  }

  for (const trailerName of trailerHeaders) {
    if (typeof reply[kReplyTrailers][trailerName] !== 'function') continue
    skipped = false
    handled--

    let cbAlreadyCalled = false
    function cb (err, value) {
      if (cbAlreadyCalled) return
      cbAlreadyCalled = true
      handled++

      // we can safely ignore error for trailer
      // since it does affect the client
      // we log in here only for debug usage
      if (err) reply.log.debug(err)
      else trailers[trailerName] = value

      // we push the check to the end of event
      // loop, so the registration continue to
      // process.
      process.nextTick(send)
    }

    const result = reply[kReplyTrailers][trailerName](reply, payload, cb)
    if (typeof result === 'object' && typeof result.then === 'function') {
      result.then((v) => cb(null, v), cb)
    }
  }

  // when all trailers are skipped
  // we need to close the stream
  if (skipped) res.end(null, null, null) // avoid ArgumentsAdaptorTrampoline from V8
}

function onErrorHook (reply, error, cb) {
  if (reply[kRouteContext].onError !== null && !reply[kReplyNextErrorHandler]) {
    reply[kReplyIsRunningOnErrorHook] = true
    onSendHookRunner(
      reply[kRouteContext].onError,
      reply.request,
      reply,
      error,
      () => handleError(reply, error, cb)
    )
  } else {
    handleError(reply, error, cb)
  }
}

function setupResponseListeners (reply) {
  reply[kReplyStartTime] = now()

  const onResFinished = err => {
    reply[kReplyEndTime] = now()
    reply.raw.removeListener('finish', onResFinished)
    reply.raw.removeListener('error', onResFinished)

    const ctx = reply[kRouteContext]

    // Clean up handler timeout / signal resources
    if (reply.request[kRequestSignal]) {
      clearTimeout(reply.request[kTimeoutTimer])
      reply.request[kTimeoutTimer] = null
      if (reply.request[kOnAbort]) {
        reply.request.raw.removeListener('close', reply.request[kOnAbort])
        reply.request[kOnAbort] = null
      }
    }

    // Fix: release socket._meta so request/reply objects are not retained
    // past the response on keep-alive connections.
    const socket = reply.request.raw.socket
    if (socket && socket._meta && socket._meta.request === reply.request) {
      socket.removeListener('timeout', socket._meta.onTimeout)
      socket._meta = null
    }

    if (ctx && ctx.onResponse !== null) {
      onResponseHookRunner(
        ctx.onResponse,
        reply.request,
        reply,
        onResponseCallback
      )
    } else {
      onResponseCallback(err, reply.request, reply)
    }
  }

  reply.raw.on('finish', onResFinished)
  reply.raw.on('error', onResFinished)
}

function onResponseCallback (err, request, reply) {
  reply.server[kLogController].requestCompleted(err, request, reply)
}

function buildReply (R) {
  const props = R.props.slice()

  function _Reply (res, request, log) {
    this.raw = res
    this[kReplyIsError] = false
    this[kReplyErrorHandlerCalled] = false
    this[kReplyHijacked] = false
    this[kReplySerializer] = null
    this.request = request
    this[kReplyHeaders] = {}
    this[kReplyTrailers] = null
    this[kReplyStartTime] = undefined
    this[kReplyEndTime] = undefined
    this.log = log

    let prop

    for (let i = 0; i < props.length; i++) {
      prop = props[i]
      this[prop.key] = prop.value
    }
  }
  Object.setPrototypeOf(_Reply.prototype, R.prototype)
  Object.setPrototypeOf(_Reply, R)
  _Reply.parent = R
  _Reply.props = props
  return _Reply
}

function notFound (reply) {
  if (reply[kRouteContext][kFourOhFourContext] === null) {
    reply.log.warn('Trying to send a NotFound error inside a 404 handler. Sending basic 404 response.')
    reply.code(404).send('404 Not Found')
    return
  }

  reply.request[kRouteContext] = reply[kRouteContext][kFourOhFourContext]

  // preHandler hook
  if (reply[kRouteContext].preHandler !== null) {
    preHandlerHookRunner(
      reply[kRouteContext].preHandler,
      reply.request,
      reply,
      internals.preHandlerCallback
    )
  } else {
    internals.preHandlerCallback(null, reply.request, reply)
  }
}

function noop () { }

module.exports = Reply
module.exports.buildReply = buildReply
module.exports.setupResponseListeners = setupResponseListeners
