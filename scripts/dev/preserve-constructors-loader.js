const NULL_OBJECT = 'const C = function () { };';

module.exports = function preserveConstructors(source) {
  if (!source.includes(NULL_OBJECT)) {
    throw new Error('The content-type NullObject constructor changed.');
  }

  return source.replace(NULL_OBJECT, 'const C = function NullObject() {};');
};
