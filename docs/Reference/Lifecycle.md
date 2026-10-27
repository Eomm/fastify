<h1 align="center">Fastify</h1>

## Lifecycle
<a id="lifecycle"></a>

This diagram shows the internal lifecycle of Fastify.

The right branch of each section shows the next phase of the lifecycle. The left
branch shows the corresponding error code generated if the parent throws an
error. All errors are automatically handled by Fastify.

```
Incoming Request
  │
  └─▶ Routing
        │
        └─▶ Instance Logger
             │
   4**/5** ◀─┴─▶ onRequest Hook
                  │
        4**/5** ◀─┴─▶ preParsing Hook
                        │
              4**/5** ◀─┴─▶ Parsing
                             │
                   4**/5** ◀─┴─▶ preValidation Hook
                                  │
                            400 ◀─┴─▶ Validation
                                        │
                              4**/5** ◀─┴─▶ preHandler Hook
                                              │
                                    4**/5** ◀─┴─▶ User Handler
                                                    │
                                                    └─▶ Reply
                                                          │
                                                4**/5** ◀─┴─▶ preResponseValidation Hook
                                                                │
                                                4**/5** ◀─┴─▶ Validation
                                                                │
                                                4**/5** ◀─┴─▶ preSerialization Hook
                                                                │
                                                                └─▶ onSend Hook
                                                                      │
                                                            4**/5** ◀─┴─▶ Outgoing Response
                                                                            │
                                                                            └─▶ onResponse Hook
```

The response payload is validated against the route's `schema.response` between
the `preResponseValidation` hook and the `preSerialization` hook. A reply that
is handled by a custom reply serializer skips that validation step: the custom
serializer owns the wire format.

A `string` payload is validated too, but it is neither shaped nor serialized:
it reaches the wire as the handler produced it, and a string that violates the
response schema answers HTTP 500 with the `FST_ERR_OUTPUT_VALIDATION` error.

When [`handlerTimeout`](./Server.md#factory-handler-timeout) is configured, a
timer starts after routing. If the response is not sent within the allowed time,
`request.signal` is aborted and a `503 Service Unavailable` error is sent.
The timer is cancelled when the response completes
or when `reply.hijack()` is called.

Before or during the `User Handler`, `reply.hijack()` can be called to:
- Prevent Fastify from running subsequent hooks and the user handler
- Prevent Fastify from sending the response automatically

If `reply.raw` is used to send a response, `onResponse` hooks will still
be executed.

## Reply Lifecycle
<a id="reply-lifecycle"></a>

When the user handles the request, the result may be:

- In an async handler: it returns a payload or throws an `Error`
- In a sync handler: it sends a payload or an `Error` instance

If the reply is hijacked, all subsequent steps are skipped.
Otherwise, the data flows as follows:

```
                        ★ schema validation Error
                                    │
                                    └─▶ schemaErrorFormatter
                                               │
                          reply sent ◀── JSON ─┴─ Error instance
                                                      │
                                                      │         ★ throw an Error
                     ★ send or return                 │                 │
                            │                         │                 │
                            │                         ▼                 │
       reply sent ◀── JSON ─┴─ Error instance ──▶ onError Hook ◀───────┘
                                                      │
                                 reply sent ◀── JSON ─┴─ Error instance ──▶ setErrorHandler
                                                                                │
                                                                                └─▶ reply sent
```

`reply sent` means the JSON payload will be serialized by one of the following:
- The [reply serializer](./Server.md#setreplyserializer) if set
- The [serializer compiler](./Server.md#setserializercompiler) if a JSON schema
  is set for the HTTP status code
- The default `JSON.stringify` function

## Shutdown Lifecycle
<a id="shutdown-lifecycle"></a>

When [`fastify.close()`](./Server.md#close) is called, the server goes through a
graceful shutdown sequence involving
[`preClose`](./Hooks.md#pre-close) hooks, connection draining, and
[`onClose`](./Hooks.md#on-close) hooks. See the
[`close`](./Server.md#close) method documentation for the full step-by-step
lifecycle.
