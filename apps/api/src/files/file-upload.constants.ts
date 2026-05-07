export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PDF_MIME_TYPES = ['application/pdf'] as const;
export const ALLOWED_FILE_MIME_TYPES = [...IMAGE_MIME_TYPES, ...PDF_MIME_TYPES] as const;

export const IMAGE_MAX_SIZE_BYTES = parseSizeLimit(
  process.env.FILE_IMAGE_MAX_SIZE_BYTES,
  10 * 1024 * 1024,
);
export const PDF_MAX_SIZE_BYTES = parseSizeLimit(
  process.env.FILE_PDF_MAX_SIZE_BYTES,
  50 * 1024 * 1024,
);
export const GENERIC_MAX_SIZE_BYTES = Math.max(IMAGE_MAX_SIZE_BYTES, PDF_MAX_SIZE_BYTES);

function parseSizeLimit(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
