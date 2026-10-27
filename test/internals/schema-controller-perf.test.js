const { sep } = require('node:path')
const { test } = require('node:test')
const Fastify = require('../../fastify')
const { kSchemaController } = require('../../lib/symbols')

test('SchemaController are NOT loaded when the controllers are custom', async t => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildInputValidator: () => () => { }
      }
    }
  })

  await app.ready()

  const loaded = Object.keys(require.cache)
  const ajvModule = loaded.find((path) => path.includes(`@fastify${sep}ajv-compiler`))

  t.assert.equal(ajvModule, undefined, 'Ajv compiler is not loaded')
})

test('the serializer compiler factory is rejected: it is not supported any more', async t => {
  t.assert.throws(
    () => Fastify({
      schemaController: {
        compilersFactory: {
          buildSerializer: () => () => { }
        }
      }
    }),
    { code: 'FST_ERR_SERIALIZER_COMPILER_REMOVED' }
  )
})

test('the input validator factory key is rejected: it has been renamed', async t => {
  t.assert.throws(
    () => Fastify({
      schemaController: {
        compilersFactory: {
          buildValidator: () => () => { }
        }
      }
    }),
    { code: 'FST_ERR_BUILD_VALIDATOR_RENAMED' }
  )
})

test('isCustomValidatorCompiler flag is set correctly when only buildInputValidator is provided', async t => {
  const app = Fastify({
    schemaController: {
      compilersFactory: {
        buildInputValidator: () => () => { }
      }
    }
  })

  await app.ready()

  const schemaController = app[kSchemaController]
  t.assert.equal(schemaController.isCustomValidatorCompiler, true, 'isCustomValidatorCompiler should be true')
  // The serializer compiler is gone with `fast-json-stringify`: the flag and
  // the state it described do not exist any more.
  t.assert.equal(schemaController.isCustomSerializerCompiler, undefined, 'isCustomSerializerCompiler does not exist any more')
})

test('SchemaController are loaded when the controllers are not custom', async t => {
  const app = Fastify()
  await app.ready()

  const loaded = Object.keys(require.cache)
  const ajvModule = loaded.find((path) => path.includes(`@fastify${sep}ajv-compiler`))

  t.after(() => {
    delete require.cache[ajvModule]
  })

  t.assert.ok(ajvModule, 'Ajv compiler is loaded')
})
