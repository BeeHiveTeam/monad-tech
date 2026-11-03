const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(root, 'package.json'));

function createLoader({ mocks = {}, globals = {} } = {}) {
  const cache = new Map();
  const sandbox = vm.createContext({
    console, process, Buffer, URL, URLSearchParams, Request, Response, Headers,
    AbortController, AbortSignal, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ...globals,
  });
  function loadTS(relativePath) {
    let file = path.isAbsolute(relativePath) ? relativePath : path.resolve(root, relativePath);
    if (!path.extname(file)) {
      file = ['.ts', '.tsx', '.js', '.cjs'].map(ext => file + ext).find(fs.existsSync) || file;
    }
    if (cache.has(file)) return cache.get(file).exports;
    const record = { exports: {} };
    cache.set(file, record);
    const source = fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
    }).outputText;
    const req = spec => {
      if (Object.hasOwn(mocks, spec)) return mocks[spec];
      if (spec.startsWith('@/')) return loadTS(spec.slice(2));
      if (spec.startsWith('.')) return loadTS(path.resolve(path.dirname(file), spec));
      return localRequire(spec);
    };
    const wrapper = vm.runInContext(`(function(require,module,exports,__filename,__dirname){${compiled}\n})`, sandbox, { filename: file });
    wrapper(req, record, record.exports, file, path.dirname(file));
    return record.exports;
  }
  return { loadTS, sandbox };
}
function loadTS(relativePath, options) { return createLoader(options).loadTS(relativePath); }
module.exports = { loadTS, createLoader };
