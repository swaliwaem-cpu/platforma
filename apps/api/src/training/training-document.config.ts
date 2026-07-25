export const TRAINING_DOCUMENT_MIME_TYPES = {
  PDF: ['application/pdf'],
  DOCX: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  PPTX: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  XLSX: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
} as const;

export const TRAINING_DOCUMENT_EXTENSIONS = {
  PDF: '.pdf',
  DOCX: '.docx',
  PPTX: '.pptx',
  XLSX: '.xlsx',
} as const;

export const TRAINING_MAX_DOCUMENT_BYTES = readPositiveInteger(
  'TRAINING_MAX_DOCUMENT_BYTES',
  50 * 1024 * 1024,
);
export const TRAINING_MAX_DOCUMENT_UNCOMPRESSED_BYTES = readPositiveInteger(
  'TRAINING_MAX_DOCUMENT_UNCOMPRESSED_BYTES',
  200 * 1024 * 1024,
);
export const TRAINING_MAX_DOCUMENT_ENTRY_BYTES = readPositiveInteger(
  'TRAINING_MAX_DOCUMENT_ENTRY_BYTES',
  50 * 1024 * 1024,
);
export const TRAINING_MAX_DOCUMENT_ZIP_ENTRIES = readPositiveInteger(
  'TRAINING_MAX_DOCUMENT_ZIP_ENTRIES',
  5_000,
);
export const TRAINING_MAX_EXTRACTED_CHARACTERS = readPositiveInteger(
  'TRAINING_MAX_EXTRACTED_CHARACTERS',
  1_000_000,
);
export const TRAINING_MAX_EXTRACTION_SEGMENTS = readPositiveInteger(
  'TRAINING_MAX_EXTRACTION_SEGMENTS',
  50_000,
);
export const TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS = readPositiveInteger(
  'TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS',
  30_000,
);
export const TRAINING_DOCUMENT_JOB_POLL_MS = readPositiveInteger(
  'TRAINING_DOCUMENT_JOB_POLL_MS',
  2_000,
);

function readPositiveInteger(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}
