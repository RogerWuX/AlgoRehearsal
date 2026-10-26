const { readFileSync, existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');

const projectRoot = resolve(__dirname, '../..');

// Transpile application modules; mock browser, React, LangChain, and Google SDK boundaries.
function load(file, globals = {}, dependencies = {}) {
  const filename = resolve(projectRoot, file);
  if (filename.endsWith('.md')) return { default: readFileSync(filename, 'utf8') };
  const exports = {};
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require: name => {
      if (name in dependencies) return dependencies[name];
      if (name === 'react-native-logs') return require('./reactNativeLogs.cjs');
      if (name.startsWith('./') || name.startsWith('../')) {
        const requested = resolve(dirname(filename), name);
        const resolved = [requested + '.ts', requested + '.tsx', requested + '/index.ts', requested].find(candidate => existsSync(candidate));
        if (!resolved) throw new Error(`Cannot resolve ${name} from ${filename}`);
        return load(resolved, globals, dependencies);
      }
      return require(name);
    }, crypto: webcrypto, URL, AbortController, Response, Blob, Error, setTimeout, clearTimeout, atob, btoa,
    document: { baseURI: 'https://example.test/practice/' }, ...globals,
  }, { filename });
  return exports;
}

module.exports = load;
