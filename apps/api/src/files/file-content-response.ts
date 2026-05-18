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

export function sendFileContentResponse(response: FileContentResponse, content: FileContentResult) {
  response.setHeader('Content-Type', content.file.mimeType ?? 'application/octet-stream');
  response.setHeader('Content-Length', content.buffer.length);
  response.setHeader(
    'Cache-Control',
    isImageMimeType(content.file.mimeType) ? 'private, max-age=86400' : 'private, max-age=300',
  );

  if (content.variant !== 'original') {
    response.setHeader('X-Platforma-File-Variant', content.variant);
  }

  response.setHeader(
    'Content-Disposition',
    `inline; filename="${sanitizeHeaderFilename(content.file.originalName)}"`,
  );
  response.send(content.buffer);
}

function sanitizeHeaderFilename(value: string | null) {
  return (value ?? 'file').replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
}

function isImageMimeType(value: string | null | undefined) {
  return value?.toLowerCase().startsWith('image/') ?? false;
}
