import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '0.0.0.0';
const rootDir = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const indexPath = join(rootDir, 'index.html');

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = decodePathname(url.pathname);

    if (!pathname || isBlockedSourceRequest(pathname)) {
      sendText(response, 404, 'Not found');
      return;
    }

    const filePath = resolveStaticPath(pathname);
    const staticFile = filePath ? await getExistingFile(filePath) : null;

    if (staticFile) {
      await sendFile(request, response, staticFile, pathname);
      return;
    }

    await sendFile(request, response, indexPath, '/index.html');
  } catch (error) {
    console.error(error);
    sendText(response, 500, 'Internal server error');
  }
});

server.listen(port, host, () => {
  console.log(`web static server listening on http://${host}:${port}`);
});

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function resolveStaticPath(pathname) {
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(rootDir, `.${normalizedPath}`);
  const relativePath = relative(rootDir, filePath);

  if (relativePath.startsWith('..') || relativePath === '' || relativePath.includes('..')) {
    return null;
  }

  return filePath;
}

async function getExistingFile(filePath) {
  try {
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      return null;
    }

    await access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

async function sendFile(request, response, filePath, pathname) {
  const fileStat = await stat(filePath);
  const headers = {
    'Cache-Control': getCacheControl(pathname),
    'Content-Length': String(fileStat.size),
    'Content-Type': getContentType(filePath),
  };

  response.writeHead(200, headers);

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(message);
}

function getContentType(filePath) {
  return mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function getCacheControl(pathname) {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function isBlockedSourceRequest(pathname) {
  return (
    pathname === '/@vite/client' ||
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@react-refresh') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/apps/') ||
    pathname.startsWith('/packages/') ||
    pathname.startsWith('/tools/') ||
    pathname.startsWith('/.git') ||
    pathname.startsWith('/.env') ||
    pathname.endsWith('/Dockerfile') ||
    pathname.endsWith('.tsx') ||
    pathname.endsWith('.ts')
  );
}
