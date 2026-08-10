import { createHmac, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable, InternalServerErrorException } from '@nestjs/common';

type SignedRequestOptions = {
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  bucket: string;
  key?: string;
  query?: Record<string, string | undefined>;
  body?: Buffer | NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
  payloadHash?: string;
};

export type S3ListedObject = {
  key: string;
  size: number | null;
  etag: string | null;
  lastModified: Date | null;
};

@Injectable()
export class S3StorageService {
  private readonly endpoint = normalizeEndpoint(process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  private readonly publicEndpoint = normalizeEndpoint(
    process.env.S3_PUBLIC_ENDPOINT ?? this.endpoint,
  );
  private readonly region = process.env.S3_REGION ?? 'us-east-1';
  private readonly accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'platforma';
  private readonly secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'platforma_password';
  private readonly bucket = process.env.MINIO_BUCKET ?? 'platforma';
  private readonly readyBuckets = new Set<string>();

  getBucket() {
    return this.bucket;
  }

  getPublicUrl(key: string, bucket = this.bucket) {
    return `${this.publicEndpoint}/${encodePath(bucket)}/${encodePath(key)}`;
  }

  async ensureBucket(bucket = this.bucket) {
    if (this.readyBuckets.has(bucket)) {
      return;
    }

    const headResponse = await this.signedFetch({
      method: 'HEAD',
      bucket,
    });

    if (headResponse.ok) {
      this.readyBuckets.add(bucket);
      return;
    }

    if (headResponse.status !== 404) {
      await this.throwStorageError('Cannot inspect MinIO bucket', headResponse);
    }

    const createResponse = await this.signedFetch({
      method: 'PUT',
      bucket,
    });

    if (!createResponse.ok && createResponse.status !== 409) {
      await this.throwStorageError('Cannot create MinIO bucket', createResponse);
    }

    this.readyBuckets.add(bucket);
  }

  async putObject(params: { key: string; body: Buffer; contentType: string; bucket?: string }) {
    const bucket = params.bucket ?? this.bucket;
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'PUT',
      bucket,
      key: params.key,
      body: params.body,
      contentType: params.contentType,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot upload file to MinIO', response);
    }
  }

  async putObjectFromFile(params: { key: string; filePath: string; contentType: string; checksum: string; contentLength: number; bucket?: string }) {
    const bucket = params.bucket ?? this.bucket;
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'PUT',
      bucket,
      key: params.key,
      body: createReadStream(params.filePath),
      contentType: params.contentType,
      payloadHash: params.checksum,
      contentLength: params.contentLength,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot upload file to MinIO', response);
    }
  }

  async getObject(key: string, bucket = this.bucket) {
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'GET',
      bucket,
      key,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot read file from MinIO', response);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async statObject(key: string, bucket = this.bucket) {
    await this.ensureBucket(bucket);
    const response = await this.signedFetch({ method: 'HEAD', bucket, key });
    if (response.status === 404) return null;
    if (!response.ok) await this.throwStorageError('Cannot inspect file in MinIO', response);
    const contentLength = Number(response.headers.get('content-length'));
    return {
      size: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
      etag: normalizeEtag(response.headers.get('etag')),
      lastModified: parseStorageDate(response.headers.get('last-modified')),
    };
  }

  async listObjects(input: {
    bucket?: string;
    prefix?: string;
    maxObjects: number;
  }): Promise<S3ListedObject[]> {
    const bucket = input.bucket ?? this.bucket;
    const objects: S3ListedObject[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.signedFetch({
        method: 'GET',
        bucket,
        query: {
          'list-type': '2',
          'max-keys': String(Math.min(1000, input.maxObjects - objects.length + 1)),
          prefix: input.prefix,
          'continuation-token': continuationToken,
        },
      });

      if (response.status === 404) return [];
      if (!response.ok) {
        await this.throwStorageError('Cannot list files in MinIO', response);
      }

      const page = parseS3ListObjectsV2(await response.text());
      objects.push(...page.objects);
      if (objects.length > input.maxObjects) {
        throw new InternalServerErrorException(
          `Cannot reconcile MinIO bucket: more than ${input.maxObjects} objects match the prefix`,
        );
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken ?? undefined : undefined;

      if (page.isTruncated && !continuationToken) {
        throw new InternalServerErrorException(
          'Cannot reconcile MinIO bucket: continuation token is missing',
        );
      }
    } while (continuationToken);

    return objects;
  }

  async getObjectToFile(params: { key: string; filePath: string; bucket?: string }) {
    const bucket = params.bucket ?? this.bucket;
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'GET',
      bucket,
      key: params.key,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot read file from MinIO', response);
    }
    if (!response.body) {
      throw new InternalServerErrorException('Cannot read file from MinIO: empty response body');
    }

    const reader = response.body.getReader();
    const checksum = createHash('sha256');
    let size = 0;
    const source = Readable.from((async function* () {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield Buffer.from(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    })());
    const meter = new Transform({
      transform(
        chunk: Buffer | string,
        encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
      ) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        size += buffer.length;
        checksum.update(buffer);
        callback(null, buffer);
      },
    });
    await pipeline(source, meter, createWriteStream(params.filePath, { flags: 'wx' }));
    return { size, checksum: checksum.digest('hex') };
  }

  async deleteObject(key: string, bucket = this.bucket) {
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'DELETE',
      bucket,
      key,
    });

    if (!response.ok && response.status !== 404) {
      await this.throwStorageError('Cannot delete file from MinIO', response);
    }
  }

  private async signedFetch(options: SignedRequestOptions) {
    const body = options.body;
    const payloadHash = options.payloadHash ?? createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.alloc(0)).digest('hex');
    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const url = this.buildObjectUrl(options.bucket, options.key, options.query);
    const signableHeaders: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const requestHeaders: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    if (options.contentType) {
      signableHeaders['content-type'] = options.contentType;
      requestHeaders['Content-Type'] = options.contentType;
    }

    if (options.contentLength !== undefined) {
      const contentLength = String(options.contentLength);

      signableHeaders['content-length'] = contentLength;
      requestHeaders['Content-Length'] = contentLength;
    }

    const signedHeaderNames = Object.keys(signableHeaders).sort();
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${normalizeHeaderValue(signableHeaders[name] ?? '')}\n`)
      .join('');
    const canonicalRequest = [
      options.method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', this.getSigningKey(shortDate))
      .update(stringToSign)
      .digest('hex');

    requestHeaders.Authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', ');

    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: options.method,
      headers: requestHeaders,
      body: (Buffer.isBuffer(body) ? new Uint8Array(body) : body) as BodyInit | undefined,
      ...(body && !Buffer.isBuffer(body) ? { duplex: 'half' } : {}),
    };

    return fetch(url, requestInit);
  }

  private buildObjectUrl(
    bucket: string,
    key?: string,
    query?: Record<string, string | undefined>,
  ) {
    const path = key ? `${encodePath(bucket)}/${encodePath(key)}` : encodePath(bucket);
    const url = new URL(`${this.endpoint}/${path}`);
    const canonicalQuery = Object.entries(query ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');

    if (canonicalQuery) url.search = canonicalQuery;

    return url;
  }

  private getSigningKey(shortDate: string) {
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, shortDate);
    const dateRegionKey = hmac(dateKey, this.region);
    const dateRegionServiceKey = hmac(dateRegionKey, 's3');

    return hmac(dateRegionServiceKey, 'aws4_request');
  }

  private async throwStorageError(message: string, response: Response): Promise<never> {
    const details = await response.text().catch(() => '');

    throw new InternalServerErrorException(
      details ? `${message}: ${response.status} ${details}` : `${message}: ${response.status}`,
    );
  }
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/u, '');
}

function encodePath(value: string) {
  return value.split('/').map((segment) => awsEncode(segment)).join('/');
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeHeaderValue(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, '');
}

function hmac(key: string | Buffer, value: string) {
  return createHmac('sha256', key).update(value).digest();
}

export function parseS3ListObjectsV2(xml: string) {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)].map((match) => {
    const contents = match[1] ?? '';
    const size = Number(readXmlTag(contents, 'Size'));

    return {
      key: decodeXml(readXmlTag(contents, 'Key') ?? ''),
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
      etag: normalizeEtag(decodeXml(readXmlTag(contents, 'ETag') ?? '')),
      lastModified: parseStorageDate(readXmlTag(contents, 'LastModified')),
    } satisfies S3ListedObject;
  }).filter((object) => object.key.length > 0);

  return {
    objects,
    isTruncated: readXmlTag(xml, 'IsTruncated') === 'true',
    nextContinuationToken: decodeXml(readXmlTag(xml, 'NextContinuationToken') ?? '') || null,
  };
}

function readXmlTag(xml: string, tag: string) {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'u'))?.[1] ?? null;
}

function decodeXml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/giu, (entity, code: string) => {
    if (code.toLowerCase().startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }
    return ({ amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' } as const)[
      code.toLowerCase() as 'amp' | 'apos' | 'gt' | 'lt' | 'quot'
    ] ?? entity;
  });
}

function normalizeEtag(value: string | null) {
  const normalized = value?.trim().replace(/^"|"$/gu, '') ?? '';

  return normalized || null;
}

function parseStorageDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}
