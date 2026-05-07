import { basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { File, FileStorage } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOWED_FILE_MIME_TYPES,
  IMAGE_MAX_SIZE_BYTES,
  IMAGE_MIME_TYPES,
  PDF_MAX_SIZE_BYTES,
  PDF_MIME_TYPES,
} from './file-upload.constants';
import { S3StorageService } from './s3-storage.service';
import { UploadedFile } from './uploaded-file.type';

export type UploadFileKind = 'generic' | 'image' | 'pdf';

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
  ) {}

  async uploadFile(file: UploadedFile | undefined, actor: AuthenticatedUser, kind: UploadFileKind) {
    const validatedFile = this.validateUploadedFile(file, kind);
    const checksum = createHash('sha256').update(validatedFile.buffer).digest('hex');
    const key = this.createStorageKey(validatedFile.originalname, validatedFile.mimetype);

    await this.storage.putObject({
      key,
      body: validatedFile.buffer,
      contentType: validatedFile.mimetype,
    });

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
      },
    });

    return {
      file: this.serializeFile(storedFile),
    };
  }

  async getById(id: string) {
    const file = await this.findExistingFile(id);

    return {
      file: this.serializeFile(file),
    };
  }

  async getContent(id: string) {
    const file = await this.findExistingFile(id);
    const buffer = await this.storage.getObject(file.key);

    return {
      file,
      buffer,
    };
  }

  async delete(id: string) {
    const fileId = this.parseUuid(id, 'File is invalid');
    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
      include: {
        _count: {
          select: {
            objectImages: true,
            objectFiles: true,
          },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file._count.objectImages > 0 || file._count.objectFiles > 0) {
      throw new ConflictException('File is linked to an object and cannot be deleted');
    }

    await this.storage.deleteObject(file.key);
    await this.prisma.file.delete({
      where: {
        id: file.id,
      },
    });
  }

  async deleteUnlinkedFile(id: string) {
    await this.delete(id).catch(() => undefined);
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

  private validateUploadedFile(file: UploadedFile | undefined, kind: UploadFileKind) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('File is required');
    }

    const mimeType = file.mimetype.trim().toLowerCase();
    const size = file.size || file.buffer.length;
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
      originalname: basename(file.originalname || 'file'),
      size,
      buffer: file.buffer,
    };
  }

  private getAllowedMimeTypes(kind: UploadFileKind) {
    if (kind === 'image') {
      return new Set<string>(IMAGE_MIME_TYPES);
    }

    if (kind === 'pdf') {
      return new Set<string>(PDF_MIME_TYPES);
    }

    return new Set<string>(ALLOWED_FILE_MIME_TYPES);
  }

  private getMaxSize(kind: UploadFileKind, mimeType: string) {
    if (kind === 'image' || IMAGE_MIME_TYPES.includes(mimeType as (typeof IMAGE_MIME_TYPES)[number])) {
      return IMAGE_MAX_SIZE_BYTES;
    }

    return PDF_MAX_SIZE_BYTES;
  }

  private getMimeTypeError(kind: UploadFileKind) {
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

    return [];
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

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }
}
