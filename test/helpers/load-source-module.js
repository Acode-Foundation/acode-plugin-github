const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(projectRoot, 'src');
const stablelibRoot = path.join(projectRoot, 'node_modules/@stablelib');

async function withSourceModule(relativePath, globals, run) {
  const { transformSync } = await import('@babel/core');
  const previousGlobals = new Map();

  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, {
      exists: Object.hasOwn(global, name),
      value: global[name],
    });
    global[name] = value;
  }

  clearSourceCache();
  const previousLoader = Module._extensions['.js'];
  const previousCssLoader = Module._extensions['.css'];
  Module._extensions['.css'] = function loadCss(loadedModule, filename) {
    loadedModule.exports = fs.readFileSync(filename, 'utf8');
  };
  Module._extensions['.js'] = function loadJavaScript(loadedModule, filename) {
    const isSource = filename.startsWith(`${sourceRoot}${path.sep}`);
    const isStablelib = filename.startsWith(`${stablelibRoot}${path.sep}`);
    if (!isSource && !isStablelib) {
      previousLoader(loadedModule, filename);
      return;
    }

    const source = fs.readFileSync(filename, 'utf8');
    const result = transformSync(source, {
      babelrc: false,
      configFile: false,
      cwd: projectRoot,
      filename,
      plugins: [],
      presets: [
        [
          '@babel/preset-env',
          { modules: 'commonjs', targets: { node: 'current' } },
        ],
      ],
      sourceMaps: false,
    });
    loadedModule._compile(result.code, filename);
  };

  try {
    const exports = require(path.join(sourceRoot, relativePath));
    return await run(exports);
  } finally {
    Module._extensions['.js'] = previousLoader;
    if (previousCssLoader) {
      Module._extensions['.css'] = previousCssLoader;
    } else {
      delete Module._extensions['.css'];
    }
    clearSourceCache();
    for (const [name, previous] of previousGlobals) {
      if (previous.exists) {
        global[name] = previous.value;
      } else {
        delete global[name];
      }
    }
  }
}

function clearSourceCache() {
  for (const filename of Object.keys(require.cache)) {
    if (
      filename.startsWith(`${sourceRoot}${path.sep}`) ||
      filename.startsWith(`${stablelibRoot}${path.sep}`)
    ) {
      delete require.cache[filename];
    }
  }
}

module.exports = { withSourceModule };
