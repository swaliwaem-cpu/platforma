import { type AssistantOpenedPage, type AssistantSearchResult, type AssistantWebSession, AssistantWebToolError } from './assistant-web.tools';

// Official sites of the catalog's developers and the check of a project on them. A project counts
// as checked on the developer's site only when the opened page is on one of the developer's
// domains (subdomains included). A developer that is not listed is looked up by search, and the
// page it lands on is reported as not confirmed: agencies run many look-alike «official» sites.

// By the developer's name as Platforma stores it. Collected on 2026-10-03: a domain is here only
// when the site itself, a redirect from the corporate site or the project's legal entity confirmed
// it; feed hosts of the developer count too. Add new developers here as they join the catalog.
const developerSites: ReadonlyArray<readonly [developer: string, domains: readonly string[]]> = [
  ['3S Group', ['3s.group']],
  ['AB Development', ['abdevelopment.ru']],
  ['AFI Development', ['afi-development.com', 'afitower.ru', 'afialt.ru', 'afi-park.ru']],
  ['ANT Development', ['antdevelopment.ru', 'vp.moscow']],
  ['ASTERUS', ['asterus-development.com', 'alia.moscow']],
  ['Aurix', ['omega-residence.com']],
  ['Balchug Development', ['gkbalchug.ru', 'sadovnicheskaya69.ru']],
  ['Balchug Estate', ['gkbalchug.ru', 'sadovnicheskaya69.ru']],
  ['Capital Alliance', ['dom-uzory.ru', 'capitalgroup.ru']],
  ['Capital Group', ['capitalgroup.ru', 'badaevsky.com', 'capitaltowers.ru', 'dom-sporta.ru', 'dom-uzory.ru']],
  ['Coldy', ['coldy.info', 'coldy.ru', 'nice-loft.ru']],
  ['Dar', ['dar-development.ru']],
  ['Dominanta', ['d-a.ru']],
  ['Element', ['theelement.ru', 'tessinskiy5.ru', 'novaya11.ru']],
  ['ENGEO Development', ['engeo-development.ru']],
  ['Forma', ['forma.ru']],
  ['GRANARD DEVELOPMENT', ['granard.ru', 'grandfili.ru']],
  ['HITECH DEVELOPMENT', ['hitdev.ru', 'friday37.ru']],
  ['Hutton Development', ['hutton.ru', 'lunar.moscow', 'luminhouse.ru', 'mitte.moscow']],
  ['Ingrad', ['ingrad.ru', 'sminex.com']],
  ['Level Group', ['level.ru']],
  ['MR Group', ['mr-group.ru']],
  ['O1 Properties', ['o1properties.ru']],
  ['Palladio Group', ['palladio.group', 'palladiogroup.ru', 'high.garden']],
  ['October Group', ['octobergroup.ru', 'storiesmoscow.ru', 'kingsons.ru', 'king-sons.ru']],
  ['Regions Development', ['regions-development.ru', 'dream-towers.ru']],
  ['Renaissance Development', ['nevatowers.ru']],
  ['Samolet Select', ['samolet.ru']],
  ['.Sense', ['omnitower.ru']],
  ['Sezar Group', ['sezar-group.ru']],
  ['Sminex', ['sminex.com']],
  ['St Michael', ['stmichael.ru']],
  ['Stone', ['stone.ru']],
  ['Sun Development', ['sundevelopment.ru']],
  ['Tekta Group', ['tekta.ru']],
  ['Vesper', ['vespermoscow.com']],
  ['VOS’HOD', ['voshodmoscow.ru']],
  ['Wainbridge', ['wainbridge.ru']],
  ['А101 ДЕВЕЛОПМЕНТ', ['a101.ru']],
  ['Аеон Девелопмент', ['riverpark-kutuzovskiy.ru']],
  ['Аквилон', ['group-akvilon.ru']],
  ['Брусника', ['brusnika.ru']],
  ['БЭЛ Девелопмент', ['beldevelopment.ru']],
  ['Галс-Девелопмент', ['hals-development.ru']],
  ['ГК Основа', ['gk-osnova.ru']],
  ['ГК Патек Групп', ['patekgroup.ru']],
  ['Главстрой', ['glavstroy.ru']],
  ['Град Девелопмент', ['grad.ru']],
  ['Гута-девелопмент', ['gutagroup.ru', 'redok.ru']],
  ['ДОНСКОЙ', ['thefive.ru']],
  ['Донстрой', ['donstroy.moscow']],
  ['Интеко', ['sminex.com', 'inteco.ru']],
  ['Кортрос', ['kortros.ru']],
  ['Крост', ['krost.ru']],
  ['ЛСР', ['lsr.ru']],
  ['Мангазея', ['mangazeya.ru']],
  ['Новая Эра', ['n-era.com', 'kod-sokolniki.ru']],
  ['ООО СЗ "Гродненская 18', ['kutuzov-city.ru']],
  ['Пионер', ['pioneer.ru']],
  ['РКС Девелопмент', ['rks-dev.ru', 'rks-dev.com']],
  ['Родина', ['rodinagroup.com', 'rodinagroup.ru']],
  ['Самолет', ['samolet.ru']],
  ['Снегири Девелопмент', ['snegiri-eco.ru']],
  ['Страна Девелопмент', ['strana.com']],
  ['Сумма элементов', ['dom-dau.ru']],
  ['Ташир', ['tashir.ru']],
  ['ФСК', ['fsk.ru']],
  ['Центр-Инвест', ['titul.moscow', 'mgcpn.ru']],
  ['Эталон', ['etalongroup.com', 'etalongroup.ru']],
];

const sitesByDeveloper = new Map(developerSites.map(([developer, domains]) => [normalizeDeveloper(developer), domains]));

export function findDeveloperSites(developer: string | null): readonly string[] {
  return developer ? sitesByDeveloper.get(normalizeDeveloper(developer)) ?? [] : [];
}

export function isOnSites(url: string, domains: readonly string[]) {
  const host = hostOf(url);
  return host !== null && domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export type AssistantSiteCheckProject = { title: string; slug: string; developer: string | null };

export type AssistantSiteCheckResult =
  | { page: AssistantOpenedPage; official: boolean; searches: number }
  | { error: string; searches: number };

/**
 * Finds the project's page on its developer's site and opens it. A developer's domain named after
 * the project (luminhouse.ru for Lumin House) is opened right away; otherwise web search is
 * narrowed to the first domain and then repeated by name. Without known domains the result that
 * best names the project, looks like real estate and is not an aggregator is taken, as not confirmed.
 */
export async function checkProjectSite(
  web: AssistantWebSession,
  project: AssistantSiteCheckProject,
  signal?: AbortSignal,
): Promise<AssistantSiteCheckResult> {
  const domains = findDeveloperSites(project.developer);
  const projectDomain = findProjectDomain(project, domains);
  if (projectDomain) return openCheckedPage(web, `https://${projectDomain}/`, domains, 0, signal);
  const name = searchName(project.title);
  const queries = domains.length
    ? [`${name} site:${domains[0]}`, [name, project.developer].filter(Boolean).join(' ')]
    : [[name, project.developer, 'официальный сайт'].filter(Boolean).join(' ')];
  let searches = 0;
  let lastError = 'PROJECT_SITE_NOT_FOUND';
  let target: AssistantSearchResult | null = null;
  let fallback: AssistantSearchResult | null = null;
  for (const query of queries) {
    searches += 1;
    let pick: ReturnType<typeof pickProjectPage>;
    try {
      pick = pickProjectPage(await web.search(query, signal), project, domains);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof AssistantWebToolError ? error.code : 'WEB_SEARCH_UNAVAILABLE';
      continue;
    }
    // A page of the developer's site that does not name the project (often the home page) is
    // kept only in case the next search finds nothing better.
    if (pick && pick.score > 0) {
      target = pick.result;
      break;
    }
    fallback ??= pick?.result ?? null;
  }
  target ??= fallback;
  if (!target) return { error: lastError, searches };
  return openCheckedPage(web, target.url, domains, searches, signal);
}

async function openCheckedPage(
  web: AssistantWebSession,
  url: string,
  domains: readonly string[],
  searches: number,
  signal?: AbortSignal,
): Promise<AssistantSiteCheckResult> {
  try {
    const page = await web.openPage(url, signal);
    // A redirect may take the browser off the developer's domain.
    return { page, official: domains.length > 0 && isOnSites(page.url, domains), searches };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { error: error instanceof AssistantWebToolError ? error.code : 'PAGE_UNREACHABLE', searches };
  }
}

/** The developer's domain that carries the project's name, as luminhouse.ru does for Lumin House. */
export function findProjectDomain(project: AssistantSiteCheckProject, domains: readonly string[]) {
  const tokens = projectTokens(project).filter((token) => token.length >= 5);
  return domains.find((domain) => {
    const label = domain.split('.')[0]!.replace(/-/gu, '');
    return tokens.some((token) => label.includes(token));
  }) ?? null;
}

/** The result most likely to be the project's own page: on the developer's domains, naming the project. */
export function pickProjectPage(
  results: AssistantSearchResult[],
  project: AssistantSiteCheckProject,
  domains: readonly string[],
): { result: AssistantSearchResult; score: number } | null {
  const tokens = projectTokens(project);
  const scored = results
    .filter((result) => (domains.length
      ? isOnSites(result.url, domains)
      : !notOfficialHostPattern.test(hostOf(result.url) ?? '') && realEstatePattern.test(`${result.title} ${result.snippet}`)))
    .map((result) => {
      const haystack = normalize(`${result.title} ${result.snippet} ${decodeUrl(result.url)}`);
      return { result, score: tokens.filter((token) => haystack.includes(token)).length };
    })
    // Without the developer's domain only a page that names the project will do.
    .filter(({ score }) => domains.length > 0 || score > 0);
  if (scored.length === 0) return null;
  return scored.reduce((best, item) => (item.score > best.score ? item : best));
}

// Words of the title and the slug that tell this project apart from the developer's others:
// «Level Донской» of Level Group is told apart by «донской», not by «level».
function projectTokens(project: AssistantSiteCheckProject) {
  const developerWords = new Set(normalize(project.developer ?? '').split(' '));
  const words = [
    ...normalize(searchName(project.title)).split(' '),
    ...project.slug.toLowerCase().split(/[^a-z0-9]+/u),
  ];
  return [...new Set(words.filter((word) => word.length >= 3 && !genericWords.has(word) && !developerWords.has(word)))];
}

function searchName(title: string) {
  return title
    .replace(/[«»"“”„]/gu, '')
    .replace(/^(?:жилой\s+комплекс|жилой\s+квартал|жк)\s+/iu, 'ЖК ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const genericWords = new Set([
  'жк', 'жилой', 'комплекс', 'квартал', 'клубный', 'дом', 'особняк', 'резиденция', 'апарт', 'на', 'the', 'парк',
  'zhk', 'zhiloj', 'zhiloy', 'kompleks', 'kvartal', 'klubnyj', 'klubnyy', 'osobnyak', 'dom', 'mfk', 'apartamentov',
  'house', 'park', 'city', 'tower', 'towers', 'club', 'garden', 'residence', 'residences', 'moscow', 'moskva', 'loft', 'home',
]);

// Search results that are about housing at all; a hotel or a shop with the same name is not.
const realEstatePattern =
  /жк|жил(?:ой|ого|ые|ых)|квартир|апартамент|новостро|застройщ|девелоп|клубн(?:ый|ого)\s+дом|особняк|резиденц|планировк|residen|apartment/iu;

// Aggregators, classifieds, maps, the state register and media: never a developer's own site.
const notOfficialHostPattern =
  /(^|\.)(cian\.ru|avito\.ru|domclick\.ru|yandex\.ru|ya\.ru|novostroy-m\.ru|novostroy\.su|novostroyki\.ru|m2\.ru|restate\.ru|irn\.ru|bn\.ru|nmarket\.pro|move\.ru|gdeetotdom\.ru|mirkvartir\.ru|domofond\.ru|etagi\.com|incom\.ru|youla\.ru|novostroev\.ru|erzrf\.ru|xn--80az8a\.xn--d1aqf\.xn--p1ai|vk\.com|t\.me|dzen\.ru|youtube\.com|rbc\.ru|kommersant\.ru|forbes\.ru|vedomosti\.ru|ria\.ru|tass\.ru|lenta\.ru|interfax\.ru|mos\.ru|wikipedia\.org|2gis\.ru)$/u;

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeDeveloper(value: string) {
  return normalize(value.replace(/[«»"“”„'’]/gu, ''));
}

function decodeUrl(url: string) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return null;
  }
}
