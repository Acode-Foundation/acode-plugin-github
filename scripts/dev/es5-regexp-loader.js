const REPLACEMENTS = [
  ['/(?:^\\W+)|(?:(?<!\\W)\\W+$)/g', '/^\\W+|\\W+$/g'],
  [
    'headers.accept.match(/(?<![\\w-])[\\w-]+(?=-preview)/g) || []',
    '(headers.accept.match(/(?:^|[^\\w-])[\\w-]+(?=-preview)/g) || []).map((preview) => preview.replace(/^[^\\w-]/, ""))',
  ],
  ['/(?<! ) .*$/', '/ [^ ].*$/'],
];

module.exports = function es5RegexpLoader(source) {
  let result = source;
  let replacements = 0;
  for (const [modern, legacy] of REPLACEMENTS) {
    if (!result.includes(modern)) continue;
    result = result.replace(modern, legacy);
    replacements += 1;
  }
  if (replacements === 0) {
    throw new Error(
      `Octokit regular expressions changed in ${this.resourcePath}. Review the ES5 compatibility loader.`,
    );
  }
  return result;
};
