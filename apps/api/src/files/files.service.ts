import { basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { File, FileStorage, FileVariantKind } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOWED_FILE_MIME_TYPES,
  FEED_XML_MAX_SIZE_BYTES,
  FEED_XML_MIME_TYPES,
  IMAGE_MAX_SIZE_BYTES,
  IMAGE_MIME_TYPES,
  PDF_MAX_SIZE_BYTES,
  PDF_MIME_TYPES,
} from './file-upload.constants';
import { generateImageVariants, generateImageVariantsFromFile, isImageVariantSourceMimeType } from './image-variants';
import { S3StorageService } from './s3-storage.service';
import { UploadedFile } from './uploaded-file.type';

export type UploadFileKind = 'generic' | 'image' | 'pdf' | 'feed-xml';
export type ServedFileVariant = 'original' | 'original-fallback' | 'thumbnail' | 'card' | 'detail';
export type UploadedFileStream = {
  stream: NodeJS.ReadableStream;
  originalname: string;
  mimetype: string;
  size?: number;
};

type RequestedFileVariant =
  | {
      kind: 'original';
    }
  | {
      kind: 'variant';
      variant: FileVariantKind;
      headerValue: Exclude<ServedFileVariant, 'original' | 'original-fallback'>;
    };

type ValidatedUploadedFileStream = UploadedFileStream & {
  maxSize: number;
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
  ) {}

  async uploadFile(file: UploadedFile | undefined, actor: AuthenticatedUser, kind: UploadFileKind) {
    const validatedFile = this.validateUploadedFile(file, kind);
    const checksum = createHash('sha256').update(validatedFile.buffer).digest('hex');
    const key = this.createStorageKey(validatedFile.originalname, validatedFile.mimetype);
    const variants = isImageVariantSourceMimeType(validatedFile.mimetype)
      ? await generateImageVariants(validatedFile.buffer, key)
      : [];

    const storedObjectKeys: string[] = [];

    try {
      await this.storage.putObject({
        key,
        body: validatedFile.buffer,
        contentType: validatedFile.mimetype,
      });
      storedObjectKeys.push(key);

      for (const variant of variants) {
        await this.storage.putObject({
          key: variant.key,
          body: variant.body,
          contentType: variant.mimeType,
        });
        storedObjectKeys.push(variant.key);
      }

      const storedFile = await this.prisma.file.create({
        data: {
          storage: FileStorage.MINIO,
          bucket: this.storage.getBucket(),
          key,
          url: this.storage.getPublicUrl(key),
          originalName: validatedFile.originalname,
          mimeType: validatedFile.mimetype,
          sizeBytes: BigInt(validatedFile.size),
          checksum,
          uploadedById: actor.id,
          ...(variants.length > 0
            ? {
                variants: {
                  create: variants.map((variant) => ({
                    variant: variant.variant,
                    storage: FileStorage.MINIO,
                    bucket: this.storage.getBucket(),
                    key: variant.key,
                    url: this.storage.getPublicUrl(variant.key),
                    mimeType: variant.mimeType,
                    width: variant.width,
                    height: variant.height,
                    sizeBytes: variant.sizeBytes,
                    checksum: variant.checksum,
                  })),
                },
              }
            : {}),
        },
      });

      return {
        file: this.serializeFile(storedFile),
      };
    } catch (error) {
      await this.deleteStorageObjects(storedObjectKeys, 'upload rollback');
      throw error;
    }
  }

  async uploadFileStream(file: UploadedFileStream, actor: AuthenticatedUser, kind: UploadFileKind) {
    const validatedFile = this.validateUploadedFileStream(file, kind);
    const persistedFile = await this.persistUploadedFileStream(validatedFile);

    try {
      const key = this.createStorageKey(validatedFile.originalname, validatedFile.mimetype);
      const variants = isImageVariantSourceMimeType(validatedFile.mimetype)
        ? await generateImageVariantsFromFile(persistedFile.path, key)
        : [];

      await this.storage.putObjectFromFile({
        key,
        filePath: persistedFile.path,
        contentType: validatedFile.mimetype,
        checksum: persistedFile.checksum,
        contentLength: persistedFile.size,
      });

      for (const variant of variants) {
        await this.storage.putObject({
          key: variant.key,
          body: variant.body,
          contentType: variant.mimeType,
        });
      }

      const storedFile = await this.prisma.file.create({
        data: {
          storage: FileStorage.MINIO,
          bucket: this.storage.getBucket(),
          key,
          url: this.storage.getPublicUrl(key),
          originalName: validatedFile.originalname,
          mimeType: validatedFile.mimetype,
          sizeBytes: BigInt(persistedFile.size),
          checksum: persistedFile.checksum,
          uploadedById: actor.id,
          ...(variants.length > 0
            ? {
                variants: {
                  create: variants.map((variant) => ({
                    variant: variant.variant,
                    storage: FileStorage.MINIO,
                    bucket: this.storage.getBucket(),
                    key: variant.key,
                    url: this.storage.getPublicUrl(variant.key),
                    mimeType: variant.mimeType,
                    width: variant.width,
                    height: variant.height,
                    sizeBytes: variant.sizeBytes,
                    checksum: variant.checksum,
                  })),
                },
              }
            : {}),
        },
      });

      return {
        file: this.serializeFile(storedFile),
      };
    } finally {
      await persistedFile.cleanup();
    }
  }

  async uploadPrivateTrainingDocument(
    file: UploadedFile & { buffer: Buffer },
    actor: AuthenticatedUser,
    extension: '.pdf' | '.docx' | '.pptx' | '.xlsx',
  ) {
    const originalName = basename(file.originalname || `document${extension}`);
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const key = this.createPrivateTrainingStorageKey(extension);
    const bucket = this.storage.getTrainingDocumentBucket();

    try {
      await this.storage.putObject({
        bucket,
        key,
        body: file.buffer,
        contentType: file.mimetype,
      });

      return await this.prisma.file.create({
        data: {
          storage: FileStorage.MINIO,
          bucket,
          key,
          url: null,
          originalName,
          mimeType: file.mimetype,
          sizeBytes: BigInt(file.buffer.length),
          checksum,
          uploadedById: actor.id,
        },
      });
    } catch (error) {
      await this.storage.deleteObject(key, bucket).catch(() => undefined);
      throw error;
    }
  }

  async readStoredFile(file: Pick<File, 'bucket' | 'key'>) {
    return this.storage.getObject(file.key, file.bucket ?? undefined);
  }

  async deleteStoredFile(file: Pick<File, 'bucket' | 'key'>) {
    await this.storage.deleteObject(file.key, file.bucket ?? undefined);
  }

  getTrainingAudioBucket() {
    return this.storage.getTrainingAudioBucket();
  }

  async putPrivateTrainingAudioObject(input: {
    key: string;
    body: Buffer;
    mimeType: string;
  }) {
    this.assertPrivateTrainingAudioKey(input.key);
    await this.storage.putObject({
      bucket: this.storage.getTrainingAudioBucket(),
      key: input.key,
      body: input.body,
      contentType: input.mimeType,
    });
  }

  async putPrivateTrainingAudioFile(input: {
    key: string;
    filePath: string;
    mimeType: string;
    checksum: string;
    sizeBytes: number;
  }) {
    this.assertPrivateTrainingAudioKey(input.key);
    await this.storage.putObjectFromFileToBucket({
      bucket: this.storage.getTrainingAudioBucket(),
      key: input.key,
      filePath: input.filePath,
      contentType: input.mimeType,
      checksum: input.checksum,
      contentLength: input.sizeBytes,
    });
  }

  async deletePrivateTrainingAudioObject(key: string) {
    this.assertPrivateTrainingAudioKey(key);
    await this.storage.deleteObject(
      key,
      this.storage.getTrainingAudioBucket(),
    );
  }

  async getById(id: string) {
    const file = await this.findExistingFile(id);

    return {
      file: this.serializeFile(file),
    };
  }

  async getContent(id: string, variant?: string | null) {
    const requestedVariant = this.parseRequestedVariant(variant);
    const file = await this.findExistingFileWithVariants(id);

    if (requestedVariant.kind === 'variant') {
      const fileVariant = file.variants.find((currentVariant) => currentVariant.variant === requestedVariant.variant);

      if (fileVariant) {
        const buffer = await this.storage.getObject(fileVariant.key);

        return {
          file: {
            ...file,
            mimeType: fileVariant.mimeType,
            sizeBytes: fileVariant.sizeBytes,
          },
          buffer,
          variant: requestedVariant.headerValue,
        };
      }

      const buffer = await this.storage.getObject(file.key);

      return {
        file,
        buffer,
        variant: 'original-fallback' as const,
      };
    }

    const buffer = await this.storage.getObject(file.key);

    return {
      file,
      buffer,
      variant: 'original' as const,
    };
  }

  async delete(id: string) {
    const fileId = this.parseUuid(id, 'File is invalid');
    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
      include: {
        variants: {
          select: {
            key: true,
            bucket: true,
          },
        },
        _count: {
          select: {
            profilePhotoUsers: true,
            objectImages: true,
            objectFiles: true,
            feedXmlSources: true,
            lotPresentationDocuments: true,
            projectPresentationDraftCovers: true,
            projectPresentationDocuments: true,
            projectPresentationAssets: true,
            trainingSourceDocuments: true,
            trainingVoiceSegments: true,
            trainingAnswerAudio: true,
          },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (
      file._count.profilePhotoUsers > 0 ||
      file._count.objectImages > 0 ||
      file._count.objectFiles > 0 ||
      file._count.feedXmlSources > 0 ||
      file._count.lotPresentationDocuments > 0 ||
      file._count.projectPresentationDraftCovers > 0 ||
      file._count.projectPresentationDocuments > 0 ||
      file._count.projectPresentationAssets > 0 ||
      file._count.trainingSourceDocuments > 0 ||
      file._count.trainingVoiceSegments > 0 ||
      file._count.trainingAnswerAudio > 0
    ) {
      throw new ConflictException('File is linked and cannot be deleted');
    }

    for (const variant of file.variants) {
      await this.storage.deleteObject(variant.key, variant.bucket ?? undefined);
    }

    await this.storage.deleteObject(file.key, file.bucket ?? undefined);
    await this.prisma.file.delete({
      where: {
        id: file.id,
      },
    });
  }

  async deleteUnlinkedFile(id: string) {
    try {
      await this.delete(id);
    } catch (error) {
      if (error instanceof ConflictException) return false;
      this.logger.error(
        `Failed to delete unlinked file ${id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }

    return true;
  }

  serializeFile(file: File) {
    return {
      id: file.id,
      wpAttachmentId: file.wpAttachmentId,
      storage: file.storage,
      bucket: file.bucket,
      key: file.key,
      url: file.url,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes?.toString() ?? null,
      checksum: file.checksum,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  private async deleteStorageObjects(keys: string[], context: string) {
    for (const key of [...keys].reverse()) {
      try {
        await this.storage.deleteObject(key);
      } catch (error) {
        this.logger.error(
          `Failed to delete storage object ${key} during ${context}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private validateUploadedFile(file: UploadedFile | undefined, kind: UploadFileKind) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('File is required');
    }

    const mimeType = file.mimetype.trim().toLowerCase();
    const size = file.size || file.buffer.length;
    const originalname = basename(file.originalname || 'file');

    if (kind === 'feed-xml') {
      if (!this.isAllowedFeedXmlFile(originalname, mimeType)) {
        throw new BadRequestException(this.getMimeTypeError(kind));
      }

      if (size > FEED_XML_MAX_SIZE_BYTES) {
        throw new BadRequestException(`File size cannot exceed ${FEED_XML_MAX_SIZE_BYTES} bytes`);
      }

      if (!file.buffer.toString('utf8', 0, Math.min(file.buffer.length, 256)).trimStart().startsWith('<')) {
        throw new BadRequestException('Only XML files are allowed');
      }

      return {
        ...file,
        mimetype: mimeType,
        originalname,
        size,
        buffer: file.buffer,
      };
    }

    const allowedMimeTypes = this.getAllowedMimeTypes(kind);
    const maxSize = this.getMaxSize(kind, mimeType);

    if (!allowedMimeTypes.has(mimeType)) {
      throw new BadRequestException(this.getMimeTypeError(kind));
    }

    if (size > maxSize) {
      throw new BadRequestException(`File size cannot exceed ${maxSize} bytes`);
    }

    return {
      ...file,
      mimetype: mimeType,
      originalname,
      size,
      buffer: file.buffer,
    };
  }

  private validateUploadedFileStream(file: UploadedFileStream | undefined, kind: UploadFileKind): ValidatedUploadedFileStream {
    if (!file?.stream) {
      throw new BadRequestException('File is required');
    }

    const mimeType = file.mimetype.trim().toLowerCase().split(';')[0] ?? '';
    const originalname = basename(file.originalname || 'file');
    const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : undefined;

    if (kind === 'feed-xml') {
      if (!this.isAllowedFeedXmlFile(originalname, mimeType)) {
        throw new BadRequestException(this.getMimeTypeError(kind));
      }

      if (size !== undefined && size > FEED_XML_MAX_SIZE_BYTES) {
        throw new BadRequestException(`File size cannot exceed ${FEED_XML_MAX_SIZE_BYTES} bytes`);
      }

      return {
        ...file,
        mimetype: mimeType,
        originalname,
        size,
        maxSize: FEED_XML_MAX_SIZE_BYTES,
      };
    }

    const allowedMimeTypes = this.getAllowedMimeTypes(kind);
    const maxSize = this.getMaxSize(kind, mimeType);

    if (!allowedMimeTypes.has(mimeType)) {
      throw new BadRequestException(this.getMimeTypeError(kind));
    }

    if (size !== undefined && size > maxSize) {
      throw new BadRequestException(`File size cannot exceed ${maxSize} bytes`);
    }

    if (size === 0) {
      throw new BadRequestException('File is required');
    }

    return {
      ...file,
      mimetype: mimeType,
      originalname,
      size,
      maxSize,
    };
  }

  private async persistUploadedFileStream(file: ValidatedUploadedFileStream) {
    const directory = join(tmpdir(), 'platforma-uploads', randomUUID());
    const path = join(directory, 'upload');
    const checksum = createHash('sha256');
    let size = 0;

    await mkdir(directory, { recursive: true });

    const sizeLimitStream = new Transform({
      transform(
        chunk: Buffer | string,
        encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
      ) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        size += buffer.length;

        if (size > file.maxSize) {
          callback(new BadRequestException(`File size cannot exceed ${file.maxSize} bytes`));
          return;
        }

        checksum.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      await pipeline(file.stream, sizeLimitStream, createWriteStream(path));

      if (size === 0) {
        throw new BadRequestException('File is required');
      }

      return {
        path,
        size,
        checksum: checksum.digest('hex'),
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private getAllowedMimeTypes(kind: UploadFileKind) {
    if (kind === 'feed-xml') {
      return new Set<string>(FEED_XML_MIME_TYPES);
    }

    if (kind === 'image') {
      return new Set<string>(IMAGE_MIME_TYPES);
    }

    if (kind === 'pdf') {
      return new Set<string>(PDF_MIME_TYPES);
    }

    return new Set<string>(ALLOWED_FILE_MIME_TYPES);
  }

  private getMaxSize(kind: UploadFileKind, mimeType: string) {
    if (kind === 'feed-xml') {
      return FEED_XML_MAX_SIZE_BYTES;
    }

    if (kind === 'image' || IMAGE_MIME_TYPES.includes(mimeType as (typeof IMAGE_MIME_TYPES)[number])) {
      return IMAGE_MAX_SIZE_BYTES;
    }

    return PDF_MAX_SIZE_BYTES;
  }

  private getMimeTypeError(kind: UploadFileKind) {
    if (kind === 'feed-xml') {
      return 'Only XML files are allowed';
    }

    if (kind === 'image') {
      return 'Only JPEG, PNG and WebP images are allowed';
    }

    if (kind === 'pdf') {
      return 'Only PDF files are allowed';
    }

    return 'Only JPEG, PNG, WebP images and PDF files are allowed';
  }

  private createStorageKey(originalName: string, mimeType: string) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const extension = this.getSafeExtension(originalName, mimeType);

    return `uploads/${year}/${month}/${randomUUID()}${extension}`;
  }

  private createPrivateTrainingStorageKey(extension: '.pdf' | '.docx' | '.pptx' | '.xlsx') {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    return `training-documents/${year}/${month}/${randomUUID()}${extension}`;
  }

  private getSafeExtension(originalName: string, mimeType: string) {
    const extension = extname(originalName).toLowerCase();
    const allowedExtensions = this.getAllowedExtensions(mimeType);

    if (allowedExtensions.includes(extension)) {
      return extension === '.jpeg' ? '.jpg' : extension;
    }

    if (mimeType === 'application/pdf') {
      return '.pdf';
    }

    if (mimeType === 'image/jpeg') {
      return '.jpg';
    }

    if (mimeType === 'image/png') {
      return '.png';
    }

    if (mimeType === 'image/webp') {
      return '.webp';
    }

    if (this.isFeedXmlMimeType(mimeType)) {
      return '.xml';
    }

    return '';
  }

  private getAllowedExtensions(mimeType: string) {
    if (mimeType === 'application/pdf') {
      return ['.pdf'];
    }

    if (mimeType === 'image/jpeg') {
      return ['.jpg', '.jpeg'];
    }

    if (mimeType === 'image/png') {
      return ['.png'];
    }

    if (mimeType === 'image/webp') {
      return ['.webp'];
    }

    if (this.isFeedXmlMimeType(mimeType)) {
      return ['.xml'];
    }

    return [];
  }

  private isAllowedFeedXmlFile(originalName: string, mimeType: string) {
    return extname(originalName).toLowerCase() === '.xml' && this.isFeedXmlMimeType(mimeType);
  }

  private isFeedXmlMimeType(mimeType: string) {
    return FEED_XML_MIME_TYPES.includes(mimeType as (typeof FEED_XML_MIME_TYPES)[number]) || mimeType.endsWith('+xml');
  }

  private async findExistingFile(id: string) {
    const fileId = this.parseUuid(id, 'File is invalid');
    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return file;
  }

  private async findExistingFileWithVariants(id: string) {
    const fileId = this.parseUuid(id, 'File is invalid');
    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
      include: {
        variants: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return file;
  }

  private parseRequestedVariant(variant: string | null | undefined): RequestedFileVariant {
    const normalizedVariant = variant?.trim().toLowerCase();

    if (!normalizedVariant || normalizedVariant === 'original') {
      return {
        kind: 'original',
      };
    }

    if (normalizedVariant === 'thumbnail') {
      return {
        kind: 'variant',
        variant: FileVariantKind.THUMBNAIL,
        headerValue: 'thumbnail',
      };
    }

    if (normalizedVariant === 'card') {
      return {
        kind: 'variant',
        variant: FileVariantKind.CARD,
        headerValue: 'card',
      };
    }

    if (normalizedVariant === 'detail') {
      return {
        kind: 'variant',
        variant: FileVariantKind.DETAIL,
        headerValue: 'detail',
      };
    }

    throw new BadRequestException('File variant is invalid');
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private assertPrivateTrainingAudioKey(key: string) {
    if (
      key.length === 0 ||
      key.length > 512 ||
      !key.startsWith('training-audio/') ||
      key.includes('\\') ||
      !/^[a-z0-9./_-]+$/u.test(key) ||
      key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new BadRequestException('Private training audio key is invalid');
    }
  }
}
