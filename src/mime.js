const types = {};

for (const [type, extensions] of Object.entries({
  'application/gzip': 'gz',
  'application/json': 'json map',
  'application/octet-stream': 'bin dat',
  'application/pdf': 'pdf',
  'application/rtf': 'rtf',
  'application/sql': 'sql',
  'application/wasm': 'wasm',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/x-tar': 'tar',
  'application/xml': 'xml xsl',
  'application/zip': 'zip',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'oga ogg opus',
  'audio/wav': 'wav',
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpeg jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/html': 'htm html',
  'text/javascript': 'cjs js jsx mjs',
  'text/markdown': 'markdown md',
  'text/plain':
    'bash c cc conf cpp cxx dart env fish go h hpp ini java kt kts log php properties py rb rs sh swift text toml ts tsx txt zsh',
  'text/yaml': 'yaml yml',
  'video/mp4': 'm4v mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
})) {
  for (const extension of extensions.split(' ')) types[extension] = type;
}

export function lookupMimeType(filename) {
  const extension = String(filename).split('.').pop().toLowerCase();
  return types[extension] || false;
}
