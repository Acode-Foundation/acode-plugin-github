const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const serveHandler = require('serve-handler');
const getNetwork = require('./get-network');
const { cordovaRoot: defaultCordovaRoot, projectRoot } = require('./paths');

function createRequestHandler({
  rootDir = projectRoot,
  cordovaRoot = defaultCordovaRoot,
} = {}) {
  return async (request, response) => {
    setDevelopmentHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/cordova.js' || pathname === '/cordova_plugins.js') {
      await sendFile(response, path.join(cordovaRoot, pathname.slice(1)));
      return;
    }

    try {
      await serveHandler(request, response, {
        public: rootDir,
        cleanUrls: false,
        directoryListing: false,
        etag: false,
      });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        response.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      response.end('Internal server error');
    }
  };
}

function createDevServer({ rootDir, cordovaRoot } = {}) {
  return http.createServer(createRequestHandler({ rootDir, cordovaRoot }));
}

function startServer({ host, port, rootDir, cordovaRoot } = {}) {
  const server = createDevServer({ rootDir, cordovaRoot });

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function setDevelopmentHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
}

async function sendFile(response, filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    response.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': stat.size,
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(response);
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`ERROR cannot get ${filePath}`);
  }
}

async function main() {
  const { ip: host, port } = await getNetwork();
  const server = await startServer({ host, port });
  const address = server.address();
  console.log(`Plugin server listening on http://${host}:${address.port}`);
  if (process.send) process.send('OK');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createDevServer,
  createRequestHandler,
  setDevelopmentHeaders,
  startServer,
};
