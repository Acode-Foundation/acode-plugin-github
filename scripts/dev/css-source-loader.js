function minifyCss(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/\[([\w-]+)="([\w-]+)"\]/g, '[$1=$2]')
    .replace(/\s*!important/g, '!important')
    .replace(/;}/g, '}')
    .replace(/\b0\.(\d+)/g, '.$1')
    .trim();
}

module.exports = function cssSourceLoader(source) {
  return `export default ${JSON.stringify(minifyCss(source))};`;
};

module.exports.minifyCss = minifyCss;
