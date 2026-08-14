const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { validateBundleFile } = require('./bundle-validation');
const { projectRoot } = require('./paths');

async function packZip({
  rootDir = projectRoot,
  outputFile = path.join(rootDir, 'dist.zip'),
} = {}) {
  await validateBundleFile(path.join(rootDir, 'dist/main.js'));
  const zip = new JSZip();
  const readmeFile = resolveReadme(rootDir);

  zip.file(
    'icon.png',
    await fs.promises.readFile(path.join(rootDir, 'icon.png')),
  );
  zip.file(
    'plugin.json',
    await fs.promises.readFile(path.join(rootDir, 'plugin.json')),
  );
  zip.file('readme.md', await fs.promises.readFile(readmeFile));
  await addFolder(zip, '', path.join(rootDir, 'dist'));

  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    streamFiles: true,
  });
  const temporaryFile = `${outputFile}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.promises.writeFile(temporaryFile, archive);
    await fs.promises.rename(temporaryFile, outputFile);
  } finally {
    await fs.promises.rm(temporaryFile, { force: true });
  }

  return outputFile;
}

function resolveReadme(rootDir) {
  const lowercaseReadme = path.join(rootDir, 'readme.md');
  if (fs.existsSync(lowercaseReadme)) return lowercaseReadme;
  return path.join(rootDir, 'README.md');
}

async function addFolder(zip, archiveRoot, folder) {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(folder, entry.name);
      const archivePath = path.posix.join(archiveRoot, entry.name);

      if (entry.isDirectory()) {
        await addFolder(zip, archivePath, filePath);
        return;
      }

      if (!/LICENSE\.txt$/.test(entry.name)) {
        zip.file(archivePath, await fs.promises.readFile(filePath));
      }
    }),
  );
}

if (require.main === module) {
  packZip()
    .then((outputFile) => console.log(`${path.basename(outputFile)} written.`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { packZip };
