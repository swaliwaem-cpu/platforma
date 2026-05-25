export type FileContentResponse = {
  setHeader: (name: string, value: string | number) => void;
  send: (body: Buffer) => void;
};

export type FileContentResult = {
  file: {
    mimeType: string | null;
    originalName: string | null;
  };
  buffer: Buffer;
  variant: string;
};

export type FileContentResponseOptions = {
  disposition?: 'attachment' | 'inline';
  serverTimingDurationMs?: number;
};

export function sendFileContentResponse(
  response: FileContentResponse,
  content: FileContentResult,
  options: FileContentResponseOptions = {},
) {
  response.setHeader('Content-Type', content.file.mimeType ?? 'application/octet-stream');
  response.setHeader('Content-Length', content.buffer.length);
  response.setHeader(
    'Cache-Control',
    isImageMimeType(content.file.mimeType) ? 'private, max-age=86400' : 'private, max-age=300',
  );

  if (isImageMimeType(content.file.mimeType) && options.serverTimingDurationMs !== undefined) {
    response.setHeader('Server-Timing', `platforma-media;dur=${formatServerTimingDuration(options.serverTimingDurationMs)}`);
  }

  if (content.variant !== 'original') {
    response.setHeader('X-Platforma-File-Variant', content.variant);
  }

  const disposition = options.disposition ?? 'inline';

  response.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${sanitizeHeaderFilename(content.file.originalName)}"`,
  );
  response.send(content.buffer);
}

export function getFileContentDisposition(download: string | null | undefined) {
  const normalizedDownload = download?.trim().toLowerCase();

  return normalizedDownload === '1' || normalizedDownload === 'true' ? 'attachment' : 'inline';
}

function sanitizeHeaderFilename(value: string | null) {
  return (value ?? 'file').replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
}

function isImageMimeType(value: string | null | undefined) {
  return value?.toLowerCase().startsWith('image/') ?? false;
}

function formatServerTimingDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '0';
  }

  return value.toFixed(1).replace(/\.0$/u, '');
}
