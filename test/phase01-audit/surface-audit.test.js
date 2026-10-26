'use strict'

// Independent audit of the *static* claims of the phase 1 plans: the typed
// output side configuration surface.
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
    /outputValidatorOptions\?\s*:\s*Parameters<BuildCompilerFromPool>\[1\]/,
    'the outputValidatorOptions option is declared'
  )
  t.assert.match(
    source,
    /buildOutputValidator\?\s*:\s*ValidatorFactory/,
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
    /outputValidatorOptions\?\s*:\s*Parameters<BuildCompilerFromPool>\[1\]/,
    'the outputValidatorOptions option is declared'
  )
  t.assert.match(
    source,
    /buildOutputValidator\?\s*:\s*ValidatorFactory/,
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
