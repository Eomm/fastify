'use strict'

const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

/**
 * The documentation contract of the Phase 3.
 *
 * The documentation of the milestone is read by the users that migrate: the
 * guide and the reference document must describe the surface that the runtime
 * exposes. The proofs of the documentation used to be ad-hoc `node -e`
 * one-liners, which no CI run executes: they are committed here, so that a
 * drift of the prose fails the test suite.
 *
 * The assertions check the **presence** of the entries, not their exact
 * wording: the prose of a document is free to change, the surfaces it
 * describes are not.
 */

const guide = readFileSync(
  resolve(__dirname, '../../docs/Guides/Migration-Guide-V6.md'),
  'utf8'
)
const guidesIndex = readFileSync(
  resolve(__dirname, '../../docs/Guides/Index.md'),
  'utf8'
)
const reference = readFileSync(
  resolve(__dirname, '../../docs/Reference/Validation-and-Serialization.md'),
  'utf8'
)
const server = readFileSync(
  resolve(__dirname, '../../docs/Reference/Server.md'),
  'utf8'
)
const reply = readFileSync(
  resolve(__dirname, '../../docs/Reference/Reply.md'),
  'utf8'
)
const routes = readFileSync(
  resolve(__dirname, '../../docs/Reference/Routes.md'),
  'utf8'
)
const typeProviders = readFileSync(
  resolve(__dirname, '../../docs/Reference/Type-Providers.md'),
  'utf8'
)
const request = readFileSync(
  resolve(__dirname, '../../docs/Reference/Request.md'),
  'utf8'
)

/**
 * The reference documents that document the removed serialization APIs.
 */
const referenceDocuments = [
  ['Validation and Serialization', reference],
  ['Reply', reply],
  ['Routes', routes],
  ['Type Providers', typeProviders]
]

/**
 * The serialization APIs that Fastify v6 removed.
 */
const removedApis = [
  'getSerializationFunction',
  'compileSerializationSchema',
  'serializeInput',
  'setSerializerCompiler',
  'serializerOpts',
  'buildSerializer'
]

/**
 * Extracts the section of a document that a heading opens.
 *
 * The section starts at the heading and ends at the next heading of the same
 * level or of a higher one. The result carries the text of the section and
 * the text of the rest of the document, so that a caller can assert where a
 * symbol is documented.
 *
 * @param {string} document the document
 * @param {string} heading the text of the heading
 * @returns {?{text: string, outside: string}} the section of the document,
 *   `null` when the document has no such heading
 */
function sectionOf (document, heading) {
  const match = new RegExp(`^(#{1,6})\\s+${heading}\\s*$`, 'm').exec(document)
  if (match === null) {
    return null
  }

  const level = match[1].length
  const start = match.index + match[0].length
  const rest = document.slice(start)
  const next = rest.search(new RegExp(`^#{1,${level}}\\s`, 'm'))
  const end = next === -1 ? document.length : start + next

  return {
    text: document.slice(start, end),
    outside: document.slice(0, start) + document.slice(end)
  }
}

/**
 * Extracts the code block that follows an anchor of a document.
 *
 * @param {string} document the document
 * @param {string} anchor the text that precedes the block
 * @returns {string} the content of the block, the empty string when the
 *   anchor is not in the document
 */
function codeBlockAfter (document, anchor) {
  const anchorIndex = document.indexOf(anchor)
  if (anchorIndex === -1) {
    return ''
  }
  const rest = document.slice(anchorIndex)
  const start = rest.indexOf('```')
  if (start === -1) {
    return ''
  }
  const end = rest.indexOf('```', start + 3)
  if (end === -1) {
    return ''
  }
  return rest.slice(start, end)
}

/**
 * Extracts the code blocks of a document.
 *
 * @param {string} document the document
 * @returns {Array<string>} the content of the blocks
 */
function codeBlocks (document) {
  return document.match(/```[\s\S]*?```/g) || []
}

/**
 * Extracts the prose of a document: its text, without its code blocks.
 *
 * @param {string} document the document
 * @returns {string} the prose of the document
 */
function proseOf (document) {
  return document.replace(/```[\s\S]*?```/g, '')
}

/**
 * Extracts the section of a code block that configures an option.
 *
 * The section starts at the line that declares the option and ends at the
 * next line that declares another option of the same level.
 *
 * @param {string} block the code block
 * @param {string} property the name of the option
 * @returns {string} the content of the section, the empty string when the
 *   block does not configure the option
 */
function optionSection (block, property) {
  const declaration = new RegExp(`^ {4}${property}:`, 'm')
  const start = block.search(declaration)
  if (start === -1) {
    return ''
  }
  const rest = block.slice(start)
  // The first line is skipped: the declaration itself must not end the
  // section.
  const end = rest.slice(1).search(/^ {4}\w/m)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

test('the V5 to V6 migration guide exists and is not empty', (t) => {
  t.assert.ok(guide.length > 0)
})

test('the migration guide is listed in the index of the guides', (t) => {
  t.assert.ok(guidesIndex.includes('Migration-Guide-V6.md'))
})

test('every entry of the migration guide states the old surface, the new surface and the action', (t) => {
  const headings = guide.match(/^#### /gm) || []
  const olds = guide.match(/^\*\*Old:\*\*/gm) || []
  const news = guide.match(/^\*\*New:\*\*/gm) || []
  const actions = guide.match(/^\*\*Action:\*\*/gm) || []

  t.assert.ok(headings.length > 0)
  t.assert.strictEqual(olds.length, headings.length)
  t.assert.strictEqual(news.length, headings.length)
  t.assert.strictEqual(actions.length, headings.length)
})

test('the migration guide lists the four renames of the milestone', (t) => {
  const renames = [
    // `compilersFactory.buildValidator` -> `compilersFactory.buildInputValidator`
    'compilersFactory.buildValidator',
    'compilersFactory.buildInputValidator',
    // the top-level `ajv` option -> `schemaController.inputValidatorOptions`
    'schemaController.inputValidatorOptions',
    // `fastify.validatorCompiler` -> `fastify.inputValidatorCompiler`
    'fastify.validatorCompiler',
    'fastify.inputValidatorCompiler',
    'fastify.outputValidatorCompiler',
    // `attachValidation` -> `attachRequestValidation`
    'attachValidation',
    'attachRequestValidation'
  ]

  for (const rename of renames) {
    t.assert.ok(guide.includes(rename), rename)
  }
})

test('the migration guide lists the changes of the output side', (t) => {
  const changes = [
    // the output validation and its error
    'FST_ERR_OUTPUT_VALIDATION',
    // the strict defaults of the output pool
    'useDefaults: false',
    'coerceTypes: false',
    'removeAdditional: true',
    'strict: false',
    // the shaping of the payload
    'additionalProperties',
    // the hook of the new pipeline
    'preResponseValidation',
    // the removed serialization surfaces
    'FST_ERR_SERIALIZER_COMPILER_REMOVED'
  ]

  for (const change of changes) {
    t.assert.ok(guide.includes(change), change)
  }
})

test('the migration guide does not publish an output default that the runtime does not use', (t) => {
  // The output pool of the runtime is configured with `removeAdditional:
  // true` and the parity layer shapes the payload. The value `'all'` is a
  // valid choice for the **input** pool, whose options the user configures:
  // it must not be published as the default of the output side.
  t.assert.ok(
    !proseOf(guide).includes("removeAdditional: 'all'"),
    'the guide publishes an output default that the runtime does not use'
  )

  for (const block of codeBlocks(guide)) {
    const configuresTheInputPool = block.includes('inputValidatorOptions') ||
      block.includes('ajv:')
    if (configuresTheInputPool) {
      continue
    }
    t.assert.ok(
      !block.includes("removeAdditional: 'all'"),
      'the guide configures the output pool with a default that the runtime does not use'
    )
  }
})

test('the reference document declares the output defaults of the runtime', (t) => {
  const defaults = codeBlockAfter(reference, 'The output pool is **strict by default**')

  t.assert.ok(defaults.includes('removeAdditional: true'))
  t.assert.ok(!defaults.includes("removeAdditional: 'all'"))
  t.assert.ok(defaults.includes('useDefaults: false'))
  t.assert.ok(defaults.includes('coerceTypes: false'))
  t.assert.ok(defaults.includes('strict: false'))
})

test('the reference document describes the two option families and the error path', (t) => {
  const surfaces = [
    'inputValidatorOptions',
    'outputValidatorOptions',
    'FST_ERR_OUTPUT_VALIDATION',
    'attachRequestValidation',
    // the properties of an error that reach the client
    'own enumerable properties'
  ]

  for (const surface of surfaces) {
    t.assert.ok(reference.includes(surface), surface)
  }
})

test('the reference documents that publish the renamed route option publish its v5 name and the guide', (t) => {
  const documents = [
    ['Request', request],
    ['Routes', routes],
    ['Validation and Serialization', reference]
  ]

  for (const [name, document] of documents) {
    if (!document.includes('attachRequestValidation')) {
      continue
    }

    t.assert.ok(
      document.includes('attachValidation'),
      `${name}: the renamed route option does not publish its v5 name`
    )
    t.assert.ok(
      document.includes('Migration-Guide-V6.md'),
      `${name}: the renamed route option does not link to the migration guide`
    )
  }
})

test('the section extractor reads the section of a heading and reports its absence', (t) => {
  const document = '# Title\n\n## First\n\ntext\n\n## Second\n\nmore text\n'

  const section = sectionOf(document, 'Second')
  t.assert.notStrictEqual(section, null)
  t.assert.ok(section.text.includes('more text'))
  t.assert.ok(!section.text.includes('text\n\n## First'))
  t.assert.ok(section.outside.includes('## First'))

  t.assert.strictEqual(sectionOf(document, 'Third'), null)
})

test('the removed serialization APIs appear only inside the "Removed in v6" section', (t) => {
  const documented = new Set()

  for (const [name, document] of referenceDocuments) {
    const section = sectionOf(document, 'Removed in v6')
    t.assert.notStrictEqual(section, null, `${name}: the "Removed in v6" section is missing`)

    for (const api of removedApis) {
      const pattern = new RegExp(`\\b${api}\\b`)

      if (pattern.test(section.text)) {
        documented.add(api)
      }

      t.assert.ok(
        !pattern.test(section.outside),
        `${name}: the removed API \`${api}\` is presented outside the "Removed in v6" section`
      )
    }
  }

  for (const api of removedApis) {
    t.assert.ok(
      documented.has(api),
      `the removed API \`${api}\` is not documented in a "Removed in v6" section`
    )
  }
})

test('the server reference publishes the default of the output pool of the runtime', (t) => {
  // The output pool of the runtime is configured with `removeAdditional:
  // true` and the parity layer shapes the payload. The value `'all'` is a
  // valid choice for the **input** pool, whose options the user configures:
  // it must not be published as the default of the output side.
  const sections = codeBlocks(server)
    .map((block) => optionSection(block, 'outputValidatorOptions'))
    .filter((section) => section !== '')

  t.assert.ok(sections.length > 0, 'the server reference has no output pool example')

  for (const section of sections) {
    t.assert.ok(
      !section.includes("removeAdditional: 'all'"),
      'the server reference configures the output pool with a default that the runtime does not use'
    )
    t.assert.ok(
      section.includes('removeAdditional: true'),
      'the server reference does not publish the default of the output pool'
    )
    t.assert.ok(
      section.includes('strict: false'),
      'the server reference does not publish the lint default of the output pool'
    )
  }
})
