'use strict'

const { buildSchemas } = require('./schemas')

/**
 * The strict defaults of the output Ajv pool.
 *
 * The output side validates *and* shapes the response payload, so the defaults
 * differ from the input side ones:
 *
 * - `useDefaults: false` — a schema default must never be injected into a
 *   response payload.
 * - `coerceTypes: false` — a response value is never coerced into another type.
 * - `removeAdditional: 'all'` — the properties that are not in the schema are
 *   stripped, reproducing what `fast-json-stringify` does today. It must be
 *   the string `'all'`: `true` does not drop the extra keys.
 * - `allErrors: false` — a single error is enough to reject the payload.
 * - `strict: false` — a schema lint switch only. `fast-json-stringify` never
 *   linted the response schemas, so the output side must not reject a schema
 *   for carrying an unknown or an annotation keyword (`example`,
 *   `discriminator`, ...) or for omitting `type`. It does not weaken the four
 *   data options above. A user can turn the lint back on through
 *   `schemaController.outputValidatorOptions.customOptions.strict`.
 */
const outputValidatorDefaults = {
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: 'all',
  allErrors: false,
  strict: false
}

/**
 * Builds the default factory of the output validator.
 *
 * The factory receives the external schemas and the user provided
 * `outputValidatorOptions` and returns the compiler of the response schemas.
 * The Ajv instance is created once, when the pool is built, and it is never
 * created per response.
 *
 * @returns {function} the default `buildOutputValidator` factory
 */
function buildDefaultOutputValidatorFactory () {
  // The Ajv compiler is required lazily, so that a server that provides its
  // own factories does not load it at all.
  let buildCompilerFromPool = null
  return function buildOutputValidator (externalSchemas, outputValidatorOptions) {
    if (buildCompilerFromPool === null) {
      const ValidatorSelector = require('@fastify/ajv-compiler')
      buildCompilerFromPool = ValidatorSelector()
    }
    const options = outputValidatorOptions || {}
    return buildCompilerFromPool(externalSchemas, {
      customOptions: Object.assign({}, outputValidatorDefaults, options.customOptions),
      plugins: options.plugins
    })
  }
}

/**
 * Called at every fastify context that is being created.
 * @param {object} parentSchemaCtrl: the SchemaController instance of the Fastify parent context
 * @param {object} opts: the `schemaController` server option. It can be undefined when a parentSchemaCtrl is set
 * @return {object}:a new SchemaController
 */
function buildSchemaController (parentSchemaCtrl, opts) {
  if (parentSchemaCtrl) {
    return new SchemaController(parentSchemaCtrl, opts)
  }

  const compilersFactory = Object.assign({
    buildValidator: null,
    buildSerializer: null,
    buildOutputValidator: null
  }, opts?.compilersFactory)

  if (!compilersFactory.buildValidator) {
    const ValidatorSelector = require('@fastify/ajv-compiler')
    compilersFactory.buildValidator = ValidatorSelector()
  }
  if (!compilersFactory.buildSerializer) {
    const SerializerSelector = require('@fastify/fast-json-stringify-compiler')
    compilersFactory.buildSerializer = SerializerSelector()
  }
  if (!compilersFactory.buildOutputValidator) {
    compilersFactory.buildOutputValidator = buildDefaultOutputValidatorFactory()
  }

  const option = {
    bucket: (opts && opts.bucket) || buildSchemas,
    compilersFactory,
    isCustomValidatorCompiler: typeof opts?.compilersFactory?.buildValidator === 'function',
    isCustomSerializerCompiler: typeof opts?.compilersFactory?.buildSerializer === 'function',
    isCustomOutputValidatorCompiler: typeof opts?.compilersFactory?.buildOutputValidator === 'function'
  }

  return new SchemaController(undefined, option)
}

class SchemaController {
  constructor (parent, options) {
    this.opts = options || parent?.opts
    this.addedSchemas = false

    this.compilersFactory = this.opts.compilersFactory

    if (parent) {
      this.schemaBucket = this.opts.bucket(parent.getSchemas())
      // The output side keeps its own bucket: the input and the output
      // documents are stored separately.
      this.outputSchemaBucket = this.opts.bucket(parent.getOutputSchemas())
      this.validatorCompiler = parent.getValidatorCompiler()
      this.serializerCompiler = parent.getSerializerCompiler()
      this.outputValidatorCompiler = parent.getOutputValidatorCompiler()
      this.isCustomValidatorCompiler = parent.isCustomValidatorCompiler
      this.isCustomSerializerCompiler = parent.isCustomSerializerCompiler
      this.isCustomOutputValidatorCompiler = parent.isCustomOutputValidatorCompiler
      this.parent = parent
    } else {
      this.schemaBucket = this.opts.bucket()
      this.outputSchemaBucket = this.opts.bucket()
      this.isCustomValidatorCompiler = this.opts.isCustomValidatorCompiler || false
      this.isCustomSerializerCompiler = this.opts.isCustomSerializerCompiler || false
      this.isCustomOutputValidatorCompiler = this.opts.isCustomOutputValidatorCompiler || false
    }
  }

  // Bucket interface
  add (schema) {
    this.addedSchemas = true
    return this.schemaBucket.add(schema)
  }

  getSchema (schemaId) {
    return this.schemaBucket.getSchema(schemaId)
  }

  getSchemas () {
    return this.schemaBucket.getSchemas()
  }

  /**
   * The documents of the output side. They are stored in a bucket of their
   * own: the input and the output sides never share their storage.
   *
   * @returns {object} the output schemas
   */
  getOutputSchemas () {
    return this.outputSchemaBucket.getSchemas()
  }

  setValidatorCompiler (validatorCompiler) {
    // Set up as if the fixed validator compiler had been provided
    // by a custom 'options.compilersFactory.buildValidator' that
    // always returns the same compiler object. This is required because:
    //
    // - setValidatorCompiler must immediately install a compiler to preserve
    //   legacy behavior
    // - setupValidator will recreate compilers from builders in some
    //   circumstances, so we have to install this adapter to make it
    //   behave the same if the legacy API is used
    //
    // The cloning of the compilersFactory object is necessary because
    // we are aliasing the parent compilersFactory if none was provided
    // to us (see constructor.)
    this.compilersFactory = Object.assign(
      {},
      this.compilersFactory,
      { buildValidator: () => validatorCompiler })
    this.validatorCompiler = validatorCompiler
    this.isCustomValidatorCompiler = true
  }

  setSerializerCompiler (serializerCompiler) {
    // Set up as if the fixed serializer compiler had been provided
    // by a custom 'options.compilersFactory.buildSerializer' that
    // always returns the same compiler object. This is required because:
    //
    // - setSerializerCompiler must immediately install a compiler to preserve
    //   legacy behavior
    // - setupSerializer will recreate compilers from builders in some
    //   circumstances, so we have to install this adapter to make it
    //   behave the same if the legacy API is used
    //
    // The cloning of the compilersFactory object is necessary because
    // we are aliasing the parent compilersFactory if none was provided
    // to us (see constructor.)
    this.compilersFactory = Object.assign(
      {},
      this.compilersFactory,
      { buildSerializer: () => serializerCompiler })
    this.serializerCompiler = serializerCompiler
    this.isCustomSerializerCompiler = true
  }

  getValidatorCompiler () {
    return this.validatorCompiler || (this.parent && this.parent.getValidatorCompiler())
  }

  getSerializerCompiler () {
    return this.serializerCompiler || (this.parent && this.parent.getSerializerCompiler())
  }

  getSerializerBuilder () {
    return this.compilersFactory.buildSerializer || (this.parent && this.parent.getSerializerBuilder())
  }

  getValidatorBuilder () {
    return this.compilersFactory.buildValidator || (this.parent && this.parent.getValidatorBuilder())
  }

  getOutputValidatorCompiler () {
    return this.outputValidatorCompiler || (this.parent && this.parent.getOutputValidatorCompiler())
  }

  getOutputValidatorBuilder () {
    return this.compilersFactory.buildOutputValidator || (this.parent && this.parent.getOutputValidatorBuilder())
  }

  /**
   * This method will be called when a validator must be setup.
   * Do not setup the compiler more than once
   * @param {object} serverOptions the fastify server options
   */
  setupValidator (serverOptions) {
    const isReady = this.validatorCompiler !== undefined && !this.addedSchemas
    if (isReady) {
      return
    }
    this.validatorCompiler = this.getValidatorBuilder()(this.schemaBucket.getSchemas(), serverOptions.ajv)
  }

  /**
   * This method will be called when a serializer must be setup.
   * Do not setup the compiler more than once
   * @param {object} serverOptions the fastify server options
   */
  setupSerializer (serverOptions) {
    const isReady = this.serializerCompiler !== undefined && !this.addedSchemas
    if (isReady) {
      return
    }

    this.serializerCompiler = this.getSerializerBuilder()(this.schemaBucket.getSchemas(), serverOptions.serializerOpts)
  }

  /**
   * This method will be called when an output validator must be setup.
   * Do not setup the compiler more than once
   * @param {object} serverOptions the fastify server options
   */
  setupOutputValidator (serverOptions) {
    const isReady = this.outputValidatorCompiler !== undefined && !this.addedSchemas
    if (isReady) {
      return
    }

    // The pool is seeded with the shared schema documents, so that a response
    // schema referencing an id published through `fastify.addSchema` resolves
    // in the output pool too. The seeding is a read only copy of the
    // documents: the buckets keep their own storage.
    const externalSchemas = Object.assign({}, this.getSchemas(), this.getOutputSchemas())
    this.outputValidatorCompiler = this.getOutputValidatorBuilder()(
      externalSchemas,
      serverOptions?.schemaController?.outputValidatorOptions
    )
  }
}

SchemaController.buildSchemaController = buildSchemaController
module.exports = SchemaController
