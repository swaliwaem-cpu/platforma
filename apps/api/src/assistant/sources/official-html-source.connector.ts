import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const defaultTimeoutMs = 10_000;
const defaultMaximumResponseBytes = 5 * 1024 * 1024;
const defaultMaximumRedirects = 3;
const supportedContentTypes = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'application/ld+json',
]);

type ResolvedAddress = { address: string; family: number };

export type SourceConnectorRegistryEntry = {
  id: string;
  canonicalUrl: string;
  connectorKey: string;
  connectorConfig: unknown;
};

export type SourceConnectorFetchResult = {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  checksum: string;
  payload: Buffer;
  etag: string | null;
  lastModified: string | null;
  redirects: string[];
};

export class SourceConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = 'SourceConnectorError';
  }
}

export type OfficialHtmlSourceConnectorOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
};

export class OfficialHtmlSourceConnector {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly allowHttp: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;

  constructor(options: OfficialHtmlSourceConnectorOptions = {}) {
    this.timeoutMs = boundedInteger(options.timeoutMs, defaultTimeoutMs, 10, 120_000);
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      defaultMaximumResponseBytes,
      1,
      25 * 1024 * 1024,
    );
    this.maxRedirects = boundedInteger(options.maxRedirects, defaultMaximumRedirects, 0, 10);
    this.allowHttp = options.allowHttp === true;
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
    this.resolveHost = options.resolveHost ?? (async (hostname) => {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      return addresses.map(({ address, family }) => ({ address, family }));
    });
  }

  async fetch(source: SourceConnectorRegistryEntry): Promise<SourceConnectorFetchResult> {
    if (source.connectorKey !== 'OFFICIAL_HTML') {
      throw new SourceConnectorError('SOURCE_CONNECTOR_UNSUPPORTED', false);
    }
    const canonicalUrl = this.parseUrl(source.canonicalUrl);
    const allowedHosts = this.readAllowedHosts(source.connectorConfig, canonicalUrl.hostname);
    const redirects: string[] = [];
    let currentUrl = canonicalUrl;

    for (let redirectIndex = 0; ; redirectIndex += 1) {
      if (!allowedHosts.has(normalizeHostname(currentUrl.hostname))) {
        throw new SourceConnectorError('SOURCE_REDIRECT_HOST_NOT_ALLOWED', false);
      }
      const response = await this.fetchOnce(currentUrl);
      if (response.redirectLocation !== null) {
        if (redirectIndex >= this.maxRedirects) {
          throw new SourceConnectorError('SOURCE_REDIRECT_LIMIT', false, response.statusCode);
        }
        currentUrl = this.parseUrl(new URL(response.redirectLocation, currentUrl).toString());
        redirects.push(currentUrl.toString());
        continue;
      }

      return {
        finalUrl: currentUrl.toString(),
        statusCode: response.statusCode,
        contentType: response.contentType,
        checksum: createHash('sha256').update(response.payload).digest('hex'),
        payload: response.payload,
        etag: response.etag,
        lastModified: response.lastModified,
        redirects,
      };
    }
  }

  private async fetchOnce(url: URL): Promise<{
    statusCode: number;
    contentType: string;
    payload: Buffer;
    etag: string | null;
    lastModified: string | null;
    redirectLocation: string | null;
  }> {
    const addresses = await this.resolveAddresses(url.hostname);
    const address = addresses[0]!;
    const response = await this.request(url, address.address);
    const statusCode = response.statusCode ?? 0;
    const redirectLocation = readSingleHeader(response.headers.location);

    if (statusCode >= 300 && statusCode < 400 && redirectLocation) {
      response.resume();
      return {
        statusCode,
        contentType: '',
        payload: Buffer.alloc(0),
        etag: null,
        lastModified: null,
        redirectLocation,
      };
    }
    if (statusCode < 200 || statusCode >= 300) {
      response.resume();
      const retryable = statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
      throw new SourceConnectorError(
        retryable ? 'SOURCE_HTTP_RETRYABLE' : 'SOURCE_HTTP_NON_RETRYABLE',
        retryable,
        statusCode,
      );
    }

    const contentType = normalizeContentType(readSingleHeader(response.headers['content-type']));
    if (!supportedContentTypes.has(contentType)) {
      response.resume();
      throw new SourceConnectorError('SOURCE_CONTENT_TYPE_UNSUPPORTED', false, statusCode);
    }

    const payload = await this.readPayload(response, readSingleHeader(response.headers['content-encoding']));
    return {
      statusCode,
      contentType,
      payload,
      etag: readSingleHeader(response.headers.etag),
      lastModified: readSingleHeader(response.headers['last-modified']),
      redirectLocation: null,
    };
  }

  private async resolveAddresses(hostname: string) {
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolveHost(hostname);
    } catch {
      throw new SourceConnectorError('SOURCE_DNS_FAILED', true);
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isIP(address) === 0)) {
      throw new SourceConnectorError('SOURCE_DNS_FAILED', true);
    }
    if (!this.allowPrivateNetwork && addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new SourceConnectorError('SOURCE_DNS_PRIVATE_ADDRESS', false);
    }
    return addresses;
  }

  private request(url: URL, address: string) {
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? requestHttps : requestHttp)({
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        servername: url.protocol === 'https:' ? url.hostname : undefined,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/ld+json,application/json;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          host: url.host,
          'user-agent': 'PlatformaKnowledgeSource/1.0',
        },
      }, resolve);
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new SourceConnectorError('SOURCE_FETCH_TIMEOUT', true));
      });
      request.on('error', (error) => {
        reject(error instanceof SourceConnectorError
          ? error
          : new SourceConnectorError('SOURCE_NETWORK_FAILED', true));
      });
      request.end();
    });
  }

  private async readPayload(
    response: import('node:http').IncomingMessage,
    contentEncodingHeader: string | null,
  ) {
    const contentEncoding = (contentEncodingHeader ?? 'identity').trim().toLocaleLowerCase('en-US');
    const stream = contentEncoding === 'identity'
      ? response
      : contentEncoding === 'gzip'
        ? response.pipe(createGunzip())
        : contentEncoding === 'deflate'
          ? response.pipe(createInflate())
          : contentEncoding === 'br'
            ? response.pipe(createBrotliDecompress())
            : null;
    if (!stream) {
      response.resume();
      throw new SourceConnectorError('SOURCE_CONTENT_ENCODING_UNSUPPORTED', false, response.statusCode ?? null);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > this.maxResponseBytes) {
          response.destroy();
          throw new SourceConnectorError('SOURCE_RESPONSE_TOO_LARGE', false, response.statusCode ?? null);
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (error instanceof SourceConnectorError) throw error;
      throw new SourceConnectorError('SOURCE_RESPONSE_DECODE_FAILED', false, response.statusCode ?? null);
    }
    return Buffer.concat(chunks, totalBytes);
  }

  private parseUrl(value: string) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new SourceConnectorError('SOURCE_URL_INVALID', false);
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new SourceConnectorError('SOURCE_URL_INVALID', false);
    }
    if (parsed.protocol !== 'https:' && !(this.allowHttp && parsed.protocol === 'http:')) {
      throw new SourceConnectorError('SOURCE_PROTOCOL_NOT_ALLOWED', false);
    }
    return parsed;
  }

  private readAllowedHosts(value: unknown, canonicalHostname: string) {
    const hosts = new Set([normalizeHostname(canonicalHostname)]);
    if (!isRecord(value) || value.allowedHosts === undefined) return hosts;
    if (!Array.isArray(value.allowedHosts) || value.allowedHosts.length > 10) {
      throw new SourceConnectorError('SOURCE_CONNECTOR_CONFIG_INVALID', false);
    }
    for (const host of value.allowedHosts) {
      if (typeof host !== 'string' || !isValidHostname(host)) {
        throw new SourceConnectorError('SOURCE_CONNECTOR_CONFIG_INVALID', false);
      }
      hosts.add(normalizeHostname(host));
    }
    return hosts;
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Number.isInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}

function readSingleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeContentType(value: string | null) {
  return (value ?? '').split(';', 1)[0]!.trim().toLocaleLowerCase('en-US');
}

function normalizeHostname(value: string) {
  return value.trim().toLocaleLowerCase('en-US').replace(/\.$/u, '');
}

function isValidHostname(value: string) {
  const normalized = normalizeHostname(value);
  return normalized.length > 0
    && normalized.length <= 253
    && !normalized.includes('/')
    && !normalized.includes(':')
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(normalized);
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a !== 0
    && a !== 10
    && a !== 127
    && !(a === 100 && b! >= 64 && b! <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b! >= 16 && b! <= 31)
    && !(a === 192 && b === 0)
    && !(a === 192 && b === 168)
    && !(a === 198 && (b === 18 || b === 19))
    && !(a! >= 224);
}

function isPublicIpv6(address: string) {
  const normalized = address.toLocaleLowerCase('en-US').split('%', 1)[0]!;
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/u.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8:')) return false;
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    return isIP(embedded) === 4 && isPublicIpv4(embedded);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
