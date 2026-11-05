'use strict'

const { buildSchemas } = require('./schemas')
const { applyFjsObjectParity } = require('./output-schema-parity')
const { FST_ERR_SERIALIZER_COMPILER_REMOVED, FST_ERR_BUILD_VALIDATOR_RENAMED } = require('./errors')

/**
 * The strict defaults of the output Ajv pool.
 *
 * The output side validates *and* shapes the response payload, so the defaults
 * differ from the input side ones:
 *
 * - `useDefaults: false` — a schema default must never be injected into a
 *   response payload.
 * - `coerceTypes: false` — a response value is never coerced into another type.
 * - `removeAdditional: true` — the properties that the schema does not
 *   describe are stripped, reproducing what `fast-json-stringify` does today.
 *   The option removes a property only where the schema declares
 *   `additionalProperties: false`, and the parity transform of
 *   `lib/output-schema-parity.js` declares it exactly where fjs dropped the
 *   extra properties. The string `'all'` cannot be used: it removes every
 *   additional property, even the ones that an `additionalProperties: <schema>`
 *   allows, and it removes the properties of the members of a composition
 *   inside every member.
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
  removeAdditional: true,
  allErrors: false,
  strict: false
}

/**
 * Normalises the options of the input validator pool.
 *
 * The options of the input side are the options of the pool builder: the
 * defaults of the pool (`customOptions` and `plugins`) are filled in, exactly
 * like the deprecated top-level `ajv` option does, so that a user can move
 * their configuration from the deprecated option to the new one without
 * changing anything else.
 *
 * The options are **not** shape validated by the framework: the pool builder
 * validates the options it does not understand.
 *
 * @param {object|undefined} options the options of the input validator pool
 * @returns {object|undefined} the normalised options
 */
function normaliseInputValidatorOptions (options) {
  if (options === undefined) {
    return undefined
  }

  return Object.assign({
    customOptions: {},
    plugins: []
  }, options)
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
    // The whole option object is forwarded to the pool builder, so that the
    // options the type declares (`onCreate`, `mode`, `plugins`) reach Ajv. The
    // `customOptions` are merged on top of the framework defaults: the user's
    // values win.
    return buildCompilerFromPool(externalSchemas, Object.assign({}, options, {
      customOptions: Object.assign({}, outputValidatorDefaults, options.customOptions)
    }))
  }
}

/**
 * Called at every fastify context that is being created.
 * @param {object} parentSchemaCtrl: the SchemaController instance of the Fastify parent context
 * @param {object} opts: the `schemaController` server option. It can be undefined when a parentSchemaCtrl is set
 * @return {object}:a new SchemaController
 */
function buildSchemaController (parentSchemaCtrl, opts) {
  // `fast-json-stringify` is not part of the runtime any more: the key of the
  // serializer factory is dropped and its use is a hard error, never a silent
  // fallback.
  if (opts?.compilersFactory?.buildSerializer) {
    throw new FST_ERR_SERIALIZER_COMPILER_REMOVED('compilersFactory.buildSerializer')
  }

  // The key of the input factory has been renamed in Fastify v6: the old key
  // is a hard error, never a silent fallback and never a deprecation warning.
  // The check happens before the factory object is assembled, so that a server
  // can never end up with a pool built by a factory the framework does not
  // know about.
  if (opts?.compilersFactory?.buildValidator) {
    throw new FST_ERR_BUILD_VALIDATOR_RENAMED()
  }

  if (parentSchemaCtrl) {
    return new SchemaController(parentSchemaCtrl, opts)
  }

  const compilersFactory = Object.assign({
    buildInputValidator: null,
    buildOutputValidator: null
  }, opts?.compilersFactory)

  if (!compilersFactory.buildInputValidator) {
    const ValidatorSelector = require('@fastify/ajv-compiler')
    compilersFactory.buildInputValidator = ValidatorSelector()
  }
  if (!compilersFactory.buildOutputValidator) {
    compilersFactory.buildOutputValidator = buildDefaultOutputValidatorFactory()
  }

  const option = {
    bucket: (opts && opts.bucket) || buildSchemas,
    compilersFactory,
    inputValidatorOptions: opts?.inputValidatorOptions,
    outputValidatorOptions: opts?.outputValidatorOptions,
    isCustomValidatorCompiler: typeof opts?.compilersFactory?.buildInputValidator === 'function',
    isCustomOutputValidatorCompiler: typeof opts?.compilersFactory?.buildOutputValidator === 'function'
  }

  return new SchemaController(undefined, option)
}

class SchemaController {
  constructor (parent, options) {
    this.opts = options || parent?.opts
    this.addedSchemas = false

    this.compilersFactory = this.opts.compilersFactory

    // The options of the input side are kept on the controller, so that they
    // are honoured both when they are given as a server option and when they
    // are given through `fastify.setSchemaController()`.
    this.inputValidatorOptions = normaliseInputValidatorOptions(this.opts.inputValidatorOptions)

    // The options of the output side are kept on the controller, so that they
    // are honoured both when they are given as a server option and when they
    // are given through `fastify.setSchemaController()`.
    this.outputValidatorOptions = this.opts.outputValidatorOptions

    // The bucket of the output side is created on demand, see
    // `getOutputSchemaBucket()`.
    this.outputSchemaBucket = undefined

    if (parent) {
      this.schemaBucket = this.opts.bucket(parent.getSchemas())
      this.validatorCompiler = parent.getValidatorCompiler()
      this.outputValidatorCompiler = parent.getOutputValidatorCompiler()
      this.isCustomValidatorCompiler = parent.isCustomValidatorCompiler
      this.isCustomOutputValidatorCompiler = parent.isCustomOutputValidatorCompiler
      this.parent = parent
    } else {
      this.schemaBucket = this.opts.bucket()
      this.isCustomValidatorCompiler = this.opts.isCustomValidatorCompiler || false
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
   * The bucket of the output side.
   *
   * The output side keeps its own bucket: the input and the output documents
   * are stored separately and `add()` never writes to this bucket.
   *
   * The bucket is created on demand: a server that never uses the storage of
   * the output side never allocates it, so the `bucket` factory of the user is
   * called once per controller, for the input side only.
   *
   * @returns {object} the bucket of the output side
   */
  getOutputSchemaBucket () {
    if (this.outputSchemaBucket === undefined) {
      this.outputSchemaBucket = this.parent
        ? this.opts.bucket(this.parent.getOutputSchemas())
        : this.opts.bucket()
    }
    return this.outputSchemaBucket
  }

  /**
   * The shared documents of the output side.
   *
   * The pool of the output side is seeded with the documents of the input
   * side and with the documents of the output side: a response schema that
   * references an identifier published through `fastify.addSchema` resolves
   * in the output pool too.
   *
   * @returns {object} the shared documents, by identifier
   */
  getOutputPoolDocuments () {
    return Object.assign({}, this.getSchemas(), this.getOutputSchemas())
  }

  /**
   * The documents of the output side. They are stored in a bucket of their
   * own: the input and the output sides never share their storage.
   *
   * @returns {object} the output schemas
   */
  getOutputSchemas () {
    if (this.outputSchemaBucket === undefined) {
      // The output side never allocated its bucket: it owns no document yet.
      return {}
    }
    return this.outputSchemaBucket.getSchemas()
  }

  setValidatorCompiler (validatorCompiler) {
    // Set up as if the fixed validator compiler had been provided
    // by a custom 'options.compilersFactory.buildInputValidator' that
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
      { buildInputValidator: () => validatorCompiler })
    this.validatorCompiler = validatorCompiler
    this.isCustomValidatorCompiler = true
  }

  getValidatorCompiler () {
    return this.validatorCompiler || (this.parent && this.parent.getValidatorCompiler())
  }

  getValidatorBuilder () {
    return this.compilersFactory.buildInputValidator || (this.parent && this.parent.getValidatorBuilder())
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
    // The options of the controller win over the deprecated top-level server
    // option: `schemaController.inputValidatorOptions` is the replacement of
    // the deprecated `ajv` option. A server that configures neither keeps the
    // v5 behaviour: the pool is built with the default options.
    const inputValidatorOptions = this.inputValidatorOptions !== undefined
      ? this.inputValidatorOptions
      : serverOptions?.ajv
    this.validatorCompiler = this.getValidatorBuilder()(this.schemaBucket.getSchemas(), inputValidatorOptions)
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
    const externalSchemas = this.getOutputPoolDocuments()
    // Every document of the pool is transformed with the fjs parity rules, so
    // that a `$ref` to a shared document reaches the parity too. The transform
    // works on a copy: the documents of the user are never mutated. The
    // shared documents are given to the transform: a composition whose
    // member references a shared document resolves it, exactly like the
    // transform of a response schema does.
    const paritySchemas = {}
    for (const id of Object.keys(externalSchemas)) {
      paritySchemas[id] = applyFjsObjectParity(externalSchemas[id], { sharedDocuments: externalSchemas })
    }
    // The options of the controller win over the server options: a controller
    // installed with `fastify.setSchemaController()` owns them.
    const outputValidatorOptions = this.outputValidatorOptions !== undefined
      ? this.outputValidatorOptions
      : serverOptions?.schemaController?.outputValidatorOptions
    this.outputValidatorCompiler = this.getOutputValidatorBuilder()(
      paritySchemas,
      outputValidatorOptions
    )
  }
}

SchemaController.buildSchemaController = buildSchemaController
module.exports = SchemaController
