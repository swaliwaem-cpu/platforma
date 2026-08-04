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
  signal?: AbortSignal;
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
  private readonly trainingMaterialBucket =
    process.env.TRAINING_MATERIAL_BUCKET ?? 'platforma-training-materials';
  private readonly trainingAudioBucket =
    process.env.TRAINING_AUDIO_BUCKET?.trim() ||
    'platforma-training-audio-private';
  private readonly nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  private readonly readyBuckets = new Set<string>();
  private readonly verifiedTrainingAudioBuckets = new Set<string>();
  private trainingAudioPrivacyVerifiedAt: Date | null = null;

  async onModuleInit() {
    this.assertTrainingAudioConfiguration();
    await this.ensureBucket();
    await this.ensureBucket(this.trainingMaterialBucket);
    await this.ensureBucket(this.trainingAudioBucket);
    await this.verifyTrainingAudioBucketPrivacy();
  }

  getBucket() {
    return this.bucket;
  }

  getPublicUrl(key: string, bucket = this.bucket) {
    return `${this.publicEndpoint}/${encodePath(bucket)}/${encodePath(key)}`;
  }

  getTrainingMaterialBucket() {
    return this.trainingMaterialBucket;
  }

  getTrainingAudioBucket() {
    return this.trainingAudioBucket;
  }

  getTrainingAudioPrivacyStatus() {
    return {
      status: this.trainingAudioPrivacyVerifiedAt
        ? ('VERIFIED' as const)
        : ('NOT_VERIFIED' as const),
      checkedAt: this.trainingAudioPrivacyVerifiedAt?.toISOString() ?? null,
    };
  }

  async ensureBucket(bucket = this.bucket, signal?: AbortSignal) {
    if (this.readyBuckets.has(bucket)) {
      return;
    }

    const headResponse = await this.signedFetch({
      method: 'HEAD',
      bucket,
      signal,
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
      signal,
    });

    if (!createResponse.ok && createResponse.status !== 409) {
      await this.throwStorageError('Cannot create MinIO bucket', createResponse);
    }

    this.readyBuckets.add(bucket);
  }

  private async ensureExistingBucket(
    bucket: string,
    signal?: AbortSignal,
  ) {
    if (this.readyBuckets.has(bucket)) {
      return;
    }

    const headResponse = await this.signedFetch({
      method: 'HEAD',
      bucket,
      signal,
    });
    if (headResponse.ok) {
      this.readyBuckets.add(bucket);
      return;
    }
    if (headResponse.status === 404) {
      throw new Error(
        'Persisted training audio bucket is missing and requires manual review',
      );
    }
    await this.throwStorageError(
      'Cannot inspect persisted training audio bucket',
      headResponse,
    );
  }

  async ensurePersistedTrainingAudioBucket(
    bucket: string,
    signal?: AbortSignal,
  ) {
    if (this.verifiedTrainingAudioBuckets.has(bucket)) {
      return;
    }
    await this.ensureExistingBucket(bucket, signal);
    await this.verifyTrainingAudioBucketPrivacyInternal(bucket, false);
  }

  async putObject(params: {
    key: string;
    body: Buffer;
    contentType: string;
    bucket?: string;
    metadata?: Record<string, string>;
    signal?: AbortSignal;
  }) {
    const bucket = params.bucket ?? this.bucket;
    await this.ensureBucket(bucket, params.signal);

    const response = await this.signedFetch({
      method: 'PUT',
      bucket,
      key: params.key,
      body: params.body,
      contentType: params.contentType,
      metadata: params.metadata,
      signal: params.signal,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot upload file to MinIO', response);
    }
  }

  async putObjectFromFile(params: {
    key: string;
    filePath: string;
    contentType: string;
    checksum: string;
    contentLength: number;
    bucket?: string;
  }) {
    return this.putObjectFromFileToBucket({
      ...params,
      bucket: params.bucket ?? this.bucket,
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

  async getObject(
    key: string,
    bucket = this.bucket,
    signal?: AbortSignal,
  ) {
    await this.ensureBucket(bucket, signal);

    const response = await this.signedFetch({
      method: 'GET',
      bucket,
      key,
      signal,
    });

    if (!response.ok) {
      await this.throwStorageError('Cannot read file from MinIO', response);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(
    key: string,
    bucket = this.bucket,
    signal?: AbortSignal,
  ) {
    await this.ensureBucket(bucket, signal);

    const response = await this.signedFetch({
      method: 'DELETE',
      bucket,
      key,
      signal,
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
    await this.verifyTrainingAudioBucketPrivacyInternal(bucket, true);
  }

  private async verifyTrainingAudioBucketPrivacyInternal(
    bucket: string,
    allowCreate: boolean,
  ) {
    if (this.verifiedTrainingAudioBuckets.has(bucket)) {
      return;
    }
    if (allowCreate) {
      await this.ensureBucket(bucket);
    } else {
      await this.ensureExistingBucket(bucket);
    }
    let staticValidationError: unknown = null;
    for (const validation of [
      () => this.assertNoPublicBucketPolicy(bucket),
      () => this.assertNoPublicBucketAcl(bucket),
    ]) {
      try {
        await validation();
      } catch (error) {
        staticValidationError ??= error;
      }
    }

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
      const anonymousDelete = await fetch(
        this.buildObjectUrl(bucket, key),
        {
          method: 'DELETE',
          redirect: 'error',
        },
      ).catch(() => null);
      this.assertAnonymousProbeDenied(
        anonymousDelete,
        'anonymous object DELETE',
      );
    } finally {
      if (uploaded) {
        await this.cleanupPrivacySentinel(bucket, key);
      }
    }
    await this.assertAnonymousPutDenied(bucket);
    if (staticValidationError) {
      throw staticValidationError;
    }
    this.verifiedTrainingAudioBuckets.add(bucket);
    if (bucket === this.trainingAudioBucket) {
      this.trainingAudioPrivacyVerifiedAt = new Date();
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
      signal: options.signal,
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
    if (containsUnsafePublicPolicy(policy, this.requiresFailClosedPrivacy())) {
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
    if (containsUnsafePublicAcl(acl)) {
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
    if (response.ok) {
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

  private async assertAnonymousPutDenied(bucket: string) {
    const key = `training-audio/privacy-probe/${randomUUID()}`;
    const body = new Uint8Array(Buffer.from('private-audio-write-probe', 'utf8'));
    try {
      const response = await fetch(
        this.buildObjectUrl(bucket, key),
        {
          method: 'PUT',
          body,
          redirect: 'error',
        },
      ).catch(() => null);
      this.assertAnonymousProbeDenied(
        response,
        'anonymous object PUT',
      );
    } finally {
      await this.cleanupPrivacySentinel(bucket, key);
    }
  }

  private async deletePrivacySentinel(bucket: string, key: string) {
    const response = await this.signedFetch({
      method: 'DELETE',
      bucket,
      key,
    });
    if (response.ok || response.status === 404) {
      return;
    }
    const details = await response.text().catch(() => '');
    if (containsNoSuchKeyError(details)) {
      return;
    }
    throw new Error('Sentinel delete failed');
  }

  private async cleanupPrivacySentinel(bucket: string, key: string) {
    try {
      await this.deletePrivacySentinel(bucket, key);
      if ((await this.headObject(key, bucket)).exists) {
        throw new Error('Sentinel object still exists after delete');
      }
    } catch {
      this.logger.error(
        'Training audio privacy sentinel cleanup failed',
      );
      throw new Error(
        'TRAINING_AUDIO_BUCKET privacy sentinel cleanup failed',
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

function containsNoSuchKeyError(value: string) {
  if (
    /<(?:[A-Za-z_][\w.-]*:)?Code\b[^>]*>\s*NoSuchKey\s*<\/(?:[A-Za-z_][\w.-]*:)?Code\s*>/iu.test(
      value,
    )
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as {
      Code?: unknown;
      code?: unknown;
    };
    return parsed.Code === 'NoSuchKey' || parsed.code === 'NoSuchKey';
  } catch {
    return false;
  }
}

const PROTECTED_PUBLIC_S3_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetObjectAttributes',
  's3:GetObjectAcl',
  's3:GetObjectVersionAcl',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
  's3:ListMultipartUploadParts',
  's3:PutObject',
  's3:PutObjectAcl',
  's3:PutObjectTagging',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:DeleteObjectTagging',
  's3:AbortMultipartUpload',
  's3:CreateMultipartUpload',
  's3:RestoreObject',
  's3:PutBucketPolicy',
  's3:PutBucketAcl',
  's3:DeleteBucket',
] as const;

function containsUnsafePublicPolicy(
  value: unknown,
  failClosed: boolean,
): boolean {
  if (!value || typeof value !== 'object') return failClosed;
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
      NotAction?: unknown;
      Condition?: unknown;
    };
    if (
      typeof current.Effect !== 'string' ||
      current.Effect.toLowerCase() !== 'allow'
    ) {
      return false;
    }
    if (!containsWildcardPrincipal(current.Principal)) {
      return false;
    }
    if (current.NotAction !== undefined) return failClosed;
    const actions = normalizePolicyActions(current.Action);
    if (!actions) return failClosed;
    return actions.some(actionGrantsProtectedPublicCapability);
  });
}

function containsWildcardPrincipal(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === '*';
  if (Array.isArray(value)) {
    return value.some(containsWildcardPrincipal);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsWildcardPrincipal);
}

function normalizePolicyActions(value: unknown): string[] | null {
  const actions = Array.isArray(value) ? value : [value];
  if (
    actions.length === 0 ||
    actions.some((action) => typeof action !== 'string')
  ) {
    return null;
  }
  const normalized = actions
    .map((action) => action.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

function actionGrantsProtectedPublicCapability(pattern: string) {
  const expression = wildcardPatternToRegExp(pattern);
  return PROTECTED_PUBLIC_S3_ACTIONS.some((action) =>
    expression.test(action),
  );
}

function wildcardPatternToRegExp(value: string) {
  const escaped = value.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const pattern = escaped
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.');
  return new RegExp(`^${pattern}$`, 'iu');
}

function containsUnsafePublicAcl(value: string) {
  const publicGroup =
    /http:\/\/acs\.amazonaws\.com\/groups\/global\/(?:AllUsers|AuthenticatedUsers)/iu;
  const permission =
    /<(?:[A-Za-z_][\w.-]*:)?Permission\b[^>]*>\s*([^<]+?)\s*<\/(?:[A-Za-z_][\w.-]*:)?Permission\s*>/iu;
  const grants = value.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?Grant\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Grant\s*>/giu,
  );
  for (const grant of grants) {
    const body = grant[1] ?? '';
    if (publicGroup.test(body) && permission.test(body)) return true;
  }
  return publicGroup.test(value) && permission.test(value);
}
