import type {
  AssistantAnswer,
  AssistantChatTurn,
  AssistantFinishing,
  AssistantLot,
  AssistantPlatformLot,
  AssistantProject,
  AssistantSource,
  AssistantTraceStep,
  AssistantWebLot,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  type AssistantCatalogTools,
  type AssistantLotSearchInput,
  type AssistantProjectCandidate,
  type AssistantProjectFacts,
  type AssistantProjectMatch,
  normalizePropertyClasses,
} from './assistant-catalog.tools';
import { checkProjectSite, findDeveloperSites } from './assistant-developer-sites';
import type { AssistantLlm, AssistantLlmMessage, AssistantLlmTool, AssistantLlmToolCall } from './assistant-llm.client';
import { assistantMarketKnowledge } from './assistant-market-knowledge';
import { type AssistantOpenedPage, type AssistantWeb, type AssistantWebSession, AssistantWebToolError } from './assistant-web.tools';

// One assistant turn: the model calls catalog and web tools until it gives an answer.
// Everything it shows is checked against what the tools actually returned in this turn.

const maxModelCalls = 10;
const maxWebSearches = 3;
const maxOpenedPages = 4;
const maxHistoryTurns = 12;
const maxTurnChars = 4_000;
const maxLotsInAnswer = 10;
const maxProjectsInAnswer = 10;
// Every project in the answer is checked on its developer's site.
const maxSiteChecks = maxProjectsInAnswer;
const maxSitePageChars = 12_000;
// What one check call brings to the model, shared by its pages; a page never gets less than the minimum.
const siteChecksTextBudget = 40_000;
const minSitePageChars = 4_000;
const sitePageHeadChars = 800;

export type AssistantAgentContext = {
  history: AssistantChatTurn[];
  pageProject: { title: string; projectId: string } | null;
  now: Date;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
  /** Filled while the turn runs, so the caller still has usage and trace when the turn fails. */
  telemetry?: AssistantAgentTelemetry;
};

export type AssistantAgentTelemetry = {
  modelCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  webSearches: number;
  openedPages: number;
  trace: AssistantTraceStep[];
};

export function createAssistantAgentTelemetry(): AssistantAgentTelemetry {
  return { modelCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, webSearches: 0, openedPages: 0, trace: [] };
}

export type AssistantAgentDependencies = {
  llm: AssistantLlm;
  catalog: Pick<AssistantCatalogTools, 'findProjects' | 'searchLots' | 'searchProjects' | 'getProjectFacts'>;
  web: AssistantWeb;
};

type TurnState = {
  platformLots: Map<string, AssistantPlatformLot>;
  projectFacts: Map<string, AssistantProjectFacts>;
  /** Projects find_projects or search_projects returned; only these can be listed in the answer. */
  projects: Map<string, AssistantProjectMatch>;
  pages: Map<string, AssistantOpenedPage & { openedAt: string }>;
  /** Every project a site check ran for: the page it was read on, or why it failed. */
  siteChecks: Map<string, { url: string; official: boolean } | { error: string }>;
  /** Tool calls the model made against its limits; checks search and open pages on their own. */
  calls: { webSearch: number; openPage: number; siteCheck: number };
  telemetry: AssistantAgentTelemetry;
};

export type AssistantAgentResult = {
  /** turnId is null here: the service sets it once the turn is logged. */
  answer: AssistantAnswer;
  usage: AssistantAgentTelemetry;
};

export async function runAssistantAgent(
  dependencies: AssistantAgentDependencies,
  context: AssistantAgentContext,
): Promise<AssistantAgentResult> {
  const state: TurnState = {
    platformLots: new Map(),
    projectFacts: new Map(),
    projects: new Map(),
    pages: new Map(),
    siteChecks: new Map(),
    calls: { webSearch: 0, openPage: 0, siteCheck: 0 },
    telemetry: context.telemetry ?? createAssistantAgentTelemetry(),
  };
  const webSearchEnabled = dependencies.web.isSearchConfigured();
  const tools = createTools(webSearchEnabled);
  const messages: AssistantLlmMessage[] = [
    { role: 'system', content: createSystemPrompt(context, webSearchEnabled) },
    ...trimHistory(context.history),
  ];

  let forcedAnswer = false;
  for (let call = 1; call <= maxModelCalls; call += 1) {
    const isLastCall = call === maxModelCalls || forcedAnswer;
    const response = await dependencies.llm.complete({
      messages,
      tools,
      requiredTool: isLastCall ? 'give_answer' : undefined,
      signal: context.signal,
    });
    state.telemetry.modelCalls += 1;
    state.telemetry.inputTokens += response.usage.inputTokens;
    state.telemetry.cachedTokens += response.usage.cachedTokens ?? 0;
    state.telemetry.outputTokens += response.usage.outputTokens;

    const answerCall = response.toolCalls.find((toolCall) => toolCall.name === 'give_answer');
    if (answerCall) {
      context.onStep?.('Формирую ответ');
      return finish(buildAnswer(parseArguments(answerCall), state), state);
    }
    if (response.toolCalls.length === 0) {
      // Qwen sometimes writes its answer (or a give_answer call) as plain text; the next call
      // is forced to give_answer so the lots still come out structured.
      if (!isLastCall && !forcedAnswer) {
        forcedAnswer = true;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Оформи этот ответ вызовом give_answer.' });
        continue;
      }
      return finish(buildAnswer({ text: stripPseudoToolCalls(response.content ?? '') }, state), state);
    }

    messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
    // Calls of one response run side by side (a lot search next to a project search, several
    // site checks); their results go back in the order the model made them.
    const results = await Promise.all(response.toolCalls.map(async (toolCall) => {
      const startedAt = Date.now();
      const result = await executeTool(dependencies, toolCall, state, context);
      return { toolCall, result, durationMs: Date.now() - startedAt };
    }));
    for (const { toolCall, result, durationMs } of results) {
      state.telemetry.trace.push({
        tool: toolCall.name,
        args: parseArguments(toolCall),
        result: summarizeToolResult(result),
        durationMs,
      });
      messages.push({ role: 'tool', toolCallId: toolCall.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('ASSISTANT_AGENT_NO_ANSWER');
}

function finish(answer: AssistantAnswer, state: TurnState): AssistantAgentResult {
  return { answer, usage: state.telemetry };
}

// What the turn log keeps of a tool result: how much was found and which ids, or the error.
function summarizeToolResult(result: unknown): AssistantTraceStep['result'] {
  if (!result || typeof result !== 'object') return {};
  const value = result as Record<string, unknown>;
  if (typeof value.error === 'string') return { error: value.error };
  const ids = (items: unknown, key: string) => Array.isArray(items)
    ? items.flatMap((item) => (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string'
      ? [(item as Record<string, string>)[key]!]
      : [])).slice(0, 20)
    : [];
  if (Array.isArray(value.lots)) return { found: typeof value.total === 'number' ? value.total : value.lots.length, ids: ids(value.lots, 'lotId') };
  if (Array.isArray(value.projects)) {
    return { found: typeof value.total === 'number' ? value.total : value.projects.length, ids: ids(value.projects, 'projectId') };
  }
  if (Array.isArray(value.checks)) return { found: ids(value.checks, 'url').length, ids: ids(value.checks, 'url') };
  if (Array.isArray(value.results)) return { found: value.results.length, ids: ids(value.results, 'url') };
  if (typeof value.projectId === 'string') return { found: 1, ids: [value.projectId] };
  if (typeof value.url === 'string') return { found: 1, ids: [value.url] };
  return {};
}

async function executeTool(
  dependencies: AssistantAgentDependencies,
  toolCall: AssistantLlmToolCall,
  state: TurnState,
  context: AssistantAgentContext,
): Promise<unknown> {
  const args = parseArguments(toolCall);
  try {
    switch (toolCall.name) {
      case 'find_projects': {
        const query = readString(args.query);
        if (!query) return { error: 'Нужно название проекта в поле query.' };
        context.onStep?.(`Ищу «${query}» в Platforma`);
        const result = await dependencies.catalog.findProjects(query);
        result.projects.forEach((project) => state.projects.set(project.projectId, project));
        return {
          projects: result.projects.map(describeProject),
          note: result.projects.length === 0
            ? 'В Platforma такого проекта нет. Ищи лоты в интернете.'
            : result.partialMatch
              ? 'Точного совпадения нет, это похожие по названию проекты — проверь, тот ли это ЖК.'
              : undefined,
        };
      }
      case 'get_project_facts': {
        const projectId = readString(args.projectId);
        if (!projectId) return { error: 'Нужен projectId из find_projects.' };
        context.onStep?.('Читаю карточку ЖК в Platforma');
        const facts = await dependencies.catalog.getProjectFacts(projectId);
        if (!facts) return { error: 'Проект не найден в Platforma. Проверь projectId через find_projects.' };
        state.projectFacts.set(facts.projectId, facts);
        return describeFacts(facts);
      }
      case 'search_lots': {
        const { input, unknownClasses, unknownFinishing } = readLotSearchInput(args);
        if (unknownClasses.length && !input.propertyClasses?.length) {
          return { error: `Неизвестный класс: ${unknownClasses.join(', ')}. В Platforma есть классы: ${propertyClassList}.` };
        }
        context.onStep?.('Подбираю лоты в Platforma');
        const result = await dependencies.catalog.searchLots(input);
        result.lots.forEach((lot) => state.platformLots.set(lot.unitId, lot));
        // The model tends to give up after a timid budget stretch, so an empty budget search
        // always comes with the cheapest lots that match everything except the budget.
        const nearest = result.total === 0 && (input.budgetMaxRub !== undefined || input.budgetMinRub !== undefined)
          ? await dependencies.catalog.searchLots({
              ...input,
              budgetMinRub: undefined,
              budgetMaxRub: undefined,
              sort: 'price_asc',
              limit: 5,
            })
          : null;
        nearest?.lots.forEach((lot) => state.platformLots.set(lot.unitId, lot));
        const notes = [
          unknownClasses.length ? `Класс «${unknownClasses.join('», «')}» не распознан и не учтён; классы: ${propertyClassList}.` : null,
          unknownFinishing.length ? `Отделка «${unknownFinishing.join('», «')}» не распознана и не учтена; варианты: ${assistantFinishingList}.` : null,
          result.lotsWithoutMetroWalkData
            ? `Ещё ${result.lotsWithoutMetroWalkData} лотов подходят под остальные условия, но у их ЖК не посчитано время пешком до метро — они не показаны.`
            : null,
          result.unknownAreas?.length
            ? `Место «${result.unknownAreas.join('», «')}» не распознано, по нему ничего не найдено. Передай в areas зону (${assistantZoneList}), округ (ЦАО, САО…), район Москвы или метку карточки.`
            : null,
        ].filter(Boolean);
        return {
          total: result.total,
          ...(result.lotsWithoutFinishingData !== undefined
            ? {
                lotsWithoutFinishingData: result.lotsWithoutFinishingData,
                finishingNote: 'Столько лотов подходят под остальные условия, но фид не говорит об их отделке — они не показаны. Упомяни это число в ответе.',
              }
            : {}),
          ...(notes.length ? { note: notes.join(' ') } : {}),
          lots: result.lots.map(describeLot),
          ...(nearest
            ? {
                nearestWithoutBudget: {
                  note: 'Точных лотов в бюджете нет. Это самые дешёвые лоты с остальными условиями — покажи их как ближайшие варианты и напиши, насколько они дороже бюджета.',
                  total: nearest.total,
                  lots: nearest.lots.map(describeLot),
                },
              }
            : {}),
        };
      }
      case 'search_projects': {
        const { input, unknownClasses } = readLotSearchInput(args);
        if (unknownClasses.length && !input.propertyClasses?.length) {
          return { error: `Неизвестный класс: ${unknownClasses.join(', ')}. В Platforma есть классы: ${propertyClassList}.` };
        }
        if (!hasProjectFilter(input)) {
          return { error: 'Нужен хотя бы один фильтр по месту (areas, metro), застройщику, классу или сроку сдачи — иначе это весь каталог.' };
        }
        context.onStep?.('Ищу ЖК под запрос в Platforma');
        const result = await dependencies.catalog.searchProjects(input);
        result.projects.forEach((project) => state.projects.set(project.projectId, project));
        return {
          total: result.total,
          withoutMatchingLots: result.withoutMatchingLots,
          ...(result.unknownAreas?.length
            ? { note: `Место «${result.unknownAreas.join('», «')}» не распознано, по нему ничего не найдено.` }
            : {}),
          projects: result.projects.map(describeCandidate),
        };
      }
      case 'check_project_sites': {
        const requested = [...new Set(readStringArray(args.projectIds))];
        if (requested.length === 0) return { error: 'Нужны projectIds из search_projects или find_projects.' };
        const free = maxSiteChecks - state.calls.siteCheck;
        if (free <= 0) return { error: 'Лимит проверок на сайтах исчерпан. Отвечай по найденному.' };
        const projectIds = requested.slice(0, free);
        state.calls.siteCheck += projectIds.length;
        context.onStep?.(projectIds.length === 1 ? 'Проверяю ЖК на сайте застройщика' : `Проверяю ${projectIds.length} ЖК на сайтах застройщиков`);
        const pageChars = Math.min(maxSitePageChars, Math.max(minSitePageChars, Math.floor(siteChecksTextBudget / projectIds.length)));
        const checks = await dependencies.web.withSession(context.signal, (session) => Promise.all(
          projectIds.map((projectId) => checkProject(session, projectId, pageChars, state, context)),
        ));
        return {
          checks,
          ...(requested.length > projectIds.length
            ? { note: `Проверено только ${projectIds.length}: больше ${maxSiteChecks} ЖК за ответ не проверяем. Остальные не перечисляй, назови только их число.` }
            : {}),
        };
      }
      case 'web_search': {
        const query = readString(args.query);
        if (!query) return { error: 'Нужен текст запроса в поле query.' };
        if (state.calls.webSearch >= maxWebSearches) return { error: 'Лимит поисков исчерпан. Отвечай по найденному.' };
        state.calls.webSearch += 1;
        state.telemetry.webSearches += 1;
        context.onStep?.(`Ищу в интернете: ${query}`);
        return { results: await dependencies.web.search(query, context.signal) };
      }
      case 'open_page': {
        const url = readString(args.url);
        if (!url) return { error: 'Нужна ссылка в поле url.' };
        if (state.calls.openPage >= maxOpenedPages) return { error: 'Лимит открытых страниц исчерпан. Отвечай по найденному.' };
        state.calls.openPage += 1;
        context.onStep?.(`Открываю ${hostOf(url) ?? url}`);
        const page = await dependencies.web.openPage(url, context.signal);
        state.pages.set(page.url, { ...page, openedAt: new Date().toISOString() });
        state.telemetry.openedPages = state.pages.size;
        return page;
      }
      default:
        return { error: `Неизвестный инструмент ${toolCall.name}.` };
    }
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return { error: error instanceof AssistantWebToolError ? error.code : 'TOOL_FAILED' };
  }
}

function buildAnswer(args: Record<string, unknown>, state: TurnState): AssistantAnswer {
  const text = readString(stripPseudoToolCalls(readString(args.text) ?? ''))?.slice(0, 3_000)
    ?? 'Не получилось сформулировать ответ. Попробуйте переформулировать запрос.';
  const lots: AssistantLot[] = [];

  for (const id of readStringArray(args.platformLotIds)) {
    const lot = state.platformLots.get(id);
    if (lot && !lots.some((existing) => existing.source === 'PLATFORMA' && existing.unitId === id)) lots.push(lot);
  }
  const webLots = Array.isArray(args.webLots) ? args.webLots : [];
  const platformPrices = new Set(lots.map((lot) => lot.priceRub));
  for (const candidate of webLots) {
    const lot = verifyWebLot(candidate, state.pages);
    // The same flat is often both in the feed and on the developer's site; Platforma wins.
    if (lot && !(lot.priceRub !== null && platformPrices.has(lot.priceRub))) lots.push(lot);
  }

  const shownLots = lots.slice(0, maxLotsInAnswer);
  const projects = buildProjects(args.projects, state, shownLots);
  return {
    text,
    lots: shownLots,
    projects,
    sources: collectSources(state, shownLots),
    historyNote: createHistoryNote(text, shownLots, projects),
    turnId: null,
  };
}

// Only projects a catalog search returned in this turn and a site check ran for, without lots in
// the answer (the lot cards already show those). The check is attached when the code itself opened
// the project's page; the price from survives only when the same number is on that page.
function buildProjects(value: unknown, state: TurnState, shownLots: AssistantLot[]): AssistantProject[] {
  const withLots = new Set(shownLots.flatMap((lot) => (lot.source === 'PLATFORMA' ? [lot.projectHref] : [])));
  const projects: AssistantProject[] = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    if (projects.length >= maxProjectsInAnswer) break;
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    const projectId = readString(item.projectId);
    const project = projectId ? state.projects.get(projectId) : undefined;
    const href = project ? `/objects/${encodeURIComponent(project.slug)}` : null;
    const note = readString(stripPseudoToolCalls(readString(item.note) ?? ''))?.slice(0, 400);
    // Only projects a site check ran for: none is listed unchecked.
    if (!project || !href || !note || !state.siteChecks.has(project.projectId)) continue;
    if (withLots.has(href) || projects.some((existing) => existing.projectId === project.projectId)) continue;
    projects.push({
      projectId: project.projectId,
      title: project.title,
      href,
      developer: project.developer,
      propertyClass: project.propertyClass,
      location: formatProjectLocation(project),
      metro: project.nearestMetroWalk
        ? `${project.nearestMetroWalk.station}, ${project.nearestMetroWalk.minutes} мин пешком`
        : project.metro[0] ?? null,
      availableLots: project.availableLots,
      note,
      siteCheck: createSiteCheck(project.projectId, readNumber(item.priceFromRub), state),
    });
  }
  return projects;
}

function createSiteCheck(projectId: string, priceFromRub: number | null, state: TurnState): AssistantProject['siteCheck'] {
  const check = state.siteChecks.get(projectId);
  const page = check && 'url' in check ? state.pages.get(check.url) : undefined;
  if (!check || !('url' in check) || !page) return null;
  return {
    url: page.url,
    siteName: hostOf(page.url) ?? page.url,
    official: check.official,
    checkedAt: page.openedAt,
    priceFromRub: priceFromRub !== null && pageMentionsPrice(page, priceFromRub) ? priceFromRub : null,
  };
}

// «Донской, ЮАО» from [zone, okrug, district]; the card's location tag without coordinates.
function formatProjectLocation(project: AssistantProjectMatch) {
  if (project.location.length > 1) return project.location.slice(1).reverse().join(', ');
  return project.location[0] ?? project.district;
}

async function checkProject(
  web: AssistantWebSession,
  projectId: string,
  pageChars: number,
  state: TurnState,
  context: AssistantAgentContext,
) {
  const project = state.projects.get(projectId);
  if (!project) return { projectId, error: 'Этого проекта не было в search_projects или find_projects.' };
  const result = await checkProjectSite(web, project, context.signal);
  state.telemetry.webSearches += result.searches;
  if ('error' in result) {
    state.siteChecks.set(projectId, { error: result.error });
    return { projectId, title: project.title, error: result.error };
  }

  const { page, official } = result;
  state.pages.set(page.url, { ...page, openedAt: new Date().toISOString() });
  state.telemetry.openedPages = state.pages.size;
  state.siteChecks.set(projectId, { url: page.url, official });
  // The checks of one call share a model call, so each brings only its share of the flats JSON.
  const data: AssistantOpenedPage['data'] = [];
  let dataChars = Math.floor(pageChars / 2);
  for (const entry of page.data) {
    if (dataChars <= 0) break;
    data.push({ url: entry.url, json: entry.json.slice(0, dataChars) });
    dataChars -= entry.json.length;
  }
  return {
    projectId,
    title: project.title,
    url: page.url,
    official,
    ...(official ? {} : { note: 'Сайт найден поиском и не подтверждён как сайт застройщика.' }),
    pageTitle: page.title,
    text: excerptSitePage(page.text, pageChars),
    links: page.links.slice(0, 15),
    data,
  };
}

// A page longer than its share keeps its top and every line about prices, flats, sales and
// completion: that is what the check is about.
export function excerptSitePage(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  let excerpt = text.slice(0, sitePageHeadChars);
  for (const line of text.slice(sitePageHeadChars).split('\n')) {
    if (!sitePageFactPattern.test(line)) continue;
    if (excerpt.length + line.length + 1 > maxChars) break;
    excerpt += `\n${line}`;
  }
  return excerpt;
}

const sitePageFactPattern =
  /\d\s*(?:млн|тыс|₽|руб|м²|м2|кв\.?\s*м)|цен|стоим|квартир|апартамент|студи|спальн|комнат|евро|продаж|продан|брон|сдач|ввод|ключ|срок|корпус|очеред|отделк|white\s*box|рассрочк/iu;

// Sources are what this turn actually used: project cards it read, the projects of the lots it
// shows (not every lot it looked at) and the sites it opened. One entry per project, latest date.
function collectSources(state: TurnState, shownLots: AssistantLot[]): AssistantSource[] {
  const projects = new Map<string, AssistantSource>();
  const addProject = (title: string, url: string, date: string) => {
    const existing = projects.get(url);
    if (!existing || existing.date < date) projects.set(url, { kind: 'PLATFORMA_PROJECT', title, url, date });
  };
  for (const facts of state.projectFacts.values()) {
    const date = facts.feedUpdatedAt && facts.feedUpdatedAt > facts.cardUpdatedAt ? facts.feedUpdatedAt : facts.cardUpdatedAt;
    addProject(facts.title, facts.href, date);
  }
  for (const lot of shownLots) {
    if (lot.source === 'PLATFORMA') addProject(lot.projectTitle, lot.projectHref, lot.updatedAt);
  }
  const sites = [...state.pages.values()].map((page): AssistantSource => ({
    kind: 'WEB',
    title: page.title || (hostOf(page.url) ?? page.url),
    url: page.url,
    date: page.openedAt,
  }));
  return [...projects.values(), ...sites];
}

// A web lot is shown only when its link points to a site that was actually opened in this
// turn; its price is kept only when the same number appears on one of the opened pages.
function verifyWebLot(candidate: unknown, pages: Map<string, AssistantOpenedPage>): AssistantWebLot | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Record<string, unknown>;
  const url = readString(value.url);
  const host = url ? hostOf(url) : null;
  if (!url || !host) return null;
  const sitePages = [...pages.values()].filter((page) => sameSite(hostOf(page.url), host));
  if (sitePages.length === 0) return null;

  const priceRub = readNumber(value.priceRub);
  const rooms = readInteger(value.rooms);
  const areaM2 = readNumber(value.areaM2);
  // A «lot» without rooms, area or price is only a link, and links are already in the sources.
  if (rooms === null && areaM2 === null && priceRub === null) return null;
  const priceConfirmed = priceRub !== null && sitePages.some((page) => pageMentionsPrice(page, priceRub));
  return {
    source: 'WEB',
    projectTitle: readString(value.projectTitle)?.slice(0, 160) ?? 'Проект',
    description: readString(value.description)?.slice(0, 240) ?? null,
    rooms,
    areaM2,
    floor: readInteger(value.floor),
    priceRub: priceConfirmed ? priceRub : null,
    url,
    siteName: host,
  };
}

export function pageMentionsPrice(page: Pick<AssistantOpenedPage, 'text' | 'data'>, priceRub: number) {
  const haystack = [page.text, ...page.data.map(({ json }) => json)].join(' ').replace(/[\s  ]/gu, '');
  const whole = String(Math.round(priceRub));
  if (haystack.includes(whole)) return true;
  const millions = priceRub / 1_000_000;
  const variants = [millions.toFixed(1), millions.toFixed(2), millions.toFixed(3)]
    .flatMap((variant) => [variant, variant.replace('.', ',')]);
  return variants.some((variant) => haystack.includes(`${variant}млн`));
}

function stripPseudoToolCalls(text: string) {
  return text.replace(/\b(?:give_answer|search_lots|search_projects|find_projects|get_project_facts|check_project_sites|web_search|open_page)\s*\([\s\S]*$/u, '').trim();
}

function createHistoryNote(text: string, lots: AssistantLot[], projects: AssistantProject[]) {
  const parts = [text];
  if (lots.length > 0) parts.push(`Показанные лоты:\n${describeShownLots(lots)}`);
  if (projects.length > 0) {
    const lines = projects.map((project) => `- ${project.title}: ${project.note}${project.siteCheck ? ` (сайт ${project.siteCheck.url})` : ''}`);
    parts.push(`ЖК без лотов в ответе:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

function describeShownLots(lots: AssistantLot[]) {
  const lines = lots.map((lot) => {
    const parts = [
      lot.projectTitle,
      lot.rooms === null ? null : lot.rooms === 0 ? 'студия' : `${lot.rooms}-к`,
      lot.areaM2 === null ? null : `${lot.areaM2} м²`,
      lot.floor === null ? null : `${lot.floor} эт.`,
      lot.priceRub === null ? null : `${lot.priceRub} ₽`,
      lot.source === 'PLATFORMA' ? `lotId ${lot.unitId}` : lot.url,
    ].filter(Boolean);
    return `- ${parts.join(', ')}`;
  });
  return lines.join('\n');
}

function trimHistory(history: AssistantChatTurn[]): AssistantLlmMessage[] {
  return history.slice(-maxHistoryTurns).map((turn) => ({
    role: turn.role,
    content: turn.content.slice(0, maxTurnChars),
  }));
}

function describeLot(lot: AssistantPlatformLot) {
  return {
    lotId: lot.unitId,
    project: lot.projectTitle,
    propertyClass: lot.propertyClass,
    rooms: lot.rooms,
    areaM2: lot.areaM2,
    floor: lot.floor,
    priceRub: lot.priceRub,
    pricePerM2Rub: lot.pricePerM2Rub,
    finishing: lot.finishing,
    building: lot.building,
    completion: lot.completion,
  };
}

function describeProject(project: AssistantProjectMatch) {
  return {
    projectId: project.projectId,
    title: project.title,
    propertyClass: project.propertyClass,
    developer: project.developer,
    location: describeLocation(project),
    metro: project.metro,
    nearestMetroWalk: project.nearestMetroWalk,
    completion: project.completion,
    availableLotsInPlatforma: project.availableLots,
    priceFromRub: project.priceFromRub,
    cardPriceFromRub: project.cardPriceFromRub,
    roomsAvailable: project.roomsAvailable,
  };
}

function describeCandidate(project: AssistantProjectCandidate) {
  return {
    ...describeProject(project),
    matchingLotsInPlatforma: project.matchingLots,
    developerSiteKnown: findDeveloperSites(project.developer).length > 0,
  };
}

// A project search over the whole catalog would just list every project.
function hasProjectFilter(input: AssistantLotSearchInput) {
  return Boolean(input.areas?.length || input.metro || input.developer || input.propertyClasses?.length)
    || input.completionYearMin !== undefined
    || input.completionYearMax !== undefined
    || input.completed !== undefined
    || input.metroWalkMinutesMax !== undefined;
}

function describeFacts(facts: AssistantProjectFacts) {
  const { href: _href, cardUpdatedAt, feedUpdatedAt, district: _district, location: _location, ...rest } = facts;
  return {
    ...rest,
    location: describeLocation(facts),
    nearestMetroWalk: facts.nearestMetroWalk ?? 'нет данных о времени пешком до метро',
    updated: { card: moscowDate(cardUpdatedAt), feed: feedUpdatedAt ? moscowDate(feedUpdatedAt) : null },
  };
}

// Zone, okrug and district by the coordinates; the card's location tag only when there are none.
function describeLocation(project: { district: string | null; location?: string[] }) {
  if (project.location?.length) return project.location;
  return project.district ? [project.district] : [];
}

// Brokers read dates in Moscow time, like the source chips under the answer.
function moscowDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

const propertyClassList = 'Комфорт-класс, Бизнес-класс, Премиум-класс, Делюкс';
const assistantZoneList = 'Внутри Садового кольца, Между Садовым кольцом и ТТК, Внутри ТТК, Между ТТК и МКАД, Внутри МКАД, За МКАД, Новая Москва, Подмосковье';
const assistantFinishingList = 'без отделки, white box, с отделкой, с мебелью';

// Words brokers and feeds use for finishing, by the start of the word.
const finishingByWordStart: ReadonlyArray<readonly [string, AssistantFinishing]> = [
  ['безотдел', 'без отделки'],
  ['безремонт', 'без отделки'],
  ['черн', 'без отделки'],
  ['white', 'white box'],
  ['wb', 'white box'],
  ['вайт', 'white box'],
  ['предчист', 'white box'],
  ['мебел', 'с мебелью'],
  ['смебел', 'с мебелью'],
  ['сотдел', 'с отделкой'],
  ['сремонт', 'с отделкой'],
  ['ремонт', 'с отделкой'],
  ['чист', 'с отделкой'],
  ['отдел', 'с отделкой'],
  ['подключ', 'с отделкой'],
  ['дизайн', 'с отделкой'],
];

function readFinishing(value: string): AssistantFinishing | null {
  const key = value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/[^a-zа-я]+/gu, '');
  return finishingByWordStart.find(([start]) => key.startsWith(start))?.[1] ?? null;
}

function readLotSearchInput(args: Record<string, unknown>) {
  const sort = readString(args.sort);
  const rawClasses = readStringArray(args.propertyClasses);
  const rawFinishing = readStringArray(args.finishing);
  const finishing = rawFinishing.flatMap((value) => readFinishing(value) ?? []);
  const input: AssistantLotSearchInput = {
    projectIds: readStringArray(args.projectIds),
    rooms: Array.isArray(args.rooms) ? args.rooms.map(readInteger).filter((value): value is number => value !== null) : [],
    budgetMinRub: readNumber(args.budgetMinRub) ?? undefined,
    budgetMaxRub: readNumber(args.budgetMaxRub) ?? undefined,
    areaMin: readNumber(args.areaMin) ?? undefined,
    areaMax: readNumber(args.areaMax) ?? undefined,
    floorMin: readNumber(args.floorMin) ?? undefined,
    floorMax: readNumber(args.floorMax) ?? undefined,
    completionYearMin: readNumber(args.completionYearMin) ?? undefined,
    completionYearMax: readNumber(args.completionYearMax) ?? undefined,
    completed: typeof args.completed === 'boolean' ? args.completed : undefined,
    // `district` is the old single-place argument; the model still sends it now and then.
    areas: [...readStringArray(args.areas), ...readStringArray([args.district])],
    metro: readString(args.metro) ?? undefined,
    developer: readString(args.developer) ?? undefined,
    propertyClasses: normalizePropertyClasses(rawClasses),
    finishing: [...new Set(finishing)],
    pricePerM2Min: readNumber(args.pricePerM2Min) ?? undefined,
    pricePerM2Max: readNumber(args.pricePerM2Max) ?? undefined,
    metroWalkMinutesMax: readNumber(args.metroWalkMinutesMax) ?? undefined,
    commercial: args.commercial === true,
    sort: sort === 'price_desc' || sort === 'area_asc' || sort === 'area_desc' ? sort : 'price_asc',
    limit: readNumber(args.limit) ?? undefined,
  };
  return {
    input,
    unknownClasses: rawClasses.filter((value) => normalizePropertyClasses([value]).length === 0),
    unknownFinishing: rawFinishing.filter((value) => readFinishing(value) === null),
  };
}

function createSystemPrompt(context: AssistantAgentContext, webSearchEnabled: boolean) {
  const today = context.now.toISOString().slice(0, 10);
  return [
    'Ты — опытный брокер-аналитик по новостройкам Москвы и помощник брокеров во внутренней платформе Platforma. Твоя главная задача — находить лоты (квартиры, апартаменты, помещения) под запрос брокера и отвечать на вопросы о ЖК, локациях и рынке.',
    'Говори с брокерами на их языке: свободно используй профессиональные термины (лот, корпус, секция, шахматка, квартирография, евроформат, white box, ДДУ, эскроу, РВЭ, фиксация) и не объясняй очевидное. Как эксперт коротко отмечай нюансы, важные для сделки: апартаменты вместо квартиры, далёкий срок ввода, нет отделки, далеко от метро, цена выше типичной для класса.',
    `Сегодня ${today}. Отвечай по-русски, коротко и по делу.`,
    '',
    'Порядок работы:',
    '1. Всегда начинай с Platforma, даже если брокер прислал ссылку. Если в запросе есть название ЖК/проекта — вызови find_projects, затем search_lots с projectIds найденного проекта. Если названия нет — сразу search_lots по фильтрам (район, метро, застройщик, бюджет, комнатность, площадь, этаж, срок сдачи, класс, отделка, цена за м², минуты до метро).',
    '   Вопрос о конкретном ЖК (класс, отделка, потолки, этажность, площади, цена за метр, метро и сколько идти пешком, срок сдачи, застройщик, архитектура, инфраструктура, описание) — find_projects, затем get_project_facts с его projectId. Отвечай по карточке и назови дату обновления данных.',
    '   Слова о классе («элитка», «премиум», «бизнес»), отделке («без отделки», «white box», «с ремонтом», «с мебелью»), цене за метр, минутах пешком до метро или о том, что дом уже сдан, переводи в фильтры search_lots: propertyClasses, finishing, pricePerM2Min/Max, metroWalkMinutesMax, completed.',
    '   Место — в areas. Кольца, округа и районы Москвы проверяются по координатам ЖК, это точно: «в центре» — ЦАО; «внутри Садового», «в пределах ТТК», «за ТТК» (это между ТТК и МКАД), «за МКАД», «Новая Москва» — зоны; «Хамовники или Якиманка» — два района в одном списке. «У воды», «У парка», «У школы», «Рядом с Москва-сити», «На Патриарших» — метки карточек. Станция метро — в metro, не в areas.',
    '   Где стоит конкретный ЖК (зона, округ, район) — поле location из find_projects и get_project_facts, оно посчитано по координатам.',
    '   ЖК под запрос без лотов. Если запрос задаёт место, метро, застройщика, класс или срок, а не один конкретный ЖК, в том же ответе вместе с search_lots вызови search_projects с теми же фильтрами, включая комнатность, бюджет и площадь: по ним считается matchingLotsInPlatforma. ЖК с matchingLotsInPlatforma = 0 подходят под запрос, но подходящих лотов в Platforma у них нет — брокеру важно знать и о них.',
    '   Возьми из них до 10 первых (search_projects уже ставит ЖК без подходящих лотов первыми) — именно их ты назовёшь брокеру — и проверь все одним вызовом check_project_sites: он сам найдёт страницу каждого ЖК на сайте застройщика и откроет её. По странице пойми, идут ли продажи, есть ли квартиры под запрос, какая цена от и срок сдачи. Чего на странице нет — так и скажи, не додумывай.',
    '   Название в вопросе может совпадать с улицей, районом или метро («Фрунзенская набережная», «Тишинский бульвар») — всё равно сначала вызови find_projects и не отказывайся, пока не поищешь.',
    '   Вопросы о терминах и понятиях рынка (классы, отделка, ипотека, эскроу, ДДУ и т.п.) и общие вопросы о районах и локациях Москвы объясняй сам по справочнику ниже, без инструментов; если в чём-то не уверен — так и скажи.',
    '2. Если названный ЖК есть в Platforma, но лотов у него нет или подходящих нет, — сначала check_project_sites с его projectId: это официальный сайт застройщика. Если проекта нет в Platforma или проверка не удалась — ищи в интернете: '
      + (webSearchEnabled
        ? 'web_search (например «ЖК <название> квартиры цены» или «<название> официальный сайт»), затем open_page на официальном сайте застройщика или агрегаторе (ЦИАН, Яндекс Недвижимость, Домклик, Novostroy-m и т.п.). Если на странице есть ссылка на выбор квартир — открой её.'
        : 'веб-поиск сейчас не настроен, но можно вызвать open_page, если ссылка известна из разговора. Иначе честно скажи, что в Platforma лотов нет, а веб-поиск не подключён.'),
    '3. Если точных лотов нет нигде — сам сделай search_lots без самого жёсткого условия (чаще всего без бюджета, с сортировкой по цене; или соседняя комнатность) и покажи 3–5 ближайших лотов, явно написав, чем они отличаются от запроса (например «дороже бюджета на 3,3 млн»). Не спрашивай разрешения на это.',
    '',
    'Правила:',
    '- Никогда не выдумывай лоты, цены, площади и ссылки. Показывай только то, что вернули инструменты.',
    '- Цены, цену за метр, сроки сдачи, наличие, потолки, минуты до метро и класс конкретного ЖК называй только из данных инструментов. Если поля нет или оно пустое — так и скажи: «в Platforma нет данных». Ставки ипотеки и условия программ не называй: их нет в данных, отправляй уточнить у банка или застройщика.',
    '- Если search_lots вернул lotsWithoutFinishingData, напиши, сколько лотов без данных об отделке не попало в выдачу. Если фильтровал по минутам до метро — предупреди, что ЖК без посчитанного времени не показаны.',
    '- Лоты из Platforma передавай в give_answer через platformLotIds (lotId из search_lots). Лоты с сайтов — через webLots с точной ссылкой на страницу, где ты их видел, и ценой как на сайте.',
    '- ЖК без подходящих лотов передавай в give_answer через projects, до 10 штук, — только те, что проверял через check_project_sites: непроверенные не покажутся. В note — одно-два коротких предложения о том, что видно на сайте застройщика: идут ли продажи, есть ли квартиры под запрос, цена от, срок. Если official = false, добавь, что сайт найден поиском и может быть не застройщика. Если проверка не удалась — так и напиши и добавь цену от и срок из карточки Platforma (cardPriceFromRub бывает устаревшей). Цену «от», которую видел на странице сайта, передай в priceFromRub.',
    '- Если сайт не показывает конкретные квартиры, не придумывай их: дай ссылку на страницу и скажи, что лоты там нужно смотреть вручную.',
    '- Комнатность: студия = 0, однушка = 1, двушка = 2, трёшка = 3. «Евро-N» — это N−1 спальня; ищи сразу rooms [N−1, N]. Бюджет «до 20 млн» = budgetMaxRub 20000000.',
    '- Не переспрашивай, если можно искать. Уточняй только когда без этого поиск бессмыслен.',
    '- В text не перечисляй лоты и ЖК списком — карточки покажутся отдельно. Напиши 1–4 предложения: что нашёл, откуда данные, на что обратить внимание; про ЖК без лотов достаточно сказать, сколько их всего под запрос (withoutMatchingLots) и что показанные проверены на сайтах застройщиков. Если данные с сайта — напомни, что цены нужно перепроверить у застройщика.',
    '- Выбирай до 10 лучших лотов под запрос (обычно самые дешёвые подходящие или разные планировки).',
    '- Не упоминай названия инструментов, полей и идентификаторы (projectId, lotId, availableLotsInPlatforma, matchingLotsInPlatforma и т.п.) в тексте ответа и в note.',
    '- Юридические и налоговые консультации не даёшь.',
    '- Всегда заканчивай вызовом give_answer.',
    context.pageProject
      ? `\nБрокер сейчас на странице проекта «${context.pageProject.title}» (projectId ${context.pageProject.projectId}). Ограничивай поиск этим проектом, только если брокер на него ссылается («этот ЖК», «здесь», «тут») или не называет другого проекта в вопросе про конкретный ЖК. Общие запросы вроде «студия до 12 млн» ищи по всей Platforma.`
      : '',
    '',
    assistantMarketKnowledge,
  ].join('\n');
}

function createTools(webSearchEnabled: boolean): AssistantLlmTool[] {
  // The lot search and the project search take the same filters.
  const searchFilters = {
    rooms: { type: 'array', items: { type: 'integer' }, description: '0 — студия, 1 — однокомнатная и т.д.' },
    budgetMinRub: { type: 'number' },
    budgetMaxRub: { type: 'number' },
    areaMin: { type: 'number', description: 'м²' },
    areaMax: { type: 'number', description: 'м²' },
    floorMin: { type: 'integer' },
    floorMax: { type: 'integer' },
    completionYearMin: { type: 'integer', description: 'Сдача не раньше этого года.' },
    completionYearMax: { type: 'integer', description: 'Сдача не позже этого года.' },
    completed: { type: 'boolean', description: 'true — только уже сданные («готовые», «сдан»), false — только строящиеся.' },
    areas: {
      type: 'array',
      items: { type: 'string' },
      description: `Где искать; несколько значений — подходит любое. Зона: ${assistantZoneList}. Округ: ЦАО, САО, СВАО, ВАО, ЮВАО, ЮАО, ЮЗАО, ЗАО, СЗАО, ЗелАО, НАО, ТАО. Район Москвы: «Хамовники», «Пресненский». Метка карточки: «У воды», «У парка», «У школы», «Рядом с Москва-сити», «На Патриарших».`,
    },
    metro: { type: 'string', description: 'Станция метро.' },
    developer: { type: 'string', description: 'Застройщик.' },
    propertyClasses: {
      type: 'array',
      items: { type: 'string', enum: ['Комфорт-класс', 'Бизнес-класс', 'Премиум-класс', 'Делюкс'] },
      description: 'Класс ЖК. «Элит», «элитка», «de luxe», «люкс» — это Делюкс.',
    },
    finishing: {
      type: 'array',
      items: { type: 'string', enum: ['без отделки', 'white box', 'с отделкой', 'с мебелью'] },
      description: 'Отделка лота. «Предчистовая», «WB» — white box; «чистовая», «под ключ» — с отделкой.',
    },
    pricePerM2Min: { type: 'number', description: 'Цена за м² от, ₽.' },
    pricePerM2Max: { type: 'number', description: 'Цена за м² до, ₽.' },
    metroWalkMinutesMax: { type: 'integer', description: 'Не дальше стольких минут пешком до ближайшего метро.' },
    commercial: { type: 'boolean', description: 'true — коммерческие помещения вместо жилья.' },
  };
  const tools: AssistantLlmTool[] = [
    {
      name: 'find_projects',
      description: 'Найти проекты (ЖК, апарт-комплексы, БЦ) в каталоге Platforma по названию, застройщику или адресу. Возвращает projectId, число доступных лотов и цену от.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Название проекта, например «Веер 2» или «Lion Gate».' } },
        required: ['query'],
      },
    },
    {
      name: 'search_lots',
      description: 'Поиск доступных к продаже лотов в Platforma. Все фильтры необязательные.',
      parameters: {
        type: 'object',
        properties: {
          projectIds: { type: 'array', items: { type: 'string' }, description: 'projectId из find_projects.' },
          ...searchFilters,
          sort: { type: 'string', enum: ['price_asc', 'price_desc', 'area_asc', 'area_desc'] },
          limit: { type: 'integer', description: 'До 15, по умолчанию 10.' },
        },
      },
    },
    {
      name: 'search_projects',
      description: 'ЖК из каталога Platforma под фильтры места, метро, застройщика, класса или срока — с лотами и без. Для каждого: matchingLotsInPlatforma (сколько его лотов проходит фильтры комнатности, бюджета, площади), всего доступных лотов, цена от по лотам и по карточке (cardPriceFromRub, может быть устаревшей), срок сдачи, известен ли сайт застройщика. ЖК без подходящих лотов идут первыми, до 15 штук.',
      parameters: { type: 'object', properties: searchFilters },
    },
    {
      name: 'get_project_facts',
      description: 'Карточка ЖК из Platforma: класс, застройщик, адрес, метро и минуты пешком, срок сдачи, цены от, цена за м² от, потолки, этажность, площади, отделка лотов, описания (наполнение, архитектура, инфраструктура) и даты обновления. Для любых вопросов о конкретном ЖК.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'projectId из find_projects.' } },
        required: ['projectId'],
      },
    },
    {
      name: 'check_project_sites',
      description: `Проверить ЖК на сайтах застройщиков: для каждого найти страницу ЖК на официальном сайте застройщика, открыть её и вернуть текст, ссылки и данные о квартирах. official = true — страница на известном домене застройщика, false — сайт найден поиском. До ${maxSiteChecks} ЖК за ответ, все сразу в одном вызове.`,
      parameters: {
        type: 'object',
        properties: { projectIds: { type: 'array', items: { type: 'string' }, description: 'projectId из search_projects или find_projects.' } },
        required: ['projectIds'],
      },
    },
    {
      name: 'open_page',
      description: 'Открыть веб-страницу в браузере и прочитать её текст, ссылки и данные о квартирах, которые страница загружает (JSON).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    {
      name: 'give_answer',
      description: 'Финальный ответ брокеру.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Короткий ответ без списка лотов и ЖК.' },
          platformLotIds: { type: 'array', items: { type: 'string' }, description: 'lotId из search_lots.' },
          webLots: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                projectTitle: { type: 'string' },
                description: { type: 'string', description: 'Корпус, секция, номер, отделка — что указано на сайте.' },
                rooms: { type: 'integer' },
                areaM2: { type: 'number' },
                floor: { type: 'integer' },
                priceRub: { type: 'number' },
                url: { type: 'string', description: 'Ссылка на открытую страницу с этим лотом.' },
              },
              required: ['projectTitle', 'url'],
            },
          },
          projects: {
            type: 'array',
            description: 'ЖК под запрос без подходящих лотов в Platforma.',
            items: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'projectId из search_projects или find_projects.' },
                note: { type: 'string', description: 'Что известно: с сайта застройщика или из карточки Platforma.' },
                priceFromRub: { type: 'number', description: 'Цена от, если видел её на странице сайта.' },
              },
              required: ['projectId', 'note'],
            },
          },
        },
        required: ['text'],
      },
    },
  ];
  if (webSearchEnabled) {
    tools.splice(tools.findIndex((tool) => tool.name === 'open_page'), 0, {
      name: 'web_search',
      description: 'Поиск в интернете. Возвращает до 8 результатов: заголовок, ссылка, фрагмент.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    });
  }
  return tools;
}

function parseArguments(toolCall: AssistantLlmToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => readString(item) ?? []) : [];
}

function readNumber(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.replace(/[\s ]/gu, '').replace(',', '.')) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readInteger(value: unknown) {
  const parsed = readNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return null;
  }
}

function sameSite(left: string | null, right: string) {
  if (!left) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}
