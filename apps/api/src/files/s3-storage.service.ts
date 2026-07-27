import { createHmac, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { Injectable, InternalServerErrorException, OnModuleInit } from '@nestjs/common';

type SignedRequestOptions = {
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  bucket: string;
  key?: string;
  body?: Buffer | NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
  payloadHash?: string;
};

@Injectable()
export class S3StorageService implements OnModuleInit {
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
    process.env.TRAINING_AUDIO_BUCKET ?? 'platforma-training-audio-private';
  private readonly readyBuckets = new Set<string>();

  async onModuleInit() {
    await this.ensureBucket();
    await this.ensureBucket(this.trainingDocumentBucket);
    await this.ensureBucket(this.trainingAudioBucket);
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

  async putObjectFromFile(params: { key: string; filePath: string; contentType: string; checksum: string; contentLength: number }) {
    return this.putObjectFromFileToBucket({
      ...params,
      bucket: this.bucket,
    });
  }

  async putObjectFromFileToBucket(params: { key: string; filePath: string; contentType: string; checksum: string; contentLength: number; bucket: string }) {
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

  private async signedFetch(options: SignedRequestOptions) {
    const body = options.body;
    const payloadHash = options.payloadHash ?? createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.alloc(0)).digest('hex');
    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const url = this.buildObjectUrl(options.bucket, options.key);
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
      '',
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

  private buildObjectUrl(bucket: string, key?: string) {
    const path = key ? `${encodePath(bucket)}/${encodePath(key)}` : encodePath(bucket);

    return new URL(`${this.endpoint}/${path}`);
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
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
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
