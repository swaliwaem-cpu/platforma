import { createHmac, createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';

type SignedRequestOptions = {
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  bucket: string;
  key?: string;
  query?: URLSearchParams;
  body?: Buffer | NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
  payloadHash?: string;
  metadata?: Record<string, string>;
};

export type StoredObjectMetadata = {
  exists: boolean;
  contentLength: number | null;
  contentType: string | null;
  sha256: string | null;
};

@Injectable()
export class S3StorageService implements OnModuleInit {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly endpoint = normalizeEndpoint(process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  private readonly publicEndpoint = normalizeEndpoint(
    process.env.S3_PUBLIC_ENDPOINT ?? this.endpoint,
  );
  private readonly region = process.env.S3_REGION ?? 'us-east-1';
  private readonly accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'platforma';
  private readonly secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'platforma_password';
  private readonly bucket = process.env.MINIO_BUCKET ?? 'platforma';
  private readonly trainingDocumentBucket =
    process.env.TRAINING_DOCUMENT_BUCKET ?? 'platforma-training-private';
  private readonly trainingAudioBucket =
    process.env.TRAINING_AUDIO_BUCKET?.trim() ||
    'platforma-training-audio-private';
  private readonly nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  private readonly readyBuckets = new Set<string>();

  async onModuleInit() {
    this.assertTrainingAudioConfiguration();
    await this.ensureBucket();
    await this.ensureBucket(this.trainingDocumentBucket);
    await this.ensureBucket(this.trainingAudioBucket);
    await this.verifyTrainingAudioBucketPrivacy();
  }

  getBucket() {
    return this.bucket;
  }

  getPublicUrl(key: string) {
    return `${this.publicEndpoint}/${encodePath(this.bucket)}/${encodePath(key)}`;
  }

  getTrainingDocumentBucket() {
    return this.trainingDocumentBucket;
  }

  getTrainingAudioBucket() {
    return this.trainingAudioBucket;
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

  async putObject(params: {
    key: string;
    body: Buffer;
    contentType: string;
    bucket?: string;
    metadata?: Record<string, string>;
  }) {
    const bucket = params.bucket ?? this.bucket;
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'PUT',
      bucket,
      key: params.key,
      body: params.body,
      contentType: params.contentType,
      metadata: params.metadata,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot upload file to MinIO', response);
    }
  }

  async putObjectFromFile(params: { key: string; filePath: string; contentType: string; checksum: string; contentLength: number }) {
    return this.putObjectFromFileToBucket({
      ...params,
      bucket: this.bucket,
    });
  }

  async putObjectFromFileToBucket(params: {
    key: string;
    filePath: string;
    contentType: string;
    checksum: string;
    contentLength: number;
    bucket: string;
    metadata?: Record<string, string>;
  }) {
    const bucket = params.bucket;
    await this.ensureBucket(bucket);

    const response = await this.signedFetch({
      method: 'PUT',
      bucket,
      key: params.key,
      body: createReadStream(params.filePath),
      contentType: params.contentType,
      payloadHash: params.checksum,
      contentLength: params.contentLength,
      metadata: params.metadata,
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

  async headObject(
    key: string,
    bucket = this.bucket,
  ): Promise<StoredObjectMetadata> {
    await this.ensureBucket(bucket);
    const response = await this.signedFetch({
      method: 'HEAD',
      bucket,
      key,
    });
    if (response.status === 404) {
      return {
        exists: false,
        contentLength: null,
        contentType: null,
        sha256: null,
      };
    }
    if (!response.ok) {
      await this.throwStorageError('Cannot inspect file in MinIO', response);
    }
    return {
      exists: true,
      contentLength: readPositiveIntegerHeader(
        response.headers.get('content-length'),
      ),
      contentType: normalizeContentType(
        response.headers.get('content-type'),
      ),
      sha256: normalizeSha256(
        response.headers.get('x-amz-meta-sha256'),
      ),
    };
  }

  async verifyTrainingAudioBucketPrivacy() {
    const bucket = this.trainingAudioBucket;
    await this.ensureBucket(bucket);
    await this.assertNoPublicBucketPolicy(bucket);
    await this.assertNoPublicBucketAcl(bucket);

    const key = `training-audio/privacy-probe/${randomUUID()}`;
    const body = Buffer.from(randomUUID(), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    let uploaded = false;
    try {
      await this.putObject({
        bucket,
        key,
        body,
        contentType: 'application/octet-stream',
        metadata: { sha256: checksum },
      });
      uploaded = true;
      const stored = await this.headObject(key, bucket);
      if (
        !stored.exists ||
        stored.contentLength !== body.length ||
        stored.sha256 !== checksum
      ) {
        throw new Error(
          'TRAINING_AUDIO_BUCKET privacy sentinel could not be verified',
        );
      }

      const anonymousObject = await fetch(
        this.buildObjectUrl(bucket, key),
        {
          method: 'GET',
          redirect: 'error',
        },
      ).catch(() => null);
      const anonymousList = await fetch(
        this.buildObjectUrl(
          bucket,
          undefined,
          new URLSearchParams({
            'list-type': '2',
            'max-keys': '1',
          }),
        ),
        {
          method: 'GET',
          redirect: 'error',
        },
      ).catch(() => null);
      this.assertAnonymousProbeDenied(
        anonymousObject,
        'anonymous object GET',
      );
      this.assertAnonymousProbeDenied(
        anonymousList,
        'anonymous bucket LIST',
      );
    } finally {
      if (uploaded) {
        await this.deleteObject(key, bucket);
      }
    }
  }

  private async signedFetch(options: SignedRequestOptions) {
    const body = options.body;
    const payloadHash = options.payloadHash ?? createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.alloc(0)).digest('hex');
    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const url = this.buildObjectUrl(
      options.bucket,
      options.key,
      options.query,
    );
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
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      const normalizedName = name.trim().toLowerCase();
      if (!/^[a-z0-9-]+$/u.test(normalizedName)) {
        throw new InternalServerErrorException(
          'S3 object metadata name is invalid',
        );
      }
      const headerName = `x-amz-meta-${normalizedName}`;
      const headerValue = normalizeHeaderValue(value);
      signableHeaders[headerName] = headerValue;
      requestHeaders[headerName] = headerValue;
    }

    const signedHeaderNames = Object.keys(signableHeaders).sort();
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${normalizeHeaderValue(signableHeaders[name] ?? '')}\n`)
      .join('');
    const canonicalRequest = [
      options.method,
      url.pathname,
      canonicalizeQuery(url.searchParams),
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

    return fetch(url, {
      ...requestInit,
      redirect: 'error',
    });
  }

  private buildObjectUrl(
    bucket: string,
    key?: string,
    query?: URLSearchParams,
  ) {
    const path = key ? `${encodePath(bucket)}/${encodePath(key)}` : encodePath(bucket);
    const url = new URL(`${this.endpoint}/${path}`);
    if (query) {
      url.search = query.toString();
    }
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

  private assertTrainingAudioConfiguration() {
    const configuredBucket = process.env.TRAINING_AUDIO_BUCKET?.trim() ?? '';
    if (this.nodeEnv === 'production' && !configuredBucket) {
      throw new Error(
        'TRAINING_AUDIO_BUCKET is required in production',
      );
    }
    if (
      this.nodeEnv === 'production' &&
      this.trainingAudioBucket === this.bucket
    ) {
      throw new Error(
        'TRAINING_AUDIO_BUCKET must differ from MINIO_BUCKET in production',
      );
    }
  }

  private async assertNoPublicBucketPolicy(bucket: string) {
    const response = await this.signedFetch({
      method: 'GET',
      bucket,
      query: new URLSearchParams({ policy: '' }),
    });
    if (response.status === 404 || response.status === 501) return;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return;
      if (this.requiresFailClosedPrivacy()) {
        throw new Error(
          'TRAINING_AUDIO_BUCKET policy could not be verified',
        );
      }
      this.logger.warn(
        'Training audio bucket policy could not be verified; anonymous probes remain required',
      );
      return;
    }
    const text = await response.text();
    let policy: unknown;
    try {
      policy = JSON.parse(text);
    } catch {
      throw new Error(
        'TRAINING_AUDIO_BUCKET policy response is invalid',
      );
    }
    if (containsPublicPolicy(policy)) {
      throw new Error('TRAINING_AUDIO_BUCKET policy allows public access');
    }
  }

  private async assertNoPublicBucketAcl(bucket: string) {
    const response = await this.signedFetch({
      method: 'GET',
      bucket,
      query: new URLSearchParams({ acl: '' }),
    });
    if (response.status === 404 || response.status === 501) return;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return;
      if (this.requiresFailClosedPrivacy()) {
        throw new Error(
          'TRAINING_AUDIO_BUCKET ACL could not be verified',
        );
      }
      this.logger.warn(
        'Training audio bucket ACL could not be verified; anonymous probes remain required',
      );
      return;
    }
    const acl = await response.text();
    if (
      /http:\/\/acs\.amazonaws\.com\/groups\/global\/(?:AllUsers|AuthenticatedUsers)/u.test(
        acl,
      ) &&
      /<Permission>\s*(?:READ|FULL_CONTROL)\s*<\/Permission>/u.test(
        acl,
      )
    ) {
      throw new Error('TRAINING_AUDIO_BUCKET ACL allows public access');
    }
  }

  private assertAnonymousProbeDenied(
    response: Response | null,
    probe: string,
  ) {
    if (!response) {
      if (this.requiresFailClosedPrivacy()) {
        throw new Error(
          `TRAINING_AUDIO_BUCKET ${probe} was inconclusive`,
        );
      }
      this.logger.warn(
        `Training audio bucket ${probe} was inconclusive outside production`,
      );
      return;
    }
    if (response.status === 200) {
      throw new Error(
        `TRAINING_AUDIO_BUCKET permits ${probe}`,
      );
    }
    if (response.status !== 401 && response.status !== 403) {
      if (this.requiresFailClosedPrivacy()) {
        throw new Error(
          `TRAINING_AUDIO_BUCKET ${probe} returned ambiguous status`,
        );
      }
      this.logger.warn(
        `Training audio bucket ${probe} returned ambiguous status ${response.status}`,
      );
    }
  }

  private requiresFailClosedPrivacy() {
    return this.nodeEnv === 'production';
  }
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/u, '');
}

function encodePath(value: string) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function canonicalizeQuery(params: URLSearchParams) {
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder;
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
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

function readPositiveIntegerHeader(value: string | null) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeContentType(value: string | null) {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

function normalizeSha256(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/u.test(normalized)
    ? normalized
    : null;
}

function containsPublicPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const policy = value as {
    Statement?: unknown;
  };
  const statements = Array.isArray(policy.Statement)
    ? policy.Statement
    : policy.Statement
      ? [policy.Statement]
      : [];
  return statements.some((statement) => {
    if (!statement || typeof statement !== 'object') return false;
    const current = statement as {
      Effect?: unknown;
      Principal?: unknown;
      Action?: unknown;
    };
    if (current.Effect !== 'Allow') return false;
    if (!containsWildcardPrincipal(current.Principal)) {
      return false;
    }
    const actions = Array.isArray(current.Action)
      ? current.Action
      : [current.Action];
    return actions.some(
      (action) =>
        typeof action === 'string' &&
        [
          's3:*',
          's3:GetObject',
          's3:ListBucket',
        ].some(
          (publicAction) =>
            action === publicAction ||
            (action.endsWith('*') &&
              publicAction.startsWith(action.slice(0, -1))),
        ),
    );
  });
}

function containsWildcardPrincipal(value: unknown): boolean {
  if (value === '*') return true;
  if (Array.isArray(value)) {
    return value.some(containsWildcardPrincipal);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsWildcardPrincipal);
}
