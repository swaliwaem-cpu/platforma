import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { TextDecoder } from 'node:util';

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  TRAINING_OFFICIAL_URL_CONNECT_TIMEOUT_MS,
  TRAINING_OFFICIAL_URL_MAX_REDIRECTS,
  TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES,
  TRAINING_OFFICIAL_URL_READ_TIMEOUT_MS,
  TRAINING_OFFICIAL_URL_TOTAL_TIMEOUT_MS,
} from './training-official-url.config';

const ALLOWED_CONTENT_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(api[-_]?key|auth|code|credential|jwt|key|password|secret|session|sig|signature|signed|token)(?:$|[_-])/iu;
const ipv4NetworkBlockList = createIpv4NetworkBlockList();
const ipv6NetworkBlockList = createIpv6NetworkBlockList();
const ipv6GlobalUnicastBlockList = createIpv6GlobalUnicastBlockList();

export type TrainingOfficialUrlAddress = {
  address: string;
  family: 4 | 6;
};

export type TrainingOfficialUrlDnsResolver = (
  hostname: string,
) => Promise<TrainingOfficialUrlAddress[]>;

export type TrainingOfficialUrlHttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

export type TrainingOfficialUrlHttpRequest = (input: {
  url: URL;
  addresses: TrainingOfficialUrlAddress[];
  deadlineAt: number;
}) => Promise<TrainingOfficialUrlHttpResponse>;

export const TRAINING_OFFICIAL_URL_DNS_RESOLVER = Symbol(
  'TRAINING_OFFICIAL_URL_DNS_RESOLVER',
);
export const TRAINING_OFFICIAL_URL_HTTP_REQUEST = Symbol(
  'TRAINING_OFFICIAL_URL_HTTP_REQUEST',
);

export type TrainingOfficialUrlFetchResult = {
  normalizedUrl: string;
  finalUrl: string;
  hostname: string;
  contentType: 'application/xhtml+xml' | 'text/html';
  contentHash: string;
  body: Buffer;
  text: string;
  metadata: {
    statusCode: number;
    contentType: string;
    contentLength: number;
    redirectCount: number;
    redirectHosts: string[];
    etag: string | null;
    lastModified: string | null;
  };
};

export class TrainingOfficialUrlFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TrainingOfficialUrlFetchError';
  }
}

@Injectable()
export class TrainingOfficialUrlFetcher {
  private readonly resolveDns: TrainingOfficialUrlDnsResolver;
  private readonly requestUrl: TrainingOfficialUrlHttpRequest;

  constructor(
    @Optional()
    @Inject(TRAINING_OFFICIAL_URL_DNS_RESOLVER)
    resolveDns?: TrainingOfficialUrlDnsResolver,
    @Optional()
    @Inject(TRAINING_OFFICIAL_URL_HTTP_REQUEST)
    requestUrl?: TrainingOfficialUrlHttpRequest,
  ) {
    this.resolveDns = resolveDns ?? resolveOfficialUrlDns;
    this.requestUrl = requestUrl ?? requestOfficialUrl;
  }

  async fetch(input: {
    url: string;
    confirmedOfficialHost: string;
    timeoutMs?: number;
  }): Promise<TrainingOfficialUrlFetchResult> {
    const confirmedHost = normalizeOfficialHostname(
      input.confirmedOfficialHost,
    );
    const initialUrl = normalizeOfficialUrl(input.url);

    if (initialUrl.hostname !== confirmedHost) {
      throw new TrainingOfficialUrlFetchError(
        'OFFICIAL_HOST_MISMATCH',
        'Подтверждённый официальный домен не совпадает с адресом страницы',
      );
    }

    const normalizedUrl = initialUrl.toString();
    const deadlineAt =
      Date.now() +
      Math.min(
        input.timeoutMs ?? TRAINING_OFFICIAL_URL_TOTAL_TIMEOUT_MS,
        TRAINING_OFFICIAL_URL_TOTAL_TIMEOUT_MS,
      );
    const redirectHosts: string[] = [];
    let currentUrl = initialUrl;

    for (
      let redirectCount = 0;
      redirectCount <= TRAINING_OFFICIAL_URL_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      assertBeforeDeadline(deadlineAt);
      assertConfirmedHost(currentUrl, confirmedHost);
      const addresses = await resolveBeforeDeadline(
        this.resolveDns(currentUrl.hostname),
        deadlineAt,
      );
      assertBeforeDeadline(deadlineAt);
      assertPublicAddresses(addresses);
      const response = await this.requestUrl({
        url: currentUrl,
        addresses,
        deadlineAt,
      });

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirectCount === TRAINING_OFFICIAL_URL_MAX_REDIRECTS) {
          throw new TrainingOfficialUrlFetchError(
            'TOO_MANY_REDIRECTS',
            'Страница превысила допустимое количество перенаправлений',
          );
        }
        const location = readHeader(response.headers, 'location');
        if (!location) {
          throw new TrainingOfficialUrlFetchError(
            'INVALID_REDIRECT',
            'Сайт вернул перенаправление без адреса назначения',
          );
        }

        currentUrl = normalizeOfficialUrl(new URL(location, currentUrl).toString());
        assertConfirmedHost(currentUrl, confirmedHost);
        redirectHosts.push(currentUrl.hostname);
        continue;
      }

      if (response.statusCode !== 200) {
        throw new TrainingOfficialUrlFetchError(
          'UPSTREAM_STATUS',
          'Официальная страница вернула неподдерживаемый HTTP-статус',
        );
      }

      const contentEncoding = (
        readHeader(response.headers, 'content-encoding') ?? ''
      )
        .trim()
        .toLocaleLowerCase('en-US');
      if (contentEncoding && contentEncoding !== 'identity') {
        throw new TrainingOfficialUrlFetchError(
          'UNSUPPORTED_CONTENT_ENCODING',
          'Сайт вернул сжатый ответ, который нельзя безопасно обработать',
        );
      }

      const contentType = parseContentType(
        readHeader(response.headers, 'content-type'),
      );
      if (!ALLOWED_CONTENT_TYPES.has(contentType.mimeType)) {
        throw new TrainingOfficialUrlFetchError(
          'UNSUPPORTED_CONTENT_TYPE',
          'Адрес должен возвращать HTML или XHTML',
        );
      }
      if (contentType.charset && contentType.charset !== 'utf-8') {
        throw new TrainingOfficialUrlFetchError(
          'UNSUPPORTED_CHARSET',
          'Страница должна использовать кодировку UTF-8',
        );
      }
      if (
        response.body.length === 0 ||
        response.body.length > TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES
      ) {
        throw new TrainingOfficialUrlFetchError(
          'RESPONSE_SIZE_INVALID',
          'Размер страницы превышает допустимый предел или равен нулю',
        );
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      } catch {
        throw new TrainingOfficialUrlFetchError(
          'INVALID_UTF8',
          'Страница содержит некорректный UTF-8',
        );
      }

      return {
        normalizedUrl,
        finalUrl: currentUrl.toString(),
        hostname: confirmedHost,
        contentType: contentType.mimeType as
          | 'application/xhtml+xml'
          | 'text/html',
        contentHash: createHash('sha256').update(response.body).digest('hex'),
        body: response.body,
        text,
        metadata: {
          statusCode: response.statusCode,
          contentType: contentType.mimeType,
          contentLength: response.body.length,
          redirectCount,
          redirectHosts,
          etag: readHeader(response.headers, 'etag'),
          lastModified: readHeader(response.headers, 'last-modified'),
        },
      };
    }

    throw new TrainingOfficialUrlFetchError(
      'TOO_MANY_REDIRECTS',
      'Страница превысила допустимое количество перенаправлений',
    );
  }
}

export function normalizeOfficialUrl(value: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TrainingOfficialUrlFetchError(
      'INVALID_URL',
      'Укажите адрес официальной страницы',
    );
  }
  if (value.trim().length > 2_048) {
    throw new TrainingOfficialUrlFetchError(
      'INVALID_URL',
      'Адрес официальной страницы слишком длинный',
    );
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TrainingOfficialUrlFetchError(
      'INVALID_URL',
      'Адрес официальной страницы некорректен',
    );
  }

  if (url.protocol !== 'https:') {
    throw new TrainingOfficialUrlFetchError(
      'HTTPS_REQUIRED',
      'Официальный источник должен использовать HTTPS',
    );
  }
  if (url.username || url.password) {
    throw new TrainingOfficialUrlFetchError(
      'CREDENTIALS_NOT_ALLOWED',
      'Адрес не должен содержать логин или пароль',
    );
  }
  if (url.port && url.port !== '443') {
    throw new TrainingOfficialUrlFetchError(
      'PORT_NOT_ALLOWED',
      'Официальный источник должен использовать стандартный HTTPS-порт',
    );
  }

  const hostname = normalizeOfficialHostname(url.hostname);
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new TrainingOfficialUrlFetchError(
        'SENSITIVE_QUERY_NOT_ALLOWED',
        'Адрес не должен содержать секретные параметры доступа',
      );
    }
  }

  url.hostname = hostname;
  url.port = '';
  url.hash = '';
  return url;
}

export function normalizeOfficialHostname(value: string) {
  const ascii = domainToASCII(value.trim().replace(/\.$/u, ''))
    .toLocaleLowerCase('en-US');
  const labels = ascii.split('.');

  if (
    !ascii ||
    ascii.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    isIP(ascii) !== 0 ||
    ascii === 'localhost' ||
    /(?:^|\.)(?:home\.arpa|internal|local|localhost)$/u.test(ascii)
  ) {
    throw new TrainingOfficialUrlFetchError(
      'INVALID_HOST',
      'Домен официального источника некорректен или запрещён',
    );
  }

  return ascii;
}

async function resolveOfficialUrlDns(
  hostname: string,
): Promise<TrainingOfficialUrlAddress[]> {
  let addresses: TrainingOfficialUrlAddress[];
  try {
    addresses = (await dnsLookup(hostname, {
      all: true,
      verbatim: true,
    })) as TrainingOfficialUrlAddress[];
  } catch {
    throw new TrainingOfficialUrlFetchError(
      'DNS_LOOKUP_FAILED',
      'Не удалось определить сетевой адрес официального источника',
    );
  }

  return addresses.map((item: TrainingOfficialUrlAddress) => ({
    address: item.address,
    family: item.family,
  }));
}

async function requestOfficialUrl(input: {
  url: URL;
  addresses: TrainingOfficialUrlAddress[];
  deadlineAt: number;
}): Promise<TrainingOfficialUrlHttpResponse> {
  return new Promise((resolve, reject) => {
    const pinnedAddress = input.addresses[0];
    if (!pinnedAddress) {
      reject(
        new TrainingOfficialUrlFetchError(
          'DNS_LOOKUP_FAILED',
          'Не удалось определить сетевой адрес официального источника',
        ),
      );
      return;
    }

    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    const finish = (
      error: unknown,
      response?: TrainingOfficialUrlHttpResponse,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (error) {
        reject(
          error instanceof TrainingOfficialUrlFetchError
            ? error
            : new TrainingOfficialUrlFetchError(
                'NETWORK_ERROR',
                'Не удалось загрузить официальную страницу',
              ),
        );
      } else if (response) {
        resolve(response);
      }
    };
    const totalTimer = setTimeout(
      () =>
        finish(
          new TrainingOfficialUrlFetchError(
            'TOTAL_TIMEOUT',
            'Истекло общее время загрузки официальной страницы',
          ),
        ),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    totalTimer.unref();

    const request = httpsRequest(
      input.url,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html, application/xhtml+xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Platforma-Training-Source/1.0',
        },
        servername: input.url.hostname,
        lookup: ((_hostname: string, _options: unknown, callback: Function) => {
          callback(null, pinnedAddress.address, pinnedAddress.family);
        }) as never,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const headers = response.headers;

        if (REDIRECT_STATUSES.has(statusCode)) {
          response.destroy();
          finish(null, { statusCode, headers, body: Buffer.alloc(0) });
          return;
        }

        const declaredLength = Number(readHeader(headers, 'content-length'));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES
        ) {
          response.destroy();
          finish(
            new TrainingOfficialUrlFetchError(
              'RESPONSE_TOO_LARGE',
              'Размер официальной страницы превышает допустимый предел',
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES) {
            response.destroy();
            finish(
              new TrainingOfficialUrlFetchError(
                'RESPONSE_TOO_LARGE',
                'Размер официальной страницы превышает допустимый предел',
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () =>
          finish(null, {
            statusCode,
            headers,
            body: Buffer.concat(chunks, size),
          }),
        );
        response.on('aborted', () =>
          finish(
            new TrainingOfficialUrlFetchError(
              'NETWORK_ERROR',
              'Загрузка официальной страницы была прервана',
            ),
          ),
        );
        response.on('error', (error) => finish(error));
      },
    );

    connectTimer = setTimeout(() => {
      request.destroy(
        new TrainingOfficialUrlFetchError(
          'CONNECT_TIMEOUT',
          'Не удалось вовремя подключиться к официальному источнику',
        ),
      );
    }, TRAINING_OFFICIAL_URL_CONNECT_TIMEOUT_MS);
    connectTimer.unref();
    request.once('socket', (socket) => {
      const markConnected = () => {
        if (connectTimer) clearTimeout(connectTimer);
      };
      if (!socket.connecting) {
        markConnected();
      }
      socket.once('secureConnect', markConnected);
      socket.once('error', markConnected);
    });
    request.setTimeout(TRAINING_OFFICIAL_URL_READ_TIMEOUT_MS, () => {
      request.destroy(
        new TrainingOfficialUrlFetchError(
          'READ_TIMEOUT',
          'Официальный источник слишком долго не отвечает',
        ),
      );
    });
    request.on('error', (error) => {
      if (connectTimer) clearTimeout(connectTimer);
      finish(error);
    });
    request.end();
  });
}

function assertConfirmedHost(url: URL, confirmedHost: string) {
  if (url.hostname !== confirmedHost) {
    throw new TrainingOfficialUrlFetchError(
      'REDIRECT_HOST_NOT_CONFIRMED',
      'Сайт перенаправил запрос на неподтверждённый домен',
    );
  }
}

function assertPublicAddresses(addresses: TrainingOfficialUrlAddress[]) {
  if (addresses.length === 0) {
    throw new TrainingOfficialUrlFetchError(
      'DNS_LOOKUP_FAILED',
      'Официальный источник не вернул сетевой адрес',
    );
  }

  for (const item of addresses) {
    const family = isIP(item.address);
    if (
      family !== item.family ||
      (family === 4
        ? ipv4NetworkBlockList.check(item.address, 'ipv4')
        : !ipv6GlobalUnicastBlockList.check(item.address, 'ipv6') ||
          ipv6NetworkBlockList.check(item.address, 'ipv6'))
    ) {
      throw new TrainingOfficialUrlFetchError(
        'PRIVATE_ADDRESS_BLOCKED',
        'Домен официального источника указывает на запрещённую сеть',
      );
    }
  }
}

function createIpv4NetworkBlockList() {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }
  return blockList;
}

function createIpv6NetworkBlockList() {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }
  return blockList;
}

function createIpv6GlobalUnicastBlockList() {
  const blockList = new BlockList();
  blockList.addSubnet('2000::', 3, 'ipv6');
  return blockList;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
) {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function parseContentType(value: string | null) {
  const parts = (value ?? '')
    .split(';')
    .map((item) => item.trim().toLocaleLowerCase('en-US'));
  const mimeType = parts[0] ?? '';
  const charsetPart = parts.find((item) => item.startsWith('charset='));
  const charset = charsetPart
    ? charsetPart.slice('charset='.length).replace(/^["']|["']$/gu, '')
    : null;

  return {
    mimeType,
    charset: charset === 'utf8' ? 'utf-8' : charset,
  };
}

function assertBeforeDeadline(deadlineAt: number) {
  if (Date.now() >= deadlineAt) {
    throw new TrainingOfficialUrlFetchError(
      'TOTAL_TIMEOUT',
      'Истекло общее время загрузки официальной страницы',
    );
  }
}

async function resolveBeforeDeadline(
  resolution: Promise<TrainingOfficialUrlAddress[]>,
  deadlineAt: number,
) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new TrainingOfficialUrlFetchError(
      'DNS_LOOKUP_TIMEOUT',
      'Истекло время определения сетевого адреса официального источника',
    );
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      resolution,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new TrainingOfficialUrlFetchError(
                'DNS_LOOKUP_TIMEOUT',
                'Истекло время определения сетевого адреса официального источника',
              ),
            ),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
