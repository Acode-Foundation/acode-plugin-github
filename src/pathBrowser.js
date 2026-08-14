export function extname(path) {
  if (typeof path !== 'string') throw new TypeError('Path must be a string');
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!name || name === '.' || name === '..') return '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
