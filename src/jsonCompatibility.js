// GitHub's API uses standard JSON numbers. Keeping this adapter local avoids
// Octokit's optional BigInt parser on older Acode WebViews.
export const JSONParse = JSON.parse;
export const JSONStringify = JSON.stringify;
