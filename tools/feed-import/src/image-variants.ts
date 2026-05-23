import { createHash } from 'node:crypto';

import sharp from 'sharp';

export type FeedFileVariantKind = 'THUMBNAIL' | 'CARD' | 'DETAIL';

export const IMAGE_VARIANT_MIME_TYPE = 'image/webp';

export const IMAGE_VARIANT_SPECS: Record<FeedFileVariantKind, { width: number; quality: number; suffix: string }> = {
  THUMBNAIL: {
    width: 240,
    quality: 68,
    suffix: 'thumbnail',
  },
  CARD: {
    width: 640,
    quality: 72,
    suffix: 'card',
  },
  DETAIL: {
    width: 1440,
    quality: 78,
    suffix: 'detail',
  },
};

export const IMAGE_VARIANT_ORDER = ['THUMBNAIL', 'CARD', 'DETAIL'] as const;

const imageVariantSourceMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type GeneratedImageVariant = {
  variant: FeedFileVariantKind;
  key: string;
  body: Buffer;
  mimeType: typeof IMAGE_VARIANT_MIME_TYPE;
  width: number;
  height: number;
  sizeBytes: bigint;
  checksum: string;
};

export function isImageVariantSourceMimeType(mimeType: string | null | undefined) {
  return imageVariantSourceMimeTypes.has(mimeType?.trim().toLowerCase() ?? '');
}

export function createImageVariantKey(originalKey: string, variant: FeedFileVariantKind) {
  const spec = IMAGE_VARIANT_SPECS[variant];
  const slashIndex = originalKey.lastIndexOf('/');
  const directory = slashIndex >= 0 ? originalKey.slice(0, slashIndex) : '';
  const fileName = slashIndex >= 0 ? originalKey.slice(slashIndex + 1) : originalKey;
  const dotIndex = fileName.lastIndexOf('.');
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const variantFileName = `${baseName}.${spec.suffix}.webp`;

  return directory ? `${directory}/${variantFileName}` : variantFileName;
}

export async function generateImageVariants(input: Buffer, originalKey: string) {
  const variants: GeneratedImageVariant[] = [];

  for (const variant of IMAGE_VARIANT_ORDER) {
    const spec = IMAGE_VARIANT_SPECS[variant];
    const { data, info } = await sharp(input)
      .rotate()
      .resize({
        width: spec.width,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: spec.quality,
      })
      .toBuffer({
        resolveWithObject: true,
      });

    variants.push({
      variant,
      key: createImageVariantKey(originalKey, variant),
      body: data,
      mimeType: IMAGE_VARIANT_MIME_TYPE,
      width: info.width,
      height: info.height,
      sizeBytes: BigInt(data.length),
      checksum: createHash('sha256').update(data).digest('hex'),
    });
  }

  return variants;
}
