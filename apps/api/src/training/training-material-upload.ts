import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { UploadedFile } from '../files/uploaded-file.type';

const PDF_UPLOAD_LIMIT = 100 * 1024 * 1024;
const uploadRoot = join(tmpdir(), 'platforma-training-material-uploads');

type MulterFile = {
  stream: NodeJS.ReadableStream;
  originalname: string;
  mimetype: string;
};

type StorageCallback = (
  error: Error | null,
  value?: { destination: string; filename: string; path: string; size: number; checksum: string },
) => void;

export type StoredTrainingPdfUpload = UploadedFile & {
  path: string;
  checksum: string;
};

export const trainingMaterialPdfUploadOptions = {
  limits: { fileSize: PDF_UPLOAD_LIMIT, files: 1 },
  storage: {
    _handleFile(_request: unknown, file: MulterFile, callback: StorageCallback) {
      const filename = `${randomUUID()}.pdf`;
      const path = join(uploadRoot, filename);
      const checksum = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(
          chunk: Buffer | string,
          encoding: BufferEncoding,
          done: (error?: Error | null, data?: Buffer) => void,
        ) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          size += buffer.length;
          checksum.update(buffer);
          done(null, buffer);
        },
      });

      void mkdir(uploadRoot, { recursive: true })
        .then(() => pipeline(file.stream, meter, createWriteStream(path, { flags: 'wx' })))
        .then(() => callback(null, {
          destination: uploadRoot,
          filename,
          path,
          size,
          checksum: checksum.digest('hex'),
        }))
        .catch((error: unknown) => {
          void rm(path, { force: true }).finally(() => {
            callback(error instanceof Error ? error : new Error('PDF_UPLOAD_FAILED'));
          });
        });
    },
    _removeFile(_request: unknown, file: { path?: string }, callback: (error: Error | null) => void) {
      if (!file.path) {
        callback(null);
        return;
      }
      void rm(file.path, { force: true }).then(
        () => callback(null),
        (error: unknown) => callback(error instanceof Error ? error : new Error('PDF_UPLOAD_CLEANUP_FAILED')),
      );
    },
  },
};

export async function cleanupTrainingPdfUpload(file: UploadedFile | undefined) {
  if (file?.path) await rm(file.path, { force: true });
}
