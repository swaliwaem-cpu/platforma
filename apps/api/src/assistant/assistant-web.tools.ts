import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { load } from 'cheerio';
import { chromium, type Browser } from 'playwright-core';

import { isPublicIpAddress } from '../training/training-url-extractor';

// The open web as seen by the assistant. Search goes through Yandex Search API when a key is
// configured, otherwise the headless browser reads the result pages of public search engines
// that do not challenge it. The same browser reads one page at a time, including the JSON the
// page loads (developer sites usually fetch their flat lists from an XHR API).

const defaultYandexSearchUrl = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const searchTimeoutMs = 15_000;
const maxSearchResults = 8;
const pageTimeoutMs = 25_000;
const settleTimeoutMs = 6_000;
const maxPageTextChars = 24_000;
const maxLinks = 40;
const maxJsonResponses = 4;
const maxJsonBytes = 400_000;
const maxJsonCharsPerResponse = 16_000;
const maxConcurrentBrowsers = 2;

export type AssistantSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type AssistantOpenedPage = {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; url: string }>;
  data: Array<{ url: string; json: string }>;
};

export class AssistantWebToolError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface AssistantWeb {
  isSearchConfigured(): boolean;
  search(query: string, signal?: AbortSignal): Promise<AssistantSearchResult[]>;
  openPage(url: string, signal?: AbortSignal): Promise<AssistantOpenedPage>;
}

@Injectable()
export class AssistantWebTools implements AssistantWeb {
  private activeBrowsers = 0;
  private readonly browserQueue: Array<() => void> = [];

  isSearchConfigured() {
    return isYandexSearchConfigured() || process.env.ASSISTANT_BROWSER_SEARCH_ENABLED !== 'false';
  }

  async search(query: string, signal?: AbortSignal): Promise<AssistantSearchResult[]> {
    if (isYandexSearchConfigured()) return this.searchYandex(query, signal);
    if (process.env.ASSISTANT_BROWSER_SEARCH_ENABLED === 'false') {
      throw new AssistantWebToolError('WEB_SEARCH_NOT_CONFIGURED');
    }
    return this.withBrowser(signal, (browser) => searchWithBrowser(browser, query));
  }

  private async searchYandex(query: string, signal?: AbortSignal): Promise<AssistantSearchResult[]> {
    const apiKey = process.env.YANDEX_SEARCH_API_KEY?.trim() ?? '';
    const folderId = process.env.YANDEX_SEARCH_FOLDER_ID?.trim() ?? '';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), searchTimeoutMs);
    const abortFromParent = () => controller.abort();
    signal?.addEventListener('abort', abortFromParent, { once: true });
    try {
      const response = await fetch(process.env.YANDEX_SEARCH_API_URL?.trim() || defaultYandexSearchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Api-Key ${apiKey}` },
        body: JSON.stringify({
          query: {
            searchType: 'SEARCH_TYPE_RU',
            queryText: query.slice(0, 400),
            familyMode: 'FAMILY_MODE_NONE',
          },
          groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: maxSearchResults, docsInGroup: 1 },
          maxPassages: 2,
          region: '213',
          l10n: 'LOCALIZATION_RU',
          folderId,
          responseFormat: 'FORMAT_XML',
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { rawData?: string } | null;
      if (!response.ok || typeof body?.rawData !== 'string') {
        throw new AssistantWebToolError(`WEB_SEARCH_REJECTED_${response.status}`);
      }
      return parseYandexSearchXml(Buffer.from(body.rawData, 'base64').toString('utf8'));
    } catch (error) {
      if (error instanceof AssistantWebToolError) throw error;
      throw new AssistantWebToolError(controller.signal.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }

  async openPage(requestedUrl: string, signal?: AbortSignal): Promise<AssistantOpenedPage> {
    const url = await validatePublicUrl(requestedUrl);
    return this.withBrowser(signal, (browser) => readPage(browser, url));
  }

  private async withBrowser<T>(signal: AbortSignal | undefined, work: (browser: Browser) => Promise<T>) {
    await this.acquireBrowserSlot();
    let browser: Browser | undefined;
    try {
      try {
        browser = await chromium.launch({
          headless: true,
          ...(process.env.ASSISTANT_BROWSER_EXECUTABLE_PATH?.trim()
            ? { executablePath: process.env.ASSISTANT_BROWSER_EXECUTABLE_PATH.trim() }
            : {}),
        });
      } catch {
        throw new AssistantWebToolError('BROWSER_UNAVAILABLE');
      }
      const closeOnAbort = () => void browser?.close().catch(() => undefined);
      signal?.addEventListener('abort', closeOnAbort, { once: true });
      try {
        return await work(browser);
      } finally {
        signal?.removeEventListener('abort', closeOnAbort);
      }
    } finally {
      await browser?.close().catch(() => undefined);
      this.releaseBrowserSlot();
    }
  }

  private async acquireBrowserSlot() {
    if (this.activeBrowsers < maxConcurrentBrowsers) {
      this.activeBrowsers += 1;
      return;
    }
    await new Promise<void>((resolve) => this.browserQueue.push(resolve));
  }

  private releaseBrowserSlot() {
    const next = this.browserQueue.shift();
    if (next) next();
    else this.activeBrowsers -= 1;
  }
}

function isYandexSearchConfigured() {
  return Boolean(process.env.YANDEX_SEARCH_API_KEY?.trim() && process.env.YANDEX_SEARCH_FOLDER_ID?.trim());
}

const browserContextOptions = {
  acceptDownloads: false,
  javaScriptEnabled: true,
  serviceWorkers: 'block' as const,
  locale: 'ru-RU',
  viewport: { width: 1366, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

// Engines whose result pages a headless browser can read without a challenge (checked
// 2026-09-23 from a Moscow IP). Google, Bing, Yandex and Mojeek answer with a captcha.
const browserSearchEngines = [
  { name: 'startpage', url: (query: string) => `https://www.startpage.com/do/search?q=${encodeURIComponent(query)}&language=russian` },
  { name: 'brave', url: (query: string) => `https://search.brave.com/search?q=${encodeURIComponent(query)}` },
  { name: 'yahoo', url: (query: string) => `https://search.yahoo.com/search?p=${encodeURIComponent(query)}` },
];

async function searchWithBrowser(browser: Browser, query: string): Promise<AssistantSearchResult[]> {
  const context = await browser.newContext(browserContextOptions);
  try {
    const page = await context.newPage();
    await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType())
      ? route.abort()
      : route.fallback());
    for (const engine of browserSearchEngines) {
      try {
        await page.goto(engine.url(query.slice(0, 300)), { waitUntil: 'domcontentloaded', timeout: searchTimeoutMs });
        await page.waitForTimeout(1_500);
        const anchors = await page.$$eval('a[href]', (elements) => elements.map((element) => {
          const block = element.closest('li, article, [class*="result"], [class*="snippet"], [class*="algo"]');
          return {
            href: (element as HTMLAnchorElement).href,
            text: (element as HTMLElement).innerText ?? '',
            block: (block as HTMLElement | null)?.innerText ?? '',
          };
        }));
        const results = selectSearchResults(anchors, new URL(engine.url('x')).hostname);
        if (results.length > 0) return results;
      } catch {
        // Try the next engine: this one timed out, changed its layout or asked for a captcha.
      }
    }
    throw new AssistantWebToolError('WEB_SEARCH_UNAVAILABLE');
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function selectSearchResults(
  anchors: Array<{ href: string; text: string; block: string }>,
  engineHost: string,
): AssistantSearchResult[] {
  const engineSite = engineHost.split('.').slice(-2).join('.');
  const seen = new Set<string>();
  const results: AssistantSearchResult[] = [];
  for (const anchor of anchors) {
    const url = unwrapSearchRedirect(anchor.href);
    if (!url) continue;
    const host = url.hostname.toLowerCase();
    if (host.endsWith(engineSite) || searchNoiseHostPattern.test(host)) continue;
    const title = anchor.text.replace(/\s+/gu, ' ').trim();
    if (title.length < 4) continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      url: key,
      title: title.slice(0, 200),
      snippet: anchor.block.replace(/\s+/gu, ' ').replace(title, '').trim().slice(0, 400),
    });
    if (results.length >= maxSearchResults) break;
  }
  return results;
}

function unwrapSearchRedirect(href: string) {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Yahoo wraps every result as r.search.yahoo.com/.../RU=<encoded target>/RK=...
    const wrapped = url.pathname.match(/\/RU=([^/]+)\//u)?.[1];
    return wrapped ? new URL(decodeURIComponent(wrapped)) : url;
  } catch {
    return null;
  }
}

const searchNoiseHostPattern =
  /(^|\.)(yahoo\.com|yimg\.com|bing\.com|microsoft\.com|google\.[a-z.]+|gstatic\.com|brave\.com|startpage\.com|startmail\.com|duckduckgo\.com|youtube\.com|apple\.com|mozilla\.org)$/u;

async function readPage(browser: Browser, url: URL): Promise<AssistantOpenedPage> {
  const context = await browser.newContext(browserContextOptions);
  const hostChecks = new Map<string, Promise<boolean>>();
  const data: AssistantOpenedPage['data'] = [];
  const pendingJson: Array<Promise<void>> = [];

  try {
    const page = await context.newPage();
    context.on('page', (candidate) => {
      if (candidate !== page) void candidate.close().catch(() => undefined);
    });
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      const allowed = !['image', 'media', 'font', 'stylesheet'].includes(request.resourceType())
        && ['GET', 'POST', 'HEAD'].includes(request.method())
        && await isPublicRequestUrl(request.url(), hostChecks);
      if (allowed) await route.fallback();
      else await route.abort();
    });
    page.on('response', (response) => {
      const type = response.request().resourceType();
      const contentType = response.headers()['content-type'] ?? '';
      if ((type !== 'xhr' && type !== 'fetch') || !contentType.includes('json')) return;
      pendingJson.push((async () => {
        const body = await response.body().catch(() => null);
        if (!body || body.byteLength > maxJsonBytes || data.length >= maxJsonResponses) return;
        const lots = extractLotRecords(body.toString('utf8'));
        if (lots) data.push({ url: response.url(), json: lots });
      })());
    });

    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    } catch {
      throw new AssistantWebToolError('PAGE_UNREACHABLE');
    }
    await page.waitForLoadState('networkidle', { timeout: settleTimeoutMs }).catch(() => undefined);
    // Pages with maps never go network-idle; flat lists usually arrive a moment after load.
    await page.waitForTimeout(1_500);
    await Promise.race([Promise.allSettled(pendingJson), page.waitForTimeout(3_000)]);

    const html = await page.content();
    const finalUrl = page.url();
    const $ = load(html);
    const title = $('title').first().text().replace(/\s+/gu, ' ').trim();
    const links = extractLinks($, finalUrl);
    $('script,style,noscript,template,svg,iframe').remove();
    const text = (await page.innerText('body').catch(() => $('body').text()))
      .replace(/[ \t ]+/gu, ' ')
      .replace(/\n\s*\n+/gu, '\n')
      .trim()
      .slice(0, maxPageTextChars);
    if (!text && data.length === 0) throw new AssistantWebToolError('PAGE_EMPTY');
    return { url: finalUrl, title, text, links, data };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function parseYandexSearchXml(xml: string): AssistantSearchResult[] {
  const $ = load(xml, { xml: true });
  const results: AssistantSearchResult[] = [];
  $('group > doc').each((_index, element) => {
    const doc = $(element);
    const url = doc.children('url').first().text().trim();
    if (!/^https?:\/\//iu.test(url)) return;
    results.push({
      url,
      title: doc.children('title').first().text().replace(/\s+/gu, ' ').trim(),
      snippet: doc.find('passages > passage').map((_passageIndex, passage) => $(passage).text())
        .get()
        .join(' … ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 400),
    });
  });
  return results.slice(0, maxSearchResults);
}

export async function validatePublicUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<string[]> = resolveAddresses,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AssistantWebToolError('URL_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new AssistantWebToolError('URL_NOT_ALLOWED');
  }
  const addresses = await resolveHost(url.hostname).catch(() => []);
  if (!addresses.length || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new AssistantWebToolError('URL_HOST_NOT_PUBLIC');
  }
  url.hash = '';
  return url;
}

async function isPublicRequestUrl(value: string, hostChecks: Map<string, Promise<boolean>>) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const key = `${url.protocol}//${url.host}`;
  if (!hostChecks.has(key)) {
    hostChecks.set(key, validatePublicUrl(url.toString()).then(() => true, () => false));
  }
  return hostChecks.get(key)!;
}

async function resolveAddresses(hostname: string) {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function extractLinks($: ReturnType<typeof load>, baseUrl: string) {
  const seen = new Set<string>();
  const links: AssistantOpenedPage['links'] = [];
  $('a[href]').each((_index, element) => {
    if (links.length >= maxLinks) return;
    const text = $(element).text().replace(/\s+/gu, ' ').trim().slice(0, 80);
    let url: string;
    try {
      const parsed = new URL($(element).attr('href') ?? '', baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      parsed.hash = '';
      url = parsed.toString();
    } catch {
      return;
    }
    if (!text || seen.has(url) || !lotLinkPattern.test(`${text} ${url}`)) return;
    seen.add(url);
    links.push({ text, url });
  });
  return links;
}

const lotLinkPattern =
  /квартир|планировк|выбрать|выбор|подбор|шахматк|цены|стоимост|лот|студи|flat|apartment|kvartir|plan|catalog|choose|select|param/iu;

// Developer sites load their flats as JSON in all kinds of shapes. The largest arrays of
// priced objects are the lots; each one is cut down to the fields a broker cares about.
export function extractLotRecords(text: string): string | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const arrays: Array<Record<string, unknown>[]> = [];
  collectPricedArrays(root, arrays, 0);
  if (arrays.length === 0) return null;
  arrays.sort((left, right) => right.length - left.length);

  const records: string[] = [];
  let size = 2;
  for (const array of arrays) {
    for (const item of array) {
      const record = JSON.stringify(reduceLotRecord(item));
      if (size + record.length + 1 > maxJsonCharsPerResponse) return `[${records.join(',')}]`;
      records.push(record);
      size += record.length + 1;
    }
  }
  return `[${records.join(',')}]`;
}

function collectPricedArrays(value: unknown, arrays: Array<Record<string, unknown>[]>, depth: number) {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    const objects = value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    if (objects.length > 0 && objects.filter(hasPrice).length >= Math.ceil(objects.length / 2)) {
      arrays.push(objects);
      return;
    }
    value.slice(0, 50).forEach((item) => collectPricedArrays(item, arrays, depth + 1));
    return;
  }
  Object.values(value).forEach((item) => collectPricedArrays(item, arrays, depth + 1));
}

function hasPrice(item: Record<string, unknown>) {
  return Object.entries(item).some(([key, value]) => pricePattern.test(key) && readAmount(value) > 10_000);
}

function reduceLotRecord(item: Record<string, unknown>) {
  const record: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!lotFieldPattern.test(key) || /typename|image|img|photo|svg|preview/iu.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') record[key] = value;
    else if (typeof value === 'string' && value.length <= 120) record[key] = value;
  }
  return record;
}

function readAmount(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.replace(/[\s\u00a0]/gu, '').replace(',', '.')) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

const pricePattern = /price|cost|цена|стоимост/iu;
const lotFieldPattern =
  /price|cost|цена|стоим|area|square|size|площ|room|комн|floor|этаж|number|num|name|title|code|status|section|секци|build|корп|house|project|url|link|slug|type|finish|отделк|complet|deadline|quarter|year|срок/iu;
