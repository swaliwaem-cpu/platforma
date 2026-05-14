import { FileStorage, FileVariantKind, PrismaClient } from '@prisma/client';

import {
  GeneratedImageVariant,
  IMAGE_VARIANT_ORDER,
  generateImageVariants,
  isImageVariantSourceMimeType,
} from './image-variants';
import { S3StorageService } from './s3-storage.service';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export type BackfillImageVariantsSummary = {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
};

type BackfillLogger = Pick<Console, 'info' | 'error'>;

type BackfillFileRecord = {
  id: string;
  key: string;
  mimeType: string | null;
  variants: Array<{
    variant: FileVariantKind;
  }>;
};

type BackfillPrisma = {
  file: {
    findMany: (args: {
      where: {
        mimeType: {
          in: string[];
        };
      };
      include: {
        variants: {
          select: {
            variant: true;
          };
        };
      };
      orderBy: {
        createdAt: 'asc';
      };
    }) => Promise<BackfillFileRecord[]>;
  };
  fileVariant: {
    upsert: (args: {
      where: {
        fileId_variant: {
          fileId: string;
          variant: FileVariantKind;
        };
      };
      update: FileVariantWriteData;
      create: FileVariantWriteData & {
        fileId: string;
        variant: FileVariantKind;
      };
    }) => Promise<unknown>;
  };
};

type BackfillStorage = {
  getBucket: () => string;
  getPublicUrl: (key: string) => string;
  getObject: (key: string) => Promise<Buffer>;
  putObject: (params: { key: string; body: Buffer; contentType: string }) => Promise<void>;
};

type FileVariantWriteData = {
  storage: FileStorage;
  bucket: string;
  key: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: bigint;
  checksum: string;
};

type BackfillImageVariantsOptions = {
  prisma: BackfillPrisma;
  storage: BackfillStorage;
  logger?: BackfillLogger;
};

export async function backfillImageVariants(options: BackfillImageVariantsOptions) {
  const logger = options.logger ?? console;
  const summary: BackfillImageVariantsSummary = {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
  };
  const files = await options.prisma.file.findMany({
    where: {
      mimeType: {
        in: IMAGE_MIME_TYPES,
      },
    },
    include: {
      variants: {
        select: {
          variant: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  for (const file of files) {
    summary.processed += 1;

    try {
      const missingVariantKinds = getMissingVariantKinds(file);

      if (missingVariantKinds.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const originalBuffer = await options.storage.getObject(file.key);
      const variants = (await generateImageVariants(originalBuffer, file.key)).filter((variant) =>
        missingVariantKinds.includes(variant.variant),
      );

      await upsertGeneratedVariants(options, file.id, variants);
      summary.created += variants.length;
    } catch (error) {
      summary.failed += 1;
      logger.error(
        JSON.stringify({
          fileId: file.id,
          key: file.key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  logger.info(JSON.stringify(summary));

  return summary;
}

export function getBackfillExitCode(summary: Pick<BackfillImageVariantsSummary, 'failed'>) {
  return summary.failed > 0 ? 1 : 0;
}

async function upsertGeneratedVariants(
  options: BackfillImageVariantsOptions,
  fileId: string,
  variants: GeneratedImageVariant[],
) {
  for (const variant of variants) {
    await options.storage.putObject({
      key: variant.key,
      body: variant.body,
      contentType: variant.mimeType,
    });

    await options.prisma.fileVariant.upsert({
      where: {
        fileId_variant: {
          fileId,
          variant: variant.variant,
        },
      },
      update: createFileVariantWriteData(options.storage, variant),
      create: {
        fileId,
        variant: variant.variant,
        ...createFileVariantWriteData(options.storage, variant),
      },
    });
  }
}

function createFileVariantWriteData(
  storage: BackfillStorage,
  variant: GeneratedImageVariant,
): FileVariantWriteData {
  return {
    storage: FileStorage.MINIO,
    bucket: storage.getBucket(),
    key: variant.key,
    url: storage.getPublicUrl(variant.key),
    mimeType: variant.mimeType,
    width: variant.width,
    height: variant.height,
    sizeBytes: variant.sizeBytes,
    checksum: variant.checksum,
  };
}

function getMissingVariantKinds(file: BackfillFileRecord) {
  if (!isImageVariantSourceMimeType(file.mimeType)) {
    return [];
  }

  const existingVariantKinds = new Set(file.variants.map((variant) => variant.variant));

  return IMAGE_VARIANT_ORDER.filter((variant) => !existingVariantKinds.has(variant));
}

async function runBackfillImageVariantsCli() {
  const prisma = new PrismaClient();
  const storage = new S3StorageService();

  try {
    const summary = await backfillImageVariants({
      prisma,
      storage,
      logger: console,
    });

    process.exitCode = getBackfillExitCode(summary);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runBackfillImageVariantsCli();
}
