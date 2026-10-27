# V6 Migration Guide

This guide is intended to help with migration from Fastify v5 to v6.

Fastify v6 is the release that makes the **response validation** a first class
feature of the framework and that drops the `fast-json-stringify` runtime. The
response schema is not only a filter any more: it validates the payload, and
the body is produced by the native `JSON.stringify()`.

The guide is organised in five parts:

- [The output validation](#the-output-validation) — the response schema now
  validates the payload;
- [The removal of the `fast-json-stringify` runtime](#the-removal-of-the-fast-json-stringify-runtime)
  — the body is produced by the native `JSON.stringify()`;
- [The behaviour of the output side](#the-behaviour-of-the-output-side) — what
  the output validator does to the payload;
- [The error path](#the-error-path) — what happens to the body of an error;
- [The removed serialization APIs](#the-removed-serialization-apis) and
  [the renames](#the-renames) — the surfaces that moved or disappeared.

Every entry states the **old** surface (Fastify v5), the **new** surface
(Fastify v6) and the **action** you have to take.

Before migrating to v6, please ensure that you have fixed all deprecation
warnings from v5. All the v5 deprecations have been removed and will no longer
work after upgrading.

## Breaking Changes

### The output validation

#### `schema.response` validates the payload now

**Old:** in Fastify v5 the response schema only *shaped* the payload: it
filtered the properties that the schema did not declare, and it never failed.
A payload that did not match the schema was sent to the client as it was.

**New:** in Fastify v6 the same schema *validates* the payload with Ajv, before
the `preSerialization` hook and before the serialization. A payload that
violates the response schema answers HTTP 500 with the
`FST_ERR_OUTPUT_VALIDATION` error. The error carries the Ajv `validation`
array and the `validationContext` property, which is `response` on this side.

**Action:** check the response schemas of your routes against the payloads that
your handlers return. A payload that used to be filtered silently may now
answer a 500. If a route must not be validated, remove its `schema.response`.

#### The lookup of the response schema is lenient on the status code

**Old:** in Fastify v5 the response schema was selected by the status code of
the answer and by its content type. A status code that no schema matched was
not an error: the body was sent as it was.

**New:** the lookup is still lenient on the status code: when neither the
exact status code, nor the `NXX` family, nor `default` matches, no validation
runs and the payload is sent as it is.

**Action:** none.

#### The lookup of the response schema fails closed on the content type

**Old:** in Fastify v5 a response schema that declares a `content` map and an
answer whose content type is not part of the map was not an error: the body
reached the wire without being shaped.

**New:** the lookup fails closed on the content type: when the matched status
code declares a `content` map that covers neither the content type of the
answer nor the `*/*` wildcard, the response answers HTTP 500 with the
`FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN` error.

**Action:** declare the media type of the answer in the `content` map of the
response schema, or add a `*/*` entry to it.

#### A route without a response schema is not validated

**Old:** in Fastify v5 a route that declares no `schema.response` sent its
payload as it was.

**New:** the behaviour is unchanged: a route that declares no
`schema.response` is not validated.

**Action:** none.

### The removal of the `fast-json-stringify` runtime

#### The response body is produced by the native `JSON.stringify()`

**Old:** in Fastify v5 the response body was produced by
`fast-json-stringify`: the response schema was compiled to an fjs serializer,
and that serializer wrote the bytes of the answer.

**New:** the runtime does not depend on `fast-json-stringify` any more. The
body is produced by the native `JSON.stringify()`, after the output validator
has validated and shaped the payload.

**Action:** nothing for the body itself, but the fjs specific options are gone:
see [the removed serialization APIs](#the-removed-serialization-apis).

#### The type coercion is gone

**Old:** in Fastify v5 the serializer coerced the value to the type of the
schema: `"1"` was serialized as `1`.

**New:** the output pool never coerces a type (`coerceTypes: false`). A value
whose type does not match the schema answers HTTP 500 with the
`FST_ERR_OUTPUT_VALIDATION` error.

**Action:** send the types that the schema declares.

#### The schema `default` is not injected any more

**Old:** in Fastify v5 the serializer injected the `default` of the schema
into the body when the payload did not carry the property.

**New:** the output pool never injects a default (`useDefaults: false`): a
`default` of the response schema never reaches the wire.

**Action:** build the complete payload in the handler.

#### The property order follows the payload

**Old:** in Fastify v5 the properties of the body were emitted in the order of
the schema.

**New:** the properties are emitted in the order of the **payload**, not in the
order of the schema.

**Action:** none, but a byte for byte comparison of a response body may differ.

#### The native `JSON.stringify()` semantics apply

**Old:** in Fastify v5 the body was written by `fast-json-stringify`, which
had its own semantics for the exotic values.

**New:** the payload that reaches the serializer is a plain JavaScript value,
so the semantics of the native `JSON.stringify()` apply:

- a `BigInt` throws a `TypeError`;
- a `Date` is serialized as its ISO string;
- an `undefined` property is omitted;
- `NaN` and `Infinity` become `null`.

**Action:** none, but check the payloads that carry those values.

### The behaviour of the output side

#### The properties that the schema does not declare are stripped

**Old:** in Fastify v5 the fjs serializer removed the properties that the
response schema did not declare.

**New:** the output pool does the same, and it does it recursively: the nested
objects, and the objects inside the arrays, are stripped as well. The pool is
configured with `removeAdditional: true`, and the parity layer of the framework
declares `additionalProperties: false` exactly where the v5 serializer dropped
the extra properties: an object schema that declares no `additionalProperties`
drops the properties that it does not declare.

A schema that declares `additionalProperties: true` (or an
`additionalProperties` schema) is the exception: it **keeps** the properties
that it allows, and they reach the client. A schema that declares
`patternProperties` keeps the properties that match one of its patterns.

**Action:** check the response schemas that declare `additionalProperties`:
the properties that they allow are sent to the client.

#### A property-less object schema answers `{}`

**Old:** in Fastify v5 an object schema that declares no `properties` and no
`patternProperties` produced an empty object.

**New:** the behaviour is unchanged: a property-less object schema answers
`{}`, the properties of the payload are stripped, exactly as the v5 serializer
did.

**Action:** none.

#### The `null` payload is not validated

**Old:** in Fastify v5 the serializer answered an empty object for a `null`
payload.

**New:** the `null` payload is not validated, and the body is `null`.

**Action:** check the clients that expect an empty object for a `null`
payload.

#### A string payload is validated, but neither shaped nor serialized

**Old:** in Fastify v5 a string payload was sent as it was.

**New:** a string payload is validated against the response schema, but it is
neither shaped nor serialized: it reaches the wire exactly as the handler
produced it. A string that violates the response schema answers HTTP 500 with
the `FST_ERR_OUTPUT_VALIDATION` error.

**Action:** make sure that the strings your handlers return match the
response schema.

#### A custom serializer disables the response validation

**Old:** in Fastify v5 a reply that declared a custom serializer
(`reply.serializer(fn)` or `fastify.setReplySerializer(fn)`) was never shaped
by the response schema.

**New:** the behaviour is unchanged, and it now covers the validation too: a
reply that is handled by a custom serializer is never validated and never
shaped. The payload reaches the wire as it is.

**Action:** none.

### The error path

#### The error body is validated and shaped by the output pipeline

**Old:** in Fastify v5 the body of an error was shaped by the error schema of
the route, when the route declared one.

**New:** the error body is validated *and* shaped by the same output pipeline
when the route declares an error schema that matches the status code and the
content type of the answer. When nothing matches, the built-in error
serializer answers, exactly as before.

**Action:** check the error schemas of your routes: an error body that does
not satisfy its own schema is now an error (see the next entry).

#### An error body that violates its own schema answers HTTP 500

**Old:** in Fastify v5 an error body that did not match the error schema was
sent to the client as it was.

**New:** an error body that does not satisfy its own error schema answers HTTP
500 with the `FST_ERR_FAILED_ERROR_SERIALIZATION` error. The framework does
not recurse: the answer of that error is the built-in error serializer.

**Action:** make sure that the error bodies that your error handler produces
match the error schemas of your routes.

#### The error path does not await an asynchronous output schema

**Old:** in Fastify v5 the error body was serialized synchronously.

**New:** the error path does not await an asynchronous validator: an error
whose route declares an `$async` output schema is answered with the built-in
error serializer.

**Action:** do not declare an `$async` output schema on the routes that answer
errors.

#### The error schema that allows additional properties exposes the error

**Old:** in Fastify v5 the body of an error was shaped by the error schema of
the route, and the body carried the own enumerable properties of the error: an
error schema that allowed additional properties exposed them to the client.

**New:** the behaviour is unchanged: the body of an error carries the **own
enumerable properties** of the error object, so an error schema that declares
`additionalProperties: true` (or an `additionalProperties` schema) sends them
to the client. That is the Ajv `validation` array and the `validationContext`
property of a failed output validation, and every property that the
application attaches to the error. An error schema that declares no
`additionalProperties` drops them, exactly as the v5 serializer did.

**Action:** do not attach sensitive data to the errors of a route whose error
schema allows additional properties: declare the properties that the client
needs in the error schema instead.

### The removed serialization APIs

#### `reply.getSerializationFunction()`, `reply.compileSerializationSchema()` and `reply.serializeInput()` are removed

**Old:** in Fastify v5 the three helpers compiled a schema into a serializer
that the user could call.

**New:** the three helpers are removed. The response schema of the route does
the work: it validates and shapes the payload.

**Action:** remove the calls.

#### `fastify.setSerializerCompiler()` and the route level `serializerCompiler` are removed

**Old:** in Fastify v5 the serializer compiler built the function that wrote
the body of the answer.

**New:** the serializer compiler does not exist any more:
`fastify.setSerializerCompiler()`, the route level `serializerCompiler` option
and the `compilersFactory.buildSerializer` key all throw the
`FST_ERR_SERIALIZER_COMPILER_REMOVED` error. They are never silently ignored.

**Action:** remove them. The output side is configured through the
[`schemaController`](../Reference/Server.md#schema-controller) option.

#### The `serializerOpts` server option is removed

**Old:** in Fastify v5 the `serializerOpts` option configured the fjs
serializer (`rounding` and the other fjs specific options).

**New:** the option is removed: a server that declares it fails at boot with
the `FST_ERR_SERIALIZER_OPTS_REMOVED` error.

**Action:** remove it. The options of the output side live in
`schemaController.outputValidatorOptions`.

#### `reply.serialize(payload)` is still there

**Old:** in Fastify v5 `reply.serialize(payload)` compiled a serializer for the
payload.

**New:** `reply.serialize(payload)` survives as an alias of
`JSON.stringify(payload)`. It does not consult the route schema, the output
validator, the custom `reply.serializer(fn)` nor the route level
`replySerializer`.

**Action:** none.

### The renames

#### `compilersFactory.buildValidator` is renamed `compilersFactory.buildInputValidator`

**Old:** in Fastify v5 the input validator factory was the
`compilersFactory.buildValidator` key of the `schemaController` option.

**New:** the key is renamed `compilersFactory.buildInputValidator`. The old
key is a **hard error**: the server fails at startup with the
`FST_ERR_BUILD_VALIDATOR_RENAMED` error. The output side has its own key,
`compilersFactory.buildOutputValidator`.

**Action:** rename the key.

#### The top-level `ajv` option moves to `schemaController.inputValidatorOptions`

**Old:** in Fastify v5 the top-level `ajv` server option configured the Ajv
instance that validated the request.

**New:** the option still works, but it is deprecated: every server that uses
it emits the `FSTDEP026` deprecation warning. The equivalent configuration
now lives in `schemaController.inputValidatorOptions`, with the same content.

**Action:** move the option.

```js
// v5
const fastify = require('fastify')({
  ajv: {
    customOptions: { removeAdditional: 'all' },
    plugins: [require('ajv-merge-patch')]
  }
})
```

```js
// v6
const fastify = require('fastify')({
  schemaController: {
    inputValidatorOptions: {
      customOptions: { removeAdditional: 'all' },
      plugins: [require('ajv-merge-patch')]
    }
  }
})
```

#### `fastify.validatorCompiler` and `fastify.serializerCompiler` are renamed

**Old:** in Fastify v5 the instance accessors
`fastify.validatorCompiler` and `fastify.serializerCompiler` exposed the two
pools of the framework.

**New:** the accessors are renamed `fastify.inputValidatorCompiler` and
`fastify.outputValidatorCompiler`. The old `fastify.validatorCompiler` does
not exist any more: it answers `undefined`. The old
`fastify.serializerCompiler` still throws the
`FST_ERR_SERIALIZER_COMPILER_REMOVED` error: the removal of the fjs runtime
is not softened by the rename, so the output pool must be read through the
**new** accessor.

**Action:** rename the reads.

```js
// v5
const validator = fastify.validatorCompiler
const serializer = fastify.serializerCompiler
```

```js
// v6
const validator = fastify.inputValidatorCompiler
const output = fastify.outputValidatorCompiler
```

#### The `attachValidation` route option is renamed `attachRequestValidation`

**Old:** in Fastify v5 the `attachValidation` route option attached the
request validation errors to the request object, so that the handler could
handle them itself.

**New:** the option is renamed `attachRequestValidation`, and the errors are
attached exactly as before: the same request property
(`request.validationError`), the same content, and the same default (the
option is off unless the route declares it). The old name is **not** an
alias: with the old route option name the framework **answers the validation
error itself** (the standard HTTP 400 validation answer) instead of attaching
it to the request, so `request.validationError` is never set.

**Action:** rename the option.

```js
// v5
fastify.post('/', { schema, attachValidation: true }, (req, reply) => {
  if (req.validationError) {
    reply.code(400).send(req.validationError)
  }
})
```

```js
// v6
fastify.post('/', { schema, attachRequestValidation: true }, (req, reply) => {
  if (req.validationError) {
    reply.code(400).send(req.validationError)
  }
})
```

### The other changes of the milestone

#### The `preResponseValidation` hook is new

**Old:** in Fastify v5 the payload of the handler reached the serializer
directly.

**New:** the new `preResponseValidation` hook runs after the handler and
before the output validation, so that a hook can inspect or shape the payload
that is going to be validated. A hook that throws sends the error to the
standard error handler, and the validation is skipped for that request.

**Action:** none, it is an addition.

#### The `FST_ERR_MISSING_SERIALIZATION_FN` error code is removed

**Old:** in Fastify v5 the error catalogue declared the
`FST_ERR_MISSING_SERIALIZATION_FN` code.

**New:** the code is removed from the catalogue: the runtime does not raise it
any more.

**Action:** none, unless your code matched on that code.

#### The `FastifySerializerCompiler` type is not exported any more

**Old:** in Fastify v5 the types exported the `FastifySerializerCompiler`
type.

**New:** the type is not exported any more: the serializer compiler does not
exist.

**Action:** remove the import.

## New features

Fastify v6 does not only break things, it brings new ones:

- the **output validation**: the response schema validates the payload, and a
  payload that violates it answers HTTP 500 with the
  `FST_ERR_OUTPUT_VALIDATION` error;
- the **`preResponseValidation` hook**: a hook that runs between the handler
  and the output validation;
- the **two option families of the schema controller**:
  `schemaController.inputValidatorOptions` for the pool that validates the
  request, and `schemaController.outputValidatorOptions` for the pool that
  validates and shapes the response. The output pool is strict by default: it
  never coerces a type, never injects a default, and strips the properties
  that the response schema does not declare.

The [Validation and Serialization](../Reference/Validation-and-Serialization.md)
documentation describes the whole surface.
