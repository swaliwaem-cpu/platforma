import type {
  AssistantAnswer,
  AssistantChatTurn,
  AssistantFinishing,
  AssistantLot,
  AssistantPlatformLot,
  AssistantWebLot,
  AssistantWebSource,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  type AssistantCatalogTools,
  type AssistantLotSearchInput,
  type AssistantProjectFacts,
  type AssistantProjectMatch,
  normalizePropertyClasses,
} from './assistant-catalog.tools';
import type { AssistantLlm, AssistantLlmMessage, AssistantLlmTool, AssistantLlmToolCall } from './assistant-llm.client';
import { type AssistantOpenedPage, type AssistantWeb, AssistantWebToolError } from './assistant-web.tools';

// One assistant turn: the model calls catalog and web tools until it gives an answer.
// Everything it shows is checked against what the tools actually returned in this turn.

const maxModelCalls = 10;
const maxWebSearches = 3;
const maxOpenedPages = 4;
const maxHistoryTurns = 12;
const maxTurnChars = 4_000;
const maxLotsInAnswer = 10;

export type AssistantAgentContext = {
  history: AssistantChatTurn[];
  pageProject: { title: string; projectId: string } | null;
  now: Date;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
};

export type AssistantAgentDependencies = {
  llm: AssistantLlm;
  catalog: Pick<AssistantCatalogTools, 'findProjects' | 'searchLots' | 'getProjectFacts'>;
  web: AssistantWeb;
};

type TurnState = {
  platformLots: Map<string, AssistantPlatformLot>;
  projectFacts: Map<string, AssistantProjectFacts>;
  pages: Map<string, AssistantOpenedPage>;
  searches: number;
  inputTokens: number;
  outputTokens: number;
};

export type AssistantAgentResult = {
  answer: AssistantAnswer;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; webSearches: number; openedPages: number };
};

export async function runAssistantAgent(
  dependencies: AssistantAgentDependencies,
  context: AssistantAgentContext,
): Promise<AssistantAgentResult> {
  const state: TurnState = {
    platformLots: new Map(),
    projectFacts: new Map(),
    pages: new Map(),
    searches: 0,
    inputTokens: 0,
    outputTokens: 0,
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
    state.inputTokens += response.usage.inputTokens;
    state.outputTokens += response.usage.outputTokens;

    const answerCall = response.toolCalls.find((toolCall) => toolCall.name === 'give_answer');
    if (answerCall) {
      context.onStep?.('Формирую ответ');
      return finish(buildAnswer(parseArguments(answerCall), state), state, call);
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
      return finish(buildAnswer({ text: stripPseudoToolCalls(response.content ?? '') }, state), state, call);
    }

    messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(dependencies, toolCall, state, context);
      messages.push({ role: 'tool', toolCallId: toolCall.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('ASSISTANT_AGENT_NO_ANSWER');
}

function finish(answer: AssistantAnswer, state: TurnState, modelCalls: number): AssistantAgentResult {
  return {
    answer,
    usage: {
      modelCalls,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      webSearches: state.searches,
      openedPages: state.pages.size,
    },
  };
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
          input.metroWalkMinutesMax !== undefined ? 'ЖК, для которых время пешком до метро не посчитано, в выдачу не попали.' : null,
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
      case 'web_search': {
        const query = readString(args.query);
        if (!query) return { error: 'Нужен текст запроса в поле query.' };
        if (state.searches >= maxWebSearches) return { error: 'Лимит поисков исчерпан. Отвечай по найденному.' };
        state.searches += 1;
        context.onStep?.(`Ищу в интернете: ${query}`);
        return { results: await dependencies.web.search(query, context.signal) };
      }
      case 'open_page': {
        const url = readString(args.url);
        if (!url) return { error: 'Нужна ссылка в поле url.' };
        if (state.pages.size >= maxOpenedPages) return { error: 'Лимит открытых страниц исчерпан. Отвечай по найденному.' };
        context.onStep?.(`Открываю ${hostOf(url) ?? url}`);
        const page = await dependencies.web.openPage(url, context.signal);
        state.pages.set(page.url, page);
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
  const webSources = [...state.pages.values()].map((page): AssistantWebSource => ({
    url: page.url,
    siteName: hostOf(page.url) ?? page.url,
    title: page.title || null,
  }));
  return { text, lots: shownLots, webSources, historyNote: createHistoryNote(text, shownLots) };
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
  return text.replace(/\b(?:give_answer|search_lots|find_projects|get_project_facts|web_search|open_page)\s*\([\s\S]*$/u, '').trim();
}

function createHistoryNote(text: string, lots: AssistantLot[]) {
  if (lots.length === 0) return text;
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
  return `${text}\n\nПоказанные лоты:\n${lines.join('\n')}`;
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
    district: project.district,
    metro: project.metro,
    nearestMetroWalk: project.nearestMetroWalk,
    availableLotsInPlatforma: project.availableLots,
    priceFromRub: project.priceFromRub,
    roomsAvailable: project.roomsAvailable,
  };
}

function describeFacts(facts: AssistantProjectFacts) {
  const { href: _href, cardUpdatedAt, feedUpdatedAt, ...rest } = facts;
  return {
    ...rest,
    nearestMetroWalk: facts.nearestMetroWalk ?? 'нет данных о времени пешком до метро',
    updated: { card: cardUpdatedAt.slice(0, 10), feed: feedUpdatedAt?.slice(0, 10) ?? null },
  };
}

const propertyClassList = 'Комфорт-класс, Бизнес-класс, Премиум-класс, Делюкс';
const assistantFinishingList = 'без отделки, white box, с отделкой, с мебелью';

// Words brokers and feeds use for finishing, by the start of the word.
const finishingByWordStart: ReadonlyArray<readonly [string, AssistantFinishing]> = [
  ['без', 'без отделки'],
  ['черн', 'без отделки'],
  ['white', 'white box'],
  ['whitebox', 'white box'],
  ['wb', 'white box'],
  ['вайт', 'white box'],
  ['предчист', 'white box'],
  ['мебел', 'с мебелью'],
  ['смебел', 'с мебелью'],
  ['сотдел', 'с отделкой'],
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
    district: readString(args.district) ?? undefined,
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
    'Ты — помощник брокера по новостройкам (в основном Москва) во внутренней платформе Platforma. Твоя главная задача — находить лоты (квартиры, апартаменты, помещения) под запрос брокера.',
    `Сегодня ${today}. Отвечай по-русски, коротко и по делу.`,
    '',
    'Порядок работы:',
    '1. Всегда начинай с Platforma, даже если брокер прислал ссылку. Если в запросе есть название ЖК/проекта — вызови find_projects, затем search_lots с projectIds найденного проекта. Если названия нет — сразу search_lots по фильтрам (район, метро, застройщик, бюджет, комнатность, площадь, этаж, срок сдачи).',
    '2. Если проекта нет в Platforma, у него 0 лотов (availableLotsInPlatforma = 0) или подходящих лотов нет — ищи в интернете: '
      + (webSearchEnabled
        ? 'web_search (например «ЖК <название> квартиры цены» или «<название> официальный сайт»), затем open_page на официальном сайте застройщика или агрегаторе (ЦИАН, Яндекс Недвижимость, Домклик, Novostroy-m и т.п.). Если на странице есть ссылка на выбор квартир — открой её.'
        : 'веб-поиск сейчас не настроен, но можно вызвать open_page, если ссылка известна из разговора. Иначе честно скажи, что в Platforma лотов нет, а веб-поиск не подключён.'),
    '3. Если точных лотов нет нигде — сам сделай search_lots без самого жёсткого условия (чаще всего без бюджета, с сортировкой по цене; или соседняя комнатность) и покажи 3–5 ближайших лотов, явно написав, чем они отличаются от запроса (например «дороже бюджета на 3,3 млн»). Не спрашивай разрешения на это.',
    '',
    'Правила:',
    '- Никогда не выдумывай лоты, цены, площади и ссылки. Показывай только то, что вернули инструменты.',
    '- Лоты из Platforma передавай в give_answer через platformLotIds (lotId из search_lots). Лоты с сайтов — через webLots с точной ссылкой на страницу, где ты их видел, и ценой как на сайте.',
    '- Если сайт не показывает конкретные квартиры, не придумывай их: дай ссылку на страницу и скажи, что лоты там нужно смотреть вручную.',
    '- Комнатность: студия = 0, однушка = 1, двушка = 2, трёшка = 3. «Евро-N» — это N−1 спальня; ищи сразу rooms [N−1, N]. Бюджет «до 20 млн» = budgetMaxRub 20000000.',
    '- Не переспрашивай, если можно искать. Уточняй только когда без этого поиск бессмыслен.',
    '- В text не перечисляй лоты списком — карточки покажутся отдельно. Напиши 1–4 предложения: что нашёл, откуда данные, на что обратить внимание. Если данные с сайта — напомни, что цены нужно перепроверить у застройщика.',
    '- Выбирай до 10 лучших лотов под запрос (обычно самые дешёвые подходящие или разные планировки).',
    '- Не упоминай названия инструментов, полей и идентификаторы (projectId, lotId, availableLotsInPlatforma и т.п.) в тексте ответа.',
    '- Юридические и налоговые консультации не даёшь.',
    '- Всегда заканчивай вызовом give_answer.',
    context.pageProject
      ? `\nБрокер сейчас на странице проекта «${context.pageProject.title}» (projectId ${context.pageProject.projectId}). Ограничивай поиск этим проектом, только если брокер на него ссылается («этот ЖК», «здесь», «тут») или не называет другого проекта в вопросе про конкретный ЖК. Общие запросы вроде «студия до 12 млн» ищи по всей Platforma.`
      : '',
  ].join('\n');
}

function createTools(webSearchEnabled: boolean): AssistantLlmTool[] {
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
          district: { type: 'string', description: 'Район, например «Хамовники».' },
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
          sort: { type: 'string', enum: ['price_asc', 'price_desc', 'area_asc', 'area_desc'] },
          limit: { type: 'integer', description: 'До 15, по умолчанию 10.' },
        },
      },
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
          text: { type: 'string', description: 'Короткий ответ без списка лотов.' },
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
        },
        required: ['text'],
      },
    },
  ];
  if (webSearchEnabled) {
    tools.splice(2, 0, {
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
