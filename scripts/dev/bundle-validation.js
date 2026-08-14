const fs = require('node:fs');

const WEBPACK_REQUIRE = '__webpack_require__';
const WEBPACK_REQUIRE_REFERENCE = /\b__webpack_require__\b/u;
const WEBPACK_REQUIRE_DEFINITION =
  /(?:function\s+__webpack_require__\s*\(|(?:const|let|var)\s+__webpack_require__\s*=)/u;

function validateBundleSource(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  if (typeof text !== 'string') {
    throw new TypeError('Bundle source must be a string or Buffer.');
  }
  if (
    WEBPACK_REQUIRE_REFERENCE.test(text) &&
    !WEBPACK_REQUIRE_DEFINITION.test(text)
  ) {
    const error = new Error(
      `${WEBPACK_REQUIRE} is referenced without its Webpack runtime definition.`,
    );
    error.code = 'INVALID_WEBPACK_RUNTIME';
    throw error;
  }
  return true;
}

async function validateBundleFile(file) {
  validateBundleSource(await fs.promises.readFile(file));
  return file;
}

module.exports = { validateBundleFile, validateBundleSource };
