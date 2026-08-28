import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { load } from 'cheerio';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response as BrowserResponse,
} from 'playwright-core';

const defaultTimeoutMs = 10_000;
const defaultMaximumResponseBytes = 5 * 1024 * 1024;
const defaultMaximumRedirects = 3;
const defaultBrowserTimeoutMs = 20_000;
const minimumSemanticTextCharacters = 80;
const maximumCapturedJsonResponses = 4;
const maximumCapturedJsonBytes = 512 * 1024;
const supportedContentTypes = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'application/ld+json',
]);

type ResolvedAddress = { address: string; family: number };
type CapturedBrowserJson = { url: string; payload: Buffer };

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
  browserFallbackEnabled?: boolean;
  browserTimeoutMs?: number;
  browserExecutablePath?: string;
  renderHtml?: (
    url: URL,
    allowedHosts: Set<string>,
    maximumBytes: number,
  ) => Promise<Buffer>;
};

export class OfficialHtmlSourceConnector {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly allowHttp: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;
  private readonly browserFallbackEnabled: boolean;
  private readonly browserTimeoutMs: number;
  private readonly browserExecutablePath: string | undefined;
  private readonly renderHtml: (
    url: URL,
    allowedHosts: Set<string>,
    maximumBytes: number,
  ) => Promise<Buffer>;

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
    this.browserFallbackEnabled = options.browserFallbackEnabled
      ?? readBooleanEnvironment(
        process.env.ASSISTANT_SOURCE_BROWSER_FALLBACK_ENABLED,
        false,
        'SOURCE_BROWSER_FALLBACK_ENABLED_INVALID',
      );
    this.browserTimeoutMs = boundedInteger(
      options.browserTimeoutMs ?? readOptionalIntegerEnvironment(
        process.env.ASSISTANT_SOURCE_BROWSER_TIMEOUT_MS,
        'SOURCE_BROWSER_TIMEOUT_MS_INVALID',
      ),
      defaultBrowserTimeoutMs,
      1_000,
      60_000,
    );
    this.browserExecutablePath = options.browserExecutablePath
      ?? process.env.ASSISTANT_SOURCE_BROWSER_EXECUTABLE_PATH?.trim()
      ?? process.env.TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH?.trim()
      ?? undefined;
    this.resolveHost = options.resolveHost ?? (async (hostname) => {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      return addresses.map(({ address, family }) => ({ address, family }));
    });
    this.renderHtml = options.renderHtml ?? ((url, allowedHosts, maximumBytes) => (
      this.renderWithBrowser(url, allowedHosts, maximumBytes)
    ));
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

      if (isAntiBotChallenge(response.payload, response.contentType)) {
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, response.statusCode);
      }
      const browserRenderMode = this.readBrowserRenderMode(source.connectorConfig);
      const payload = this.browserFallbackEnabled
        && isHtmlContentType(response.contentType)
        && (browserRenderMode === 'always'
          || semanticTextLength(response.payload) < minimumSemanticTextCharacters)
        ? await this.renderHtml(currentUrl, allowedHosts, this.maxResponseBytes)
        : response.payload;
      if (isAntiBotChallenge(payload, response.contentType)) {
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, response.statusCode);
      }
      return {
        finalUrl: currentUrl.toString(),
        statusCode: response.statusCode,
        contentType: response.contentType,
        checksum: createHash('sha256').update(payload).digest('hex'),
        payload,
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
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new SourceConnectorError('SOURCE_FETCH_TIMEOUT', true));
        controller.abort();
      }, this.timeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([
        this.fetchOnceWithinDeadline(url, controller.signal),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async fetchOnceWithinDeadline(url: URL, signal: AbortSignal): Promise<{
    statusCode: number;
    contentType: string;
    payload: Buffer;
    etag: string | null;
    lastModified: string | null;
    redirectLocation: string | null;
  }> {
    const addresses = await this.resolveAddresses(url.hostname);
    const address = addresses[0]!;
    const response = await this.request(url, address.address, signal);
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

  private request(url: URL, address: string, signal: AbortSignal) {
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? requestHttps : requestHttp)({
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        servername: url.protocol === 'https:' ? url.hostname : undefined,
        headers: {
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          host: url.host,
          'user-agent': 'PlatformaKnowledgeSource/1.0',
        },
        signal,
      }, resolve);
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

  private readBrowserRenderMode(value: unknown) {
    if (!isRecord(value) || value.browserRenderMode === undefined) return 'when-empty';
    if (value.browserRenderMode !== 'when-empty' && value.browserRenderMode !== 'always') {
      throw new SourceConnectorError('SOURCE_CONNECTOR_CONFIG_INVALID', false);
    }
    return value.browserRenderMode;
  }

  private async renderWithBrowser(url: URL, allowedHosts: Set<string>, maximumBytes: number) {
    const deadline = Date.now() + this.browserTimeoutMs;
    const pinnedHosts = new Map<string, string>();
    const initialHostname = normalizeHostname(url.hostname);
    for (const hostname of allowedHosts) {
      try {
        const addresses = await withBrowserDeadline(
          this.resolveAddresses(hostname),
          deadline,
        );
        pinnedHosts.set(hostname, selectAddress(addresses));
      } catch (error) {
        if (error instanceof SourceConnectorError
          && error.code === 'SOURCE_BROWSER_TIMEOUT') throw error;
        if (hostname === initialHostname) throw error;
        // Optional redirect counterparts must not make the initial rendered page unavailable.
      }
    }
    const browserAllowedHosts = new Set(pinnedHosts.keys());
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [`--host-resolver-rules=${createBrowserResolverRules(pinnedHosts)}`],
        timeout: remainingBrowserTime(deadline),
        ...(this.browserExecutablePath ? { executablePath: this.browserExecutablePath } : {}),
      });
    } catch (error) {
      if (error instanceof SourceConnectorError) throw error;
      throw new SourceConnectorError(
        isBrowserTimeoutError(error, deadline)
          ? 'SOURCE_BROWSER_TIMEOUT'
          : 'SOURCE_BROWSER_UNAVAILABLE',
        true,
      );
    }

    let context: BrowserContext | undefined;
    try {
      context = await withBrowserDeadline(
        browser.newContext({
          acceptDownloads: false,
          javaScriptEnabled: true,
          permissions: [],
          serviceWorkers: 'block',
        }),
        deadline,
      );
      const page = await withBrowserDeadline(context.newPage(), deadline);
      const capturedJsonResponses: Array<Promise<CapturedBrowserJson | null>> = [];
      page.on('response', (response) => {
        if (capturedJsonResponses.length >= maximumCapturedJsonResponses
          || !this.isCapturableBrowserJson(response, browserAllowedHosts)) return;
        capturedJsonResponses.push(this.captureBrowserJson(
          response,
          maximumBytes,
        ));
      });
      await withBrowserDeadline(
        this.installBrowserGuards(context, page, url, browserAllowedHosts),
        deadline,
      );
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: remainingBrowserTime(deadline),
      });
      await page.waitForFunction(
        (minimumLength) => (document.body?.innerText.trim().length ?? 0) >= minimumLength,
        minimumSemanticTextCharacters,
        { timeout: remainingBrowserTime(deadline) },
      );
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(2_500, remainingBrowserTime(deadline)),
      }).catch(() => undefined);
      const finalUrl = this.parseUrl(page.url());
      if (!browserAllowedHosts.has(normalizeHostname(finalUrl.hostname))) {
        throw new SourceConnectorError('SOURCE_BROWSER_NAVIGATION_NOT_ALLOWED', false);
      }
      const captures = (await withBrowserDeadline(
        Promise.allSettled(capturedJsonResponses),
        deadline,
      ))
        .flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const html = appendCapturedBrowserJson(
        await withBrowserDeadline(page.content(), deadline),
        captures,
      );
      const renderedPayload = Buffer.from(html, 'utf8');
      if (renderedPayload.length > maximumBytes) {
        throw new SourceConnectorError('SOURCE_RESPONSE_TOO_LARGE', false, 200);
      }
      return renderedPayload;
    } catch (error) {
      if (error instanceof SourceConnectorError) throw error;
      throw new SourceConnectorError(
        isBrowserTimeoutError(error, deadline)
          ? 'SOURCE_BROWSER_TIMEOUT'
          : 'SOURCE_BROWSER_UNAVAILABLE',
        true,
      );
    } finally {
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async captureBrowserJson(
    response: BrowserResponse,
    maximumBytes: number,
  ): Promise<CapturedBrowserJson | null> {
    const responseUrl = this.parseUrl(response.url());
    const declaredBytes = Number(response.headers()['content-length'] ?? 0);
    const limit = Math.min(maximumBytes, maximumCapturedJsonBytes);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) return null;
    const payload = await response.body().catch(() => null);
    if (!payload || payload.length > limit) return null;
    return { url: responseUrl.toString(), payload };
  }

  private isCapturableBrowserJson(response: BrowserResponse, allowedHosts: Set<string>) {
    try {
      const responseUrl = this.parseUrl(response.url());
      const contentType = normalizeContentType(response.headers()['content-type'] ?? null);
      return allowedHosts.has(normalizeHostname(responseUrl.hostname))
        && response.status() >= 200
        && response.status() < 300
        && (contentType === 'application/json' || contentType === 'application/ld+json');
    } catch {
      return false;
    }
  }

  private async installBrowserGuards(
    context: BrowserContext,
    page: Page,
    initialUrl: URL,
    allowedHosts: Set<string>,
  ) {
    context.on('page', (candidate) => {
      if (candidate !== page) void candidate.close().catch(() => undefined);
    });
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      let destination: URL;
      try {
        destination = this.parseUrl(request.url());
      } catch {
        await route.abort();
        return;
      }
      const allowed = ['GET', 'HEAD'].includes(request.method().toLocaleUpperCase('en-US'))
        && allowedHosts.has(normalizeHostname(destination.hostname))
        && !['font', 'image', 'media', 'websocket'].includes(request.resourceType())
        && (!request.isNavigationRequest()
          || (request.frame() === page.mainFrame() && isSameBrowserNavigation(destination, initialUrl)));
      if (allowed) await route.fallback();
      else await route.abort();
    });
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Number.isInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}

function readOptionalIntegerEnvironment(value: string | undefined, code: string) {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new SourceConnectorError(code, false);
  return parsed;
}

function readBooleanEnvironment(value: string | undefined, fallback: boolean, code: string) {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new SourceConnectorError(code, false);
}

function readSingleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeContentType(value: string | null) {
  return (value ?? '').split(';', 1)[0]!.trim().toLocaleLowerCase('en-US');
}

function isHtmlContentType(value: string) {
  return value === 'text/html' || value === 'application/xhtml+xml';
}

function semanticTextLength(payload: Buffer) {
  const $ = load(payload.toString('utf8'));
  $('script,style,noscript,template,svg,canvas,iframe,form,nav,header,footer,aside').remove();
  return $('body').text().replace(/\s+/gu, ' ').trim().length;
}

function isAntiBotChallenge(payload: Buffer, contentType: string) {
  if (!isHtmlContentType(contentType)) return false;
  const html = payload.toString('utf8').toLocaleLowerCase('en-US');
  const servicePipeChallenge = html.includes('servicepipe.tech')
    && (html.includes('js-challenge-loader')
      || html.includes('get_cookie_spsn')
      || html.includes('id_captcha_frame_div'));
  const cloudflareChallenge = html.includes('cf-chl-')
    && (html.includes('just a moment') || html.includes('challenge-platform'));
  return servicePipeChallenge || cloudflareChallenge;
}

function appendCapturedBrowserJson(html: string, captures: CapturedBrowserJson[]) {
  if (captures.length === 0) return html;
  const evidence = captures.map(({ url, payload }) => {
    const safeUrl = url
      .replace(/&/gu, '&amp;')
      .replace(/"/gu, '&quot;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;');
    const safeJson = payload.toString('utf8')
      .replace(/&/gu, '\\u0026')
      .replace(/</gu, '\\u003c')
      .replace(/>/gu, '\\u003e');
    return `<script type="application/json" data-platforma-source-url="${safeUrl}">${safeJson}</script>`;
  }).join('');
  return html.includes('</body>')
    ? html.replace('</body>', `${evidence}</body>`)
    : `${html}${evidence}`;
}

function selectAddress(addresses: ResolvedAddress[]) {
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!selected) throw new SourceConnectorError('SOURCE_DNS_FAILED', true);
  return selected.address;
}

function createBrowserResolverRules(hosts: Map<string, string>) {
  return [...hosts].map(([hostname, address]) => (
    `MAP ${hostname} ${address.includes(':') ? `[${address}]` : address}`
  )).join(',');
}

function isSameBrowserNavigation(left: URL, right: URL) {
  return left.origin === right.origin
    && left.pathname === right.pathname
    && left.search === right.search;
}

function remainingBrowserTime(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SourceConnectorError('SOURCE_BROWSER_TIMEOUT', true);
  return remaining;
}

async function withBrowserDeadline<Value>(operation: Promise<Value>, deadline: number) {
  const remaining = remainingBrowserTime(deadline);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new SourceConnectorError('SOURCE_BROWSER_TIMEOUT', true));
        }, remaining);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isBrowserTimeoutError(error: unknown, deadline: number) {
  return Date.now() >= deadline
    || (error instanceof Error && error.name === 'TimeoutError');
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
  const withoutZone = address.toLocaleLowerCase('en-US').split('%', 1)[0]!;
  let normalized: string;
  try {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname;
    normalized = hostname.slice(1, -1);
  } catch {
    return false;
  }
  const [firstValue, secondValue = '0'] = normalized.split(':');
  const first = Number.parseInt(firstValue || '0', 16);
  const second = Number.parseInt(secondValue || '0', 16);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false;

  // Fail closed to globally routable unicast and reject special transition/documentation blocks.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002) return false;
  if (first === 0x2001 && (
    second === 0x0000
    || second === 0x0002
    || second === 0x0db8
    || (second >= 0x0010 && second <= 0x002f)
  )) return false;
  if (first === 0x3fff && second <= 0x0fff) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
