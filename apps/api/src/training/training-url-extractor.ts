import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import { BadRequestException, Injectable, RequestTimeoutException } from '@nestjs/common';
import { load } from 'cheerio';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';

import {
  normalizeTrainingMaterialText,
  TrainingMaterialExtractionService,
  type TrainingMaterialExtraction,
} from './training-material-extraction';

const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 2_000_000;
const MIN_SEMANTIC_TEXT_CHARS = 80;

type UrlExtractionDependencies = {
  fetchImpl?: TrainingUrlFetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
};

type TrainingUrlFetch = (
  url: URL,
  init: RequestInit,
  pinnedAddresses: readonly string[],
) => Promise<Response>;

type ValidatedUrlTarget = {
  url: URL;
  addresses: string[];
};

@Injectable()
export class TrainingUrlExtractor {
  constructor(private readonly extraction: TrainingMaterialExtractionService) {}

  async extract(
    requestedUrl: string,
    dependencies: UrlExtractionDependencies = {},
  ): Promise<TrainingMaterialExtraction & { finalUrl: string; fetchedAt: Date }> {
    const fetchImpl = dependencies.fetchImpl ?? fetchPinnedHttps;
    const resolveHost = dependencies.resolveHost ?? resolvePublicAddresses;
    const timeoutMs = readTimeout('TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS', 60_000);
    const deadline = Date.now() + timeoutMs;
    let target = await resolveAndValidateTrainingOfficialUrl(requestedUrl, resolveHost);

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const { response, clearDeadline } = await fetchWithDeadline(
        fetchImpl,
        target.url,
        target.addresses,
        deadline,
      );
      if (isRedirect(response.status)) {
        try {
          if (redirect === MAX_REDIRECTS) throw new BadRequestException('URL_REDIRECT_LIMIT');
          const location = response.headers.get('location');
          if (!location) throw new BadRequestException('URL_REDIRECT_INVALID');
          target = await resolveAndValidateTrainingOfficialUrl(
            new URL(location, target.url).toString(),
            resolveHost,
          );
        } finally {
          await response.body?.cancel().catch(() => undefined);
          clearDeadline();
        }
        continue;
      }

      let html: string;
      try {
        if (!response.ok) throw new BadRequestException('URL_FETCH_FAILED');
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
          throw new BadRequestException('URL_CONTENT_TYPE_INVALID');
        }
        html = await readBoundedResponse(response, MAX_HTML_BYTES, deadline);
      } finally {
        clearDeadline();
      }
      const segments = extractSemanticHtml(html);
      const total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
      const responseMetadata = {
        redirectCount: redirect,
        etag: boundedHeader(response.headers.get('etag')),
        lastModified: boundedHeader(response.headers.get('last-modified')),
      };

      if (total >= MIN_SEMANTIC_TEXT_CHARS) {
        return {
          ...this.extraction.complete(segments, { method: 'HTTP', ...responseMetadata }),
          finalUrl: target.url.toString(),
          fetchedAt: new Date(),
        };
      }

      if (process.env.TRAINING_MATERIAL_BROWSER_FALLBACK_ENABLED !== 'true') {
        throw new BadRequestException('BROWSER_FALLBACK_REQUIRED');
      }
      const renderedHtml = await extractWithBrowser(target, resolveHost);
      const renderedSegments = extractSemanticHtml(renderedHtml);

      return {
        ...this.extraction.complete(
          renderedSegments,
          { method: 'BROWSER', ...responseMetadata },
        ),
        finalUrl: target.url.toString(),
        fetchedAt: new Date(),
      };
    }

    throw new BadRequestException('URL_REDIRECT_LIMIT');
  }
}

export async function validateTrainingOfficialUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<string[]> = resolvePublicAddresses,
) {
  return (await resolveAndValidateTrainingOfficialUrl(value, resolveHost)).url;
}

async function resolveAndValidateTrainingOfficialUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<ValidatedUrlTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('URL_INVALID');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.hash ||
    (url.port && url.port !== '443') || !url.hostname
  ) {
    throw new BadRequestException('URL_NOT_ALLOWED');
  }
  if (url.hostname.toLowerCase() === 'metadata.google.internal') {
    throw new BadRequestException('URL_HOST_NOT_PUBLIC');
  }

  const addresses = await resolveHost(url.hostname).catch(() => []);
  if (!addresses.length || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new BadRequestException('URL_HOST_NOT_PUBLIC');
  }
  return { url, addresses: [...new Set(addresses)] };
}

export function isPublicIpAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return isPublicIpv4(address);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = readMappedIpv4(normalized);
    if (mappedIpv4) return isPublicIpv4(mappedIpv4);
    return !(
      normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:0:') ||
      normalized.startsWith('2001:2:') ||
      normalized.startsWith('2001:10:') ||
      normalized.startsWith('2001:20:') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('2002:') ||
      normalized.startsWith('3fff:') ||
      normalized.startsWith('64:ff9b:1:')
    );
  }
  return false;
}

export function extractSemanticHtml(html: string) {
  const $ = load(html);
  $('script,style,noscript,template,svg,canvas,iframe,form,nav,header,footer,aside,[role="navigation"],[class*="cookie" i],[id*="cookie" i]').remove();
  const segments: Array<{ locator: string; label: string; text: string }> = [];
  $('h1,h2,h3,h4,h5,h6,p,li,table').each((index, element) => {
    const text = normalizeTrainingMaterialText($(element).text());
    if (text && !segments.some((segment) => segment.text === text)) {
      const tag = element.tagName.toLowerCase();
      segments.push({
        locator: `html:${index + 1}`,
        label: `${htmlSegmentLabel(tag)} ${index + 1}`,
        text,
      });
    }
  });
  return segments;
}

async function resolvePublicAddresses(hostname: string) {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function fetchWithDeadline(
  fetchImpl: TrainingUrlFetch,
  url: URL,
  pinnedAddresses: readonly string[],
  deadline: number,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RequestTimeoutException('URL_FETCH_TIMEOUT');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    }, pinnedAddresses);
    return { response, clearDeadline: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted || isAbortError(error)) {
      throw new RequestTimeoutException('URL_FETCH_TIMEOUT');
    }
    throw new BadRequestException('URL_FETCH_FAILED');
  }
}

async function fetchPinnedHttps(
  url: URL,
  init: RequestInit,
  pinnedAddresses: readonly string[],
) {
  const pinnedAddress = selectPinnedAddress(pinnedAddresses);
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      signal: init.signal ?? undefined,
      servername: url.hostname,
      lookup: createPinnedLookup(pinnedAddress),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const hasNoBody = status === 101 || status === 204 || status === 205 || status === 304;
      resolve(new Response(
        hasNoBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        { status, headers },
      ));
    });
    request.on('error', reject);
    request.end();
  });
}

export function createPinnedLookup(pinnedAddress: string): LookupFunction {
  const family = isIP(pinnedAddress);
  if (family !== 4 && family !== 6) throw new BadRequestException('URL_HOST_NOT_PUBLIC');

  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinnedAddress, family }]);
      return;
    }
    callback(null, pinnedAddress, family);
  };
}

async function readBoundedResponse(response: Response, maxBytes: number, deadline: number) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new BadRequestException('URL_RESPONSE_TOO_LARGE');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await reader.cancel().catch(() => undefined);
      throw new RequestTimeoutException('URL_FETCH_TIMEOUT');
    }
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const readTimeout = new Promise<never>((_resolve, reject) => {
      readTimer = setTimeout(
        () => reject(new RequestTimeoutException('URL_FETCH_TIMEOUT')),
        remaining,
      );
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), readTimeout]);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      if (readTimer) clearTimeout(readTimer);
    }
    const { done, value } = result;
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BadRequestException('URL_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

async function extractWithBrowser(
  target: ValidatedUrlTarget,
  resolveHost: (hostname: string) => Promise<string[]>,
) {
  const timeoutMs = readTimeout('TRAINING_MATERIAL_BROWSER_TIMEOUT_MS', 30_000);
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [browserHostResolverRule(target.url.hostname, selectPinnedAddress(target.addresses))],
      ...(process.env.TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH
        ? { executablePath: process.env.TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH }
        : {}),
    });
  } catch {
    throw new BadRequestException('BROWSER_FALLBACK_UNAVAILABLE');
  }

  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      permissions: [],
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await installTrainingBrowserGuards(context, page, target.url, resolveHost);
    await page.goto(target.url.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const html = await page.content();
    if (!extractSemanticHtml(html).length) throw new BadRequestException('BROWSER_TEXT_EMPTY');
    return html;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new RequestTimeoutException('BROWSER_FALLBACK_TIMEOUT');
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function installTrainingBrowserGuards(
  context: BrowserContext,
  page: Page,
  initialUrl: URL,
  resolveHost: (hostname: string) => Promise<string[]>,
) {
  let initialNavigationAccepted = false;
  context.on('page', (candidate) => {
    if (candidate !== page) void candidate.close().catch(() => undefined);
  });
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
  await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    let isPrimaryPageRequest = false;
    let isMainFrame = false;
    try {
      const frame = request.frame();
      isPrimaryPageRequest = frame.page() === page;
      isMainFrame = frame === page.mainFrame();
    } catch {
      // Requests without a frame (for example workers) are not part of the one-page boundary.
    }
    const isNavigationRequest = request.isNavigationRequest();
    const allowed = (!isNavigationRequest || !initialNavigationAccepted) &&
      isPrimaryPageRequest && await isAllowedTrainingBrowserRequest(
      initialUrl,
      request.url(),
      request.resourceType(),
      resolveHost,
      request.method(),
      isNavigationRequest,
      isMainFrame,
    );
    if (allowed && isNavigationRequest) initialNavigationAccepted = true;
    if (allowed) await route.fallback();
    else await route.abort();
  });
}

export async function isAllowedTrainingBrowserRequest(
  initialUrl: URL,
  requestUrl: string,
  resourceType: string,
  resolveHost: (hostname: string) => Promise<string[]>,
  method = 'GET',
  isNavigationRequest = false,
  isMainFrame = true,
) {
  let destination: URL;
  try {
    destination = new URL(requestUrl);
  } catch {
    return false;
  }
  if (
    !['GET', 'HEAD'].includes(method.toUpperCase()) ||
    destination.origin !== initialUrl.origin ||
    ['image', 'media', 'font', 'websocket'].includes(resourceType)
  ) {
    return false;
  }
  if (
    isNavigationRequest &&
    (!isMainFrame || normalizeBrowserNavigation(destination) !== normalizeBrowserNavigation(initialUrl))
  ) {
    return false;
  }
  try {
    await validateTrainingOfficialUrl(destination.toString(), resolveHost);
    return true;
  } catch {
    return false;
  }
}

function selectPinnedAddress(addresses: readonly string[]) {
  const address = addresses.find((candidate) => isIP(candidate) === 4) ?? addresses[0];
  if (!address || !isPublicIpAddress(address)) throw new BadRequestException('URL_HOST_NOT_PUBLIC');
  return address;
}

function browserHostResolverRule(hostname: string, address: string) {
  const target = isIP(address) === 6 ? `[${address}]` : address;
  return `--host-resolver-rules=MAP ${hostname} ${target}`;
}

function normalizeBrowserNavigation(url: URL) {
  return `${url.origin}${url.pathname}${url.search}`;
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function boundedHeader(value: string | null) {
  return value?.slice(0, 512) ?? null;
}

function htmlSegmentLabel(tag: string) {
  if (tag.startsWith('h')) return 'Заголовок';
  if (tag === 'li') return 'Пункт';
  if (tag === 'table') return 'Таблица';
  return 'Абзац';
}

function isPublicIpv4(address: string) {
  const [a = -1, b = -1, c = -1] = address.split('.').map(Number);
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function readMappedIpv4(address: string) {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1] ?? '', 16);
  const low = Number.parseInt(hexadecimal[2] ?? '', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function readTimeout(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= 1_000 && value <= 180_000 ? value : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}
