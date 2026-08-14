const CONSTRUCTOR_NAMES = /Collection|NullObject/;

const terserOptions = {
  compress: {
    ecma: 5,
    keep_fnames: CONSTRUCTOR_NAMES,
    module: true,
    passes: 5,
    pure_getters: true,
    toplevel: true,
  },
  format: { comments: false, ecma: 5 },
  mangle: { keep_fnames: CONSTRUCTOR_NAMES, toplevel: true },
  module: true,
  toplevel: true,
};

module.exports = { terserOptions };
