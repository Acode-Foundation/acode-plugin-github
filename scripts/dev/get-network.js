const { networkInterfaces } = require('node:os');

module.exports = async () => {
  const ip = getIp();
  const port = '5500';
  return { ip, port };
};

function getIp(nets = networkInterfaces()) {
  for (const addresses of Object.values(nets)) {
    for (const net of addresses || []) {
      const isIpv4 = net.family === 'IPv4' || net.family === 4;
      if (isIpv4 && !net.internal) {
        return net.address;
      }
    }
  }

  return '127.0.0.1';
}

module.exports.getIp = getIp;
