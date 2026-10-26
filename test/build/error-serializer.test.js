'use strict'

const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { loadESLint } = require('eslint')

const { code } = require('../../build/build-error-serializer')
const upstreamPackage = require('fast-json-stringify/package.json')

function unifyLineBreak (str) {
  return str.toString().replace(/\r\n/g, '\n')
}

function collectRequires (source) {
  const requires = []
  const pattern = /require\((['"])(.*?)\1\)/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    requires.push(match[2])
  }
  return requires
}

test('check generated code syntax', async (t) => {
  t.plan(1)

  // standard is a esm, we import it like this
  const Eslint = await loadESLint({ useFlatConfig: true })
  const eslint = new Eslint()
  const result = await eslint.lintText(code)

  // if there are any invalid syntax
  // fatal count will be greater than 0
  t.assert.strictEqual(result[0].fatalErrorCount, 0)
})

test('the generated code requires nothing outside the repository', async (t) => {
  const current = await fs.promises.readFile(path.resolve('lib/error-serializer.js'), 'utf8')
  const sources = [code, current]
  const requires = sources.flatMap(collectRequires)

  t.plan(requires.length + sources.length)

  // every `require` of the generated module must be a relative path: the
  // module must not load anything from `node_modules`
  for (const required of requires) {
    t.assert.ok(
      required.startsWith('.'),
      `the generated error serializer must not require '${required}'`
    )
  }

  for (const source of sources) {
    t.assert.ok(
      !source.includes("require('fast-json-stringify"),
      'the generated error serializer must not require fast-json-stringify'
    )
  }
})

test('the generated code carries the upstream attribution', async (t) => {
  t.plan(4)

  // the version is read from the installed package: the header is never stale
  t.assert.ok(code.includes('fast-json-stringify'))
  t.assert.ok(code.includes(upstreamPackage.version))
  t.assert.ok(code.includes(upstreamPackage.license))
  t.assert.ok(code.includes('do not edit'))
})

test('the built-in error serializer answers the expected body', async (t) => {
  t.plan(1)

  const serializeError = require('../../lib/error-serializer')

  t.assert.strictEqual(
    serializeError({
      statusCode: 500,
      code: 'FST_ERR_TEST',
      error: 'Internal Server Error',
      message: 'boom'
    }),
    '{"statusCode":500,"code":"FST_ERR_TEST","error":"Internal Server Error","message":"boom"}'
  )
})

const isPrepublish = !!process.env.PREPUBLISH

test('ensure the current error serializer is latest', { skip: !isPrepublish }, async (t) => {
  t.plan(1)

  const current = await fs.promises.readFile(path.resolve('lib/error-serializer.js'))

  // line break should not be a problem depends on system
  t.assert.strictEqual(unifyLineBreak(current), unifyLineBreak(code))
})
