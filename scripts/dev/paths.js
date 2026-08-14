const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const cordovaRoot = path.join(
  projectRoot,
  'platforms/android/app/src/main/assets/www',
);

module.exports = {
  cordovaRoot,
  projectRoot,
};
