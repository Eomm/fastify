# Release checklist

The release of Fastify is a sequence of commands. Every step of this
checklist is a command of the repository: run them in this order.

## 1. Install the dependencies

The development dependencies are needed: the build scripts use them.

```bash
npm ci
```

## 2. Regenerate the generated files

`lib/error-serializer.js` and `lib/config-validator.js` are **generated**
and **committed**. They must never be hand edited: the build scripts
regenerate them from the sources of the repository.

```bash
npm run build:validation
```

## 3. Commit the regenerated files

The regenerated files are part of the release. Commit them: a release that
ships a stale generated file breaks the reproducibility gate.

```bash
git add lib/error-serializer.js lib/config-validator.js
git commit -m "chore: regenerate the generated files"
```

## 4. Verify the integrity of the generated files

The integrity gate regenerates the files and diffs them against the
committed ones: it fails when they are not the same.

```bash
npm run test:validator:integrity
```

## 5. Run the gates

```bash
npm run lint:eslint
npm run lint:markdown
npm run unit
npm run test:types
```

## 6. Publish

The `prepublishOnly` script runs the version check, the whole test suite
with the coverage gate, the integrity gate and the version
synchronisation.

```bash
npm publish
```

## Notes

- `fast-json-stringify` is a development dependency: the build script
  `build/build-error-serializer.js` uses it to regenerate the committed
  `lib/error-serializer.js`. The runtime does not load it.
- The `fast-json-stringify` devDependency is **pinned to an exact version**:
  the generated `lib/error-serializer.js` embeds the version and the inlined
  source of the upstream package, so a different version produces different
  bytes and the integrity gate would fail. Bumping the pin requires
  `npm install` and `npm run build:error-serializer` (and the commit of the
  regenerated `lib/error-serializer.js`) before the release.
- `npm run build:error-serializer` regenerates `lib/error-serializer.js`
  alone, `npm run build:validation` regenerates both generated files.
- The generated `lib/error-serializer.js` is self contained: it does not
  require `fast-json-stringify` at runtime.
