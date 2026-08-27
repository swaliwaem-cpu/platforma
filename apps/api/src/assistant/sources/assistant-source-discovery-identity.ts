import { isIP } from 'node:net';

import { load } from 'cheerio';

import type { SourceConnectorFetchResult } from './official-html-source.connector';

const genericProjectWords = new Set([
  'дом',
  'жилой',
  'жилые',
  'комплекс',
  'квартал',
  'клубный',
  'роскошный',
  'проект',
  'жк',
  'the',
]);
const blockedDomainSuffixes = [
  '2gis.ru',
  'avito.ru',
  'cian.ru',
  'domclick.ru',
  'dzen.ru',
  'google.com',
  'google.ru',
  'instagram.com',
  'mail.ru',
  'mskguru.ru',
  'novostroy-m.ru',
  'novostroy.ru',
  'realty.yandex.ru',
  't.me',
  'vk.com',
  'youtube.com',
  'youtu.be',
  'yandex.com',
  'yandex.ru',
];

export type AssistantSourceIdentityProject = {
  projectKey: string;
  title: string;
  developerKey: string;
  developerName: string;
  address?: string | null;
};

export type AssistantSourceIdentityMatchKind = 'EXACT' | 'TRANSLITERATION' | 'RENAMED';

export type AssistantSourceCatalogProjectEvidence = {
  officialProjectName: string;
  officialProjectCode: string | null;
  officialProjectUrl: string | null;
  identity: ReturnType<typeof verifyProjectIdentity>;
};

export function normalizeCandidateUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_URL_INVALID');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_URL_INVALID');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|yclid|gclid|fbclid)$/iu.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function findDeveloperAlias(
  project: AssistantSourceIdentityProject,
  fetched: SourceConnectorFetchResult,
) {
  const searchableText = extractSearchableText(fetched, false);
  return createDeveloperAliases(project.developerName, project.developerKey)
    .find((alias) => includesAlias(searchableText, alias)) ?? null;
}

export function verifyProjectIdentity(
  project: AssistantSourceIdentityProject,
  officialProjectName: string,
  fetched: SourceConnectorFetchResult,
  options: { includeFinalUrl?: boolean } = {},
) {
  const searchableText = extractSearchableText(fetched, options.includeFinalUrl ?? true);
  const platformAliases = createProjectAliases(
    project.title,
    project.projectKey,
    project.developerName,
  );
  const officialAliases = createProjectAliases(officialProjectName, '', project.developerName);
  const developerAliases = createDeveloperAliases(project.developerName, project.developerKey);
  return {
    matchedPlatformProjectAlias: platformAliases
      .find((alias) => includesAlias(searchableText, alias)) ?? null,
    matchedOfficialProjectAlias: officialAliases
      .find((alias) => includesAlias(searchableText, alias)) ?? null,
    matchedDeveloperAlias: developerAliases.find((alias) => includesAlias(searchableText, alias)) ?? null,
    matchedAddress: matchesProjectAddress(project.address, searchableText),
  };
}

export function inferOfficialProjectNameFromPage(
  project: AssistantSourceIdentityProject,
  fetched: SourceConnectorFetchResult,
) {
  const words = extractSearchableText(fetched, false)
    .split(' ')
    .filter((word) => /^[a-z0-9]+$/u.test(word));
  const phoneticAliases = new Set(createProjectAliases(
    project.title,
    project.projectKey,
    project.developerName,
  ).filter((alias) => /[a-z]/u.test(alias)).map(normalizeLatinBrandPhonetics));
  for (let width = 1; width <= Math.min(4, words.length); width += 1) {
    for (let index = 0; index + width <= words.length; index += 1) {
      const candidate = words.slice(index, index + width).join(' ');
      if (phoneticAliases.has(normalizeLatinBrandPhonetics(candidate))) return candidate;
    }
  }
  return null;
}

export function readProjectIdentityError(
  matchKind: AssistantSourceIdentityMatchKind,
  identity: ReturnType<typeof verifyProjectIdentity>,
) {
  if (!identity.matchedOfficialProjectAlias) return 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_MISMATCH';
  if (matchKind === 'RENAMED') {
    return identity.matchedPlatformProjectAlias || identity.matchedAddress
      ? null
      : 'ASSISTANT_SOURCE_DISCOVERY_RENAME_UNGROUNDED';
  }
  return identity.matchedPlatformProjectAlias
    ? null
    : 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_MISMATCH';
}

export function findProjectCatalogEvidence(
  project: AssistantSourceIdentityProject,
  fetched: SourceConnectorFetchResult,
  allowedHosts: readonly string[] = relatedHosts(
    new URL(normalizeCandidateUrl(fetched.finalUrl)).hostname,
  ),
): AssistantSourceCatalogProjectEvidence | null {
  const jsonValues = readCatalogJsonValues(fetched);
  for (const record of collectCatalogRecords(jsonValues)) {
    const officialProjectName = readCatalogString(record.name)
      ?? readCatalogString(record.title);
    if (!officialProjectName) continue;
    const officialProjectCode = normalizeProjectCode(
      readCatalogString(record.code) ?? readCatalogString(record.slug),
    );
    const officialProjectUrl = readCatalogProjectUrl(record, fetched.finalUrl);
    const evidencePage: SourceConnectorFetchResult = {
      ...fetched,
      finalUrl: fetched.finalUrl,
      payload: Buffer.from(`<main>${escapeHtml(officialProjectName)} ${escapeHtml(officialProjectCode ?? '')}</main>`),
    };
    const identity = verifyProjectIdentity(
      project,
      officialProjectName,
      evidencePage,
      { includeFinalUrl: false },
    );
    if (identity.matchedPlatformProjectAlias && identity.matchedOfficialProjectAlias) {
      return { officialProjectName, officialProjectCode, officialProjectUrl, identity };
    }
  }

  const identity = verifyProjectIdentity(project, project.title, fetched, { includeFinalUrl: false });
  return identity.matchedPlatformProjectAlias && identity.matchedOfficialProjectAlias
    ? {
      officialProjectName: project.title,
      officialProjectCode: null,
      officialProjectUrl: findHtmlCatalogProjectUrl(project, fetched, allowedHosts),
      identity,
    }
    : null;
}

export function hasMultipleProjectCatalogEntries(fetched: SourceConnectorFetchResult) {
  const entries = new Set<string>();
  for (const record of collectCatalogRecords(readCatalogJsonValues(fetched))) {
    const name = readCatalogString(record.name) ?? readCatalogString(record.title);
    const code = normalizeProjectCode(
      readCatalogString(record.code) ?? readCatalogString(record.slug),
    );
    if (!name || !code) continue;
    entries.add(`${code}\u0000${normalizeIdentityText(name)}`);
    if (entries.size >= 2) return true;
  }
  return false;
}

export function extractOfficialProjectLinks(
  fetched: SourceConnectorFetchResult,
  developerAllowedHosts: readonly string[],
) {
  if (fetched.contentType === 'application/json' || fetched.contentType === 'application/ld+json') {
    return [];
  }
  const raw = fetched.payload.toString('utf8');
  const $ = load(raw);
  const links: string[] = [];
  $('a[href]').each((_index, element) => {
    if (links.length >= 4) return;
    const href = $(element).attr('href');
    if (!href || href.length > 2_048) return;
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeCandidateUrl(new URL(href, fetched.finalUrl).toString());
    } catch {
      return;
    }
    const url = new URL(normalizedUrl);
    if (isUrlWithinAllowedHosts(normalizedUrl, developerAllowedHosts)
      || isBlockedDomain(url.hostname)
      || /\.(?:pdf|docx?|xlsx?|zip|jpe?g|png|webp)(?:$|\?)/iu.test(url.pathname)) return;
    const linkSignal = normalizeIdentityText([
      normalizedUrl,
      $(element).text(),
      $(element).attr('title') ?? '',
      $(element).attr('aria-label') ?? '',
    ].join(' '));
    const explicitlyOfficial = /(?:официальн\w* сайт|сайт проекта|перейти на сайт|project site)/iu
      .test(linkSignal);
    if (explicitlyOfficial && !links.includes(normalizedUrl)) links.push(normalizedUrl);
  });
  return links;
}

export function extractLinkedOfficialDeveloperUrls(
  fetched: SourceConnectorFetchResult,
  allowedHosts: readonly string[],
) {
  if (fetched.contentType === 'application/json' || fetched.contentType === 'application/ld+json') {
    return [];
  }
  const $ = load(fetched.payload.toString('utf8'));
  const links: Array<{ url: string; trustWithoutFetch: boolean }> = [];
  $('a[href]').each((_index, element) => {
    if (links.length >= 4) return;
    const href = $(element).attr('href');
    if (!href || href.length > 2_048) return;
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeCandidateUrl(new URL(href, fetched.finalUrl).toString());
    } catch {
      return;
    }
    const url = new URL(normalizedUrl);
    const isAlreadyAllowed = isUrlWithinAllowedHosts(normalizedUrl, allowedHosts);
    if (normalizedUrl === normalizeCandidateUrl(fetched.finalUrl)
      || isBlockedDomain(url.hostname)
      || /\.(?:pdf|docx?|xlsx?|zip|jpe?g|png|webp)(?:$|\?)/iu.test(url.pathname)) return;
    const linkSignal = normalizeIdentityText([
      $(element).text(),
      $(element).attr('title') ?? '',
      $(element).attr('aria-label') ?? '',
    ].join(' '));
    if (!/(?:официальн|корпоративн|каталог|жил\w* проект|проекты|projects?|catalog|residential)/iu
      .test(linkSignal)) return;
    const trustWithoutFetch = !isAlreadyAllowed
      && /(?:официальн|корпоративн|official|corporate)/iu.test(linkSignal)
      && /(?:сайт|каталог|site|catalog)/iu.test(linkSignal);
    if (!links.some(({ url }) => url === normalizedUrl)) {
      links.push({ url: normalizedUrl, trustWithoutFetch });
    }
  });
  return links;
}

export function isUrlWithinAllowedHosts(value: string, allowedHosts: readonly string[]) {
  try {
    const hostname = normalizeHostname(new URL(normalizeCandidateUrl(value)).hostname);
    return allowedHosts.some((allowedHost) => normalizeHostname(allowedHost) === hostname);
  } catch {
    return false;
  }
}

export function relatedHosts(hostname: string) {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized.replace(/^\[|\]$/gu, '')) !== 0
    || !normalized.includes('.')
    || normalized.includes(':')) return [normalized];
  const counterpart = normalized.startsWith('www.') ? normalized.slice(4) : `www.${normalized}`;
  return [...new Set([normalized, counterpart])];
}

export function normalizeHostname(hostname: string) {
  return hostname.toLocaleLowerCase('en-US').replace(/\.$/u, '');
}

export function isBlockedDomain(hostname: string) {
  const normalized = hostname.toLocaleLowerCase('en-US').replace(/\.$/u, '');
  return blockedDomainSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function extractSearchableText(fetched: SourceConnectorFetchResult, includeFinalUrl = true) {
  const raw = fetched.payload.toString('utf8');
  if (fetched.contentType === 'application/json' || fetched.contentType === 'application/ld+json') {
    return normalizeIdentityText(`${includeFinalUrl ? fetched.finalUrl : ''} ${raw}`);
  }
  const $ = load(raw);
  $('script:not([type="application/ld+json"]),style,noscript,template,svg,canvas,iframe').remove();
  $('body').find('address,article,aside,br,dd,div,dl,dt,footer,h1,h2,h3,h4,h5,h6,header,li,main,nav,p,section,td,th')
    .after(' ');
  const signals = [
    includeFinalUrl ? fetched.finalUrl : '',
    $('title').text(),
    $('meta[name="description"]').attr('content') ?? '',
    $('meta[property="og:title"]').attr('content') ?? '',
    $('meta[property="og:description"]').attr('content') ?? '',
    $('body').text(),
    $('script[type="application/ld+json"]').text(),
  ];
  return normalizeIdentityText(signals.join(' '));
}

function matchesProjectAddress(address: string | null | undefined, searchableText: string) {
  if (!address) return false;
  const ignoredWords = new Set([
    'город', 'г', 'москва', 'московская', 'область', 'обл', 'россия',
    'дом', 'д', 'корпус', 'корп', 'строение', 'стр', 'владение', 'вл',
    'район', 'р-н', 'адрес',
  ]);
  const tokens = normalizeIdentityText(address).split(' ');
  const words = [...new Set(tokens.filter((token) => token.length >= 4 && !ignoredWords.has(token)))];
  const numbers = [...new Set(tokens.filter((token) => /^\d+[\p{L}]?$/u.test(token)))];
  if (words.length < 2) return false;
  const matchedWords = words.filter((word) => includesAlias(searchableText, word));
  const matchedNumbers = numbers.filter((number) => (
    ` ${searchableText} `.includes(` ${normalizeIdentityText(number)} `)
  ));
  return matchedWords.length >= 2 && (numbers.length === 0 || matchedNumbers.length > 0);
}

function addParsedJson(target: unknown[], value: string) {
  if (!value || Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) return;
  try {
    target.push(JSON.parse(value));
  } catch {
    // Dynamic pages may contain unrelated malformed script data; only valid bounded JSON is evidence.
  }
}

function readCatalogJsonValues(fetched: SourceConnectorFetchResult) {
  if (fetched.contentType !== 'application/json'
    && fetched.contentType !== 'application/ld+json'
    && fetched.contentType !== 'text/html'
    && fetched.contentType !== 'application/xhtml+xml') return [];
  const payload = fetched.payload.toString('utf8');
  const jsonValues: unknown[] = [];
  if (fetched.contentType === 'application/json' || fetched.contentType === 'application/ld+json') {
    addParsedJson(jsonValues, payload);
  } else {
    const $ = load(payload);
    $('script[type="application/json"],script[type="application/ld+json"]').each((_index, element) => {
      addParsedJson(jsonValues, $(element).text());
    });
  }
  return jsonValues;
}

function collectCatalogRecords(values: unknown[]) {
  const records: Record<string, unknown>[] = [];
  const queue = values.map((value) => ({ value, depth: 0 }));
  let visited = 0;
  while (queue.length > 0 && visited < 2_000 && records.length < 500) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    if (Array.isArray(current.value)) {
      if (current.depth < 8) {
        for (const child of current.value.slice(0, 500)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    records.push(current.value);
    if (current.depth < 8) {
      for (const child of Object.values(current.value).slice(0, 100)) {
        if (Array.isArray(child) || isRecord(child)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
  }
  return records;
}

function readCatalogString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500
    ? value.trim()
    : null;
}

function readCatalogProjectUrl(record: Record<string, unknown>, baseUrl: string) {
  const value = readCatalogString(record.url)
    ?? readCatalogString(record.href)
    ?? readCatalogString(record.link);
  if (!value) return null;
  try {
    return normalizeCandidateUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
}

function findHtmlCatalogProjectUrl(
  project: AssistantSourceIdentityProject,
  fetched: SourceConnectorFetchResult,
  allowedHosts: readonly string[],
) {
  if (fetched.contentType === 'application/json' || fetched.contentType === 'application/ld+json') {
    return null;
  }
  const $ = load(fetched.payload.toString('utf8'));
  let matchedUrl: string | null = null;
  let inspectedLinks = 0;
  $('a[href]').each((_index, element) => {
    if (matchedUrl || inspectedLinks >= 200) return;
    inspectedLinks += 1;
    const href = $(element).attr('href');
    if (!href || href.length > 2_048) return;
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeCandidateUrl(new URL(href, fetched.finalUrl).toString());
    } catch {
      return;
    }
    if (!isUrlWithinAllowedHosts(normalizedUrl, allowedHosts)) return;
    const linkEvidence = [
      normalizedUrl,
      $(element).text(),
      $(element).attr('title') ?? '',
      $(element).attr('aria-label') ?? '',
    ].join(' ');
    const identity = verifyProjectIdentity(
      project,
      project.title,
      {
        ...fetched,
        finalUrl: normalizedUrl,
        payload: Buffer.from(`<main>${escapeHtml(linkEvidence)}</main>`),
      },
      { includeFinalUrl: false },
    );
    if (identity.matchedPlatformProjectAlias && identity.matchedOfficialProjectAlias) {
      matchedUrl = normalizedUrl;
    }
  });
  return matchedUrl;
}

function normalizeProjectCode(value: string | null) {
  if (!value) return null;
  const normalized = value.toLocaleLowerCase('en-US').replace(/[^a-z0-9-]+/gu, '-').replace(/^-|-$/gu, '');
  return normalized.length >= 2 && normalized.length <= 120 ? normalized : null;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createProjectAliases(title: string, projectKey: string, developerName = '') {
  const aliases = new Set<string>();
  const developerWords = new Set(normalizeIdentityText(developerName).split(' '));
  const titleParts = [
    title,
    title.replace(/\([^)]*\)/gu, ' '),
    ...[...title.matchAll(/[«“"]([^»”"]+)[»”"]/gu)].map((match) => match[1] ?? ''),
    ...[...title.matchAll(/\(([^)]+)\)/gu)].map((match) => match[1] ?? ''),
  ];
  for (const part of titleParts) {
    const normalized = normalizeIdentityText(part);
    addProjectAliasVariants(aliases, normalized);
    const meaningfulWords = normalized.split(' ').filter((word) => (
      !genericProjectWords.has(word) && !developerWords.has(word)
    ));
    addProjectAliasVariants(aliases, meaningfulWords.join(' '));
    if (meaningfulWords.length === 1 && (meaningfulWords[0]?.length ?? 0) >= 4) {
      addProjectAliasVariants(aliases, meaningfulWords[0] ?? '');
    }
    for (const word of meaningfulWords) {
      if (word.length < 8) continue;
      addProjectAliasVariants(aliases, word);
      addProjectAlias(aliases, createRussianMorphologyStem(word));
    }
  }
  const normalizedKey = normalizeIdentityText(projectKey.replace(/-/gu, ' '));
  const keyWords = normalizedKey.split(' ').filter((word) => (
    !genericProjectWords.has(word) && word !== 'zhiloj' && word !== 'zhk' && word !== 'kompleks'
  ));
  addProjectAliasVariants(aliases, keyWords.join(' '));
  if (keyWords.length === 2 && /^\d+$/u.test(keyWords[1] ?? '')) {
    addProjectAliasVariants(aliases, keyWords[0] ?? '');
  }
  for (let index = 0; index + 1 < keyWords.length; index += 1) {
    addProjectAliasVariants(aliases, `${keyWords[index]} ${keyWords[index + 1]}`);
  }
  return [...aliases].sort((left, right) => right.length - left.length);
}

function addProjectAliasVariants(aliases: Set<string>, value: string) {
  const normalized = value.trim();
  addProjectAlias(aliases, normalized);
  const latin = /\p{Script=Cyrillic}/u.test(normalized)
    ? transliterateRussian(normalized)
    : normalized;
  addProjectAlias(aliases, latin);
  addProjectAlias(aliases, normalizeLatinBrandPhonetics(latin));
  addProjectAlias(aliases, normalized.replace(/\s+\d+$/u, ''));
}

function addProjectAlias(aliases: Set<string>, value: string) {
  if (value.length >= 3 && /[\p{L}\p{N}]/u.test(value)) aliases.add(value);
}

function createRussianMorphologyStem(value: string) {
  const suffixes = [
    'скими', 'ского', 'скому', 'ская', 'ский', 'ское', 'ские',
    'ыми', 'ими', 'ого', 'ему', 'ами', 'ями',
    'ая', 'яя', 'ый', 'ий', 'ой', 'ое', 'ее',
  ];
  const suffix = suffixes.find((candidate) => value.endsWith(candidate));
  if (!suffix) return value;
  const stem = value.slice(0, -suffix.length);
  return stem.length >= 6 ? stem : value;
}

function createDeveloperAliases(name: string, key: string) {
  const genericDeveloperWords = new Set(['company', 'development', 'group', 'гк', 'группа', 'компания']);
  const normalizedName = normalizeIdentityText(name);
  const normalizedKey = normalizeIdentityText(key.replace(/-[0-9a-f]{8}$/iu, '').replace(/-/gu, ' '));
  const aliases = new Set([
    normalizedName,
    normalizedKey,
  ]);
  for (const word of `${normalizedName} ${normalizedKey}`.split(' ')) {
    if (word.length >= 4 && !genericDeveloperWords.has(word)) aliases.add(word);
  }
  return [...aliases].filter((alias) => alias.length >= 3).sort((left, right) => right.length - left.length);
}

function normalizeIdentityText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\u0301/gu, '')
    .replace(/ё/giu, 'е')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function transliterateRussian(value: string) {
  const characters: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
    т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return [...value].map((character) => characters[character] ?? character).join(' ')
    .replace(/\s+/gu, ' ')
    .replace(/ (?=[a-z])/gu, '')
    .trim();
}

function normalizeLatinBrandPhonetics(value: string) {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/c(?=[eiy])/gu, 's')
    .replace(/c/gu, 'k')
    .replace(/y/gu, 'i')
    .replace(/dz/gu, 'z')
    .replace(/ph/gu, 'f')
    .replace(/qu/gu, 'kv');
}

function includesAlias(text: string, alias: string) {
  if (` ${text} `.includes(` ${alias} `)) return true;
  const words = text.split(' ');
  if (!alias.includes(' ') && alias.length >= 6 && words.some((word) => word.startsWith(alias))) {
    return true;
  }
  const compactAlias = alias.replace(/\s+/gu, '');
  if (compactAlias.length >= 5 && words.some((word) => word.includes(compactAlias))) return true;
  const phoneticAlias = normalizeLatinBrandPhonetics(alias);
  const phoneticText = normalizeLatinBrandPhonetics(text);
  return ` ${phoneticText} `.includes(` ${phoneticAlias} `)
    || phoneticText.split(' ').some((word) => word.includes(phoneticAlias.replace(/\s+/gu, '')));
}
