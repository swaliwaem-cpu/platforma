// Contracts of the lot-finding assistant: the browser starts a job with the whole
// conversation and polls it until the answer is ready.

export type AssistantConfigResponse = {
  enabled: boolean;
  webSearchEnabled: boolean;
};

export type AssistantChatRole = 'user' | 'assistant';

export type AssistantChatTurn = {
  role: AssistantChatRole;
  content: string;
};

export type AssistantAskInput = {
  messages: AssistantChatTurn[];
  /** Slug of the project page the user is looking at, if any. */
  pageObjectSlug?: string | null;
  /** UUID the browser keeps for the conversation, so logged turns can be grouped. */
  conversationId?: string | null;
};

/** Lot finishing as the assistant reports it; lots without the data have none. */
export type AssistantFinishing = 'без отделки' | 'white box' | 'с отделкой' | 'с мебелью';

export type AssistantPlatformLot = {
  source: 'PLATFORMA';
  unitId: string;
  projectTitle: string;
  href: string;
  projectHref: string;
  developer: string | null;
  /** One of the four project classes, null when the project has none. */
  propertyClass: string | null;
  /** 0 means a studio. */
  rooms: number | null;
  areaM2: number | null;
  floor: number | null;
  priceRub: number;
  pricePerM2Rub: number | null;
  finishing: AssistantFinishing | null;
  building: string | null;
  completion: string | null;
  updatedAt: string;
};

export type AssistantWebLot = {
  source: 'WEB';
  projectTitle: string;
  description: string | null;
  rooms: number | null;
  areaM2: number | null;
  floor: number | null;
  /** Null when the price could not be confirmed on the opened page. */
  priceRub: number | null;
  url: string;
  siteName: string;
};

export type AssistantLot = AssistantPlatformLot | AssistantWebLot;

/** Where an answer's data came from: a project in Platforma or a site opened in this turn. */
export type AssistantSource = {
  kind: 'PLATFORMA_PROJECT' | 'WEB';
  title: string;
  /** App path for a Platforma project, absolute URL for a site. */
  url: string;
  /** ISO time: last card or feed update for a project, the moment a site was opened. */
  date: string;
};

export type AssistantAnswer = {
  text: string;
  lots: AssistantLot[];
  sources: AssistantSource[];
  /** Compact summary the browser sends back as this turn's content in later requests. */
  historyNote: string;
  /** Logged turn to rate; null when the log could not be written. */
  turnId: string | null;
};

export type AssistantJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export type AssistantJob = {
  id: string;
  status: AssistantJobStatus;
  steps: string[];
  answer: AssistantAnswer | null;
  error: string | null;
  createdAt: string;
  turnId: string | null;
};

export type AssistantJobResponse = {
  job: AssistantJob;
};

/** One tool call inside a turn, as the turn log keeps it (arguments masked). */
export type AssistantTraceStep = {
  tool: string;
  args: Record<string, unknown>;
  result: { found?: number; ids?: string[]; error?: string };
  durationMs: number;
};

export type AssistantTurnRating = 'UP' | 'DOWN';

export type AssistantTurnFeedbackInput = {
  rating: AssistantTurnRating;
  /** What was wrong; mostly given with a thumbs down. */
  comment?: string | null;
};

export type AssistantAdminTurnSummary = {
  id: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  question: string;
  status: 'COMPLETED' | 'FAILED';
  errorCode: string | null;
  rating: AssistantTurnRating | null;
  ratingComment: string | null;
  lotsCount: number;
  model: string;
  durationMs: number;
  estimatedCostUsd: string | null;
};

export type AssistantAdminTurnsResponse = {
  items: AssistantAdminTurnSummary[];
  nextCursor: string | null;
};

export type AssistantAdminTurn = AssistantAdminTurnSummary & {
  conversationId: string | null;
  answerText: string | null;
  lots: AssistantLot[];
  sources: AssistantSource[];
  trace: AssistantTraceStep[];
  modelCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  pricingVersion: string | null;
  ratedAt: string | null;
};

export type AssistantAdminTurnResponse = {
  turn: AssistantAdminTurn;
};

export type AssistantUsageTotals = {
  turns: number;
  failed: number;
  ratedUp: number;
  ratedDown: number;
  users: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type AssistantUsageDay = AssistantUsageTotals & {
  /** Moscow calendar day, YYYY-MM-DD. */
  date: string;
};

export type AssistantUsageResponse = {
  days: AssistantUsageDay[];
  totals: AssistantUsageTotals;
};
