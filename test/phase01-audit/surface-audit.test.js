'use strict'

// Independent audit of the *static* claims of the phase 1 plans: the typed
// surface, the complete registration of the `preResponseValidation` hook and
// the documentation of the hook and of the new response pipeline order.
//
// These are textual checks: the claims they cover are claims about the
// presence of a declaration, a registration or a paragraph of documentation.
// The behavioural counterpart of every one of them lives in
// `runtime-audit.test.js`.

const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

// ---------------------------------------------------------------------------
// 01-03 / task 1 — the typed surface
// ---------------------------------------------------------------------------

test('01-03/T1: types/schema.d.ts declares the output side option surface', (t) => {
  const source = read('types/schema.d.ts')

  t.assert.match(
    source,
    /outputValidatorOptions\?\s*:\s*FastifyOutputValidatorOptions/,
    'the outputValidatorOptions option is declared'
  )
  t.assert.match(
    source,
    /buildOutputValidator\?\s*:\s*BuildCompilerFromPool/,
    'the buildOutputValidator factory slot is declared'
  )
  t.assert.match(
    source,
    /export type SchemaErrorDataVar\s*=\s*'body'\s*\|\s*'headers'\s*\|\s*'params'\s*\|\s*'querystring'\s*\|\s*'response'/,
    "the 'response' member of the validation context union is declared"
  )
})

test('01-03/T1: fastify.d.ts declares the same output side option surface', (t) => {
  const source = read('fastify.d.ts')

  t.assert.match(
    source,
    /outputValidatorOptions\?\s*:\s*FastifyOutputValidatorOptions/,
    'the outputValidatorOptions option is declared'
  )
  t.assert.match(
    source,
    /buildOutputValidator\?\s*:\s*BuildCompilerFromPool/,
    'the buildOutputValidator factory slot is declared'
  )
})

test('01-03/T1: the type level tests exercise the new surface', (t) => {
  const source = read('test/types/schema.tst.ts')

  t.assert.match(source, /outputValidatorOptions/, 'the type test covers outputValidatorOptions')
  t.assert.match(source, /buildOutputValidator/, 'the type test covers buildOutputValidator')
  t.assert.match(
    source,
    /SchemaErrorDataVar/,
    'the type test covers the validation context union'
  )
})

// ---------------------------------------------------------------------------
// 01-04 / task 1 — the complete registration of the hook
// ---------------------------------------------------------------------------

test('01-04/T1: lib/hooks.js registers preResponseValidation in the four places', (t) => {
  const source = read('lib/hooks.js')

  t.assert.match(
    source,
    /lifecycleHooks\s*=\s*\[[\s\S]*?'preResponseValidation'/,
    'the hook name is in the lifecycleHooks table'
  )
  t.assert.match(
    source,
    /this\.preResponseValidation\s*=\s*\[\]/,
    'the hook is initialised in the Hooks constructor'
  )
  t.assert.match(
    source,
    /hooks\.preResponseValidation\s*=\s*h\.preResponseValidation\.slice\(\)/,
    'the hook is copied in buildHooks'
  )
  t.assert.match(
    source,
    /preResponseValidationHookRunner/,
    'the runner is exported'
  )
})

test('01-04/T1: lib/hooks.js exports a callable preResponseValidationHookRunner', (t) => {
  const hooks = require('../../lib/hooks')
  t.assert.strictEqual(typeof hooks.preResponseValidationHookRunner, 'function')
})

test('01-04/T1: lib/context.js initialises the preResponseValidation slot', (t) => {
  const source = read('lib/context.js')
  t.assert.match(source, /this\.preResponseValidation\s*=\s*null/)
})

test('01-04/T1: lib/route.js and fastify.js ban the four argument async form', (t) => {
  const route = read('lib/route.js')
  const fastify = read('fastify.js')

  t.assert.match(
    route,
    /hook === 'preResponseValidation'/,
    'the per route arity ban mentions the hook'
  )
  t.assert.match(
    fastify,
    /name === 'preResponseValidation'/,
    'the instance level arity ban mentions the hook'
  )
})

test('01-04/T1: the hook types are declared in types/hooks.d.ts and types/instance.d.ts', (t) => {
  const hooks = read('types/hooks.d.ts')
  const instance = read('types/instance.d.ts')

  t.assert.match(hooks, /export interface preResponseValidationHookHandler</)
  t.assert.match(hooks, /export interface preResponseValidationAsyncHookHandler</)
  t.assert.match(hooks, /export type preResponseValidationMetaHookHandler</)
  t.assert.match(hooks, /\|\s*'preResponseValidation'/, 'the LifecycleHook union has the hook')
  t.assert.match(hooks, /K extends 'preResponseValidation'/, 'the lookup maps have the hook')
  t.assert.match(instance, /name: 'preResponseValidation'/, 'the addHook overload has the hook')
})

test('01-04/T1: the type level tests exercise the hook', (t) => {
  const source = read('test/types/hooks.tst.ts')
  t.assert.match(source, /addHook<TestPayloadType>\('preResponseValidation'/)
  t.assert.match(source, /addHook<TestPayloadType>\('preResponseValidation', async function/)
})

// ---------------------------------------------------------------------------
// 01-04 / task 3 — the documentation
// ---------------------------------------------------------------------------

test('01-04/T3: docs/Reference/Hooks.md documents the preResponseValidation hook', (t) => {
  const source = read('docs/Reference/Hooks.md')

  t.assert.match(
    source,
    /\n {2}- \[preResponseValidation\]\(#preresponsevalidation\)/,
    'the table of contents has the entry'
  )
  t.assert.match(source, /### preResponseValidation/, 'the reference has the section')
  t.assert.match(
    source,
    /reply\.serializer\(/,
    'the section mentions the custom reply serializer'
  )
})

test('01-04/T3: docs/Reference/Hooks.md states that a custom reply serializer disables the response validation', (t) => {
  const source = read('docs/Reference/Hooks.md')
  const section = source.slice(source.indexOf('### preResponseValidation'))

  t.assert.match(
    section,
    /disables?[^.]*validation|validation[^.]*disabled/i,
    'the section states that the custom reply serializer disables the response validation'
  )
})

test('01-04/T3: docs/Reference/Lifecycle.md shows the new response pipeline order', (t) => {
  const source = read('docs/Reference/Lifecycle.md')

  t.assert.match(source, /preResponseValidation Hook/, 'the diagram has the hook')
  t.assert.match(
    source,
    /preResponseValidation Hook[\s\S]{0,200}?Validation/,
    'the response branch runs the hook before the validation'
  )
  t.assert.match(
    source,
    /Validation[\s\S]{0,200}?preSerialization Hook/,
    'the response branch runs the validation before the preSerialization hook'
  )
})
