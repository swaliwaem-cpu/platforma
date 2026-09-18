import { Injectable } from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantGeoCandidate,
  AssistantGeoConstraint,
  AssistantGeoPoint,
  AssistantGeoResolution,
  AssistantGeoResolutionSlot,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
  AssistantGeoView,
  AssistantPageContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantPlannerError,
  AssistantQueryPlanner,
  createEmptyAssistantSearchFilters,
  extractAssistantLogicalPredicates,
  extractAssistantExplicitHardFilters,
  type AssistantDialogMessage,
  type AssistantPlannerTelemetry,
  type AssistantStructuredIntent,
} from './assistant-query-planner';
import {
  buildAssistantSearchAnswer,
  validateAssistantSearchAnswer,
  type AssistantSearchEvidence,
} from './assistant-search-ranking';
import { AssistantSearchService } from './assistant-search.service';
import type { AssistantGeoSearchResult } from './assistant-search.service';
import { extractAssistantStrictDistrictFromText } from './geo/assistant-district-query';
import { AssistantMetroTravelTimeUnavailableError } from './geo/assistant-metro-travel-time.service';
import { buildAssistantComparisonAnswer } from './assistant-comparison-answer';
import {
  buildAssistantObjectAnswer,
  validateAssistantObjectAnswer,
  type AssistantObjectEvidence,
} from './catalog/assistant-object-answer';
import { AssistantPlatformCatalogService } from './catalog/assistant-platform-catalog.service';
import { assistantGeoDefaultPointDistanceMeters } from './geo/assistant-geo-contract';
import {
  AssistantPlaceResolverService,
  parseResolveInputs,
} from './geo/assistant-place-resolver.service';
import { buildAssistantKnowledgeAnswer } from './sources/assistant-knowledge-answer';
import {
  AssistantKnowledgeRetrievalService,
  type AssistantKnowledgeEvidence,
} from './sources/assistant-knowledge-retrieval.service';
import { AssistantCurrentFactRefreshCoordinator } from './sources/assistant-current-fact-refresh.service';
import {
  createAssistantKnowledgePageContext,
  createAssistantKnowledgeQueryContext,
  extractAssistantKnowledgeProjectReferenceClause,
  hasExplicitAssistantKnowledgeProjectReference,
  requiresAssistantKnowledgeCurrentVerification,
} from './sources/assistant-knowledge-policy';

export type AssistantAnswerResult = {
  content: string;
  answer: AssistantAnswer;
  intent: AssistantStructuredIntent;
  evidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence | AssistantObjectEvidence>;
  candidateEvidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence | AssistantObjectEvidence>;
  telemetry: AssistantPlannerTelemetry[];
};

@Injectable()
export class AssistantAnswerService {
  constructor(
    private readonly planner: AssistantQueryPlanner,
    private readonly search: AssistantSearchService,
    private readonly knowledge?: AssistantKnowledgeRetrievalService,
    private readonly places?: AssistantPlaceResolverService,
    private readonly currentFactRefresh?: AssistantCurrentFactRefreshCoordinator,
    private readonly platformCatalog?: AssistantPlatformCatalogService,
  ) {}

  async answer(input: {
    messages: string[];
    dialog?: AssistantDialogMessage[];
    context: AssistantPageContext | null;
    geo?: AssistantGeoSearchSelection | null;
    operationRunId?: string;
    executionId?: string;
    actorUserId?: string;
    now?: Date;
    deadlineAt?: Date;
  }): Promise<AssistantAnswerResult> {
    const now = input.now ?? new Date();
    const plannerMessages = input.messages;
    const searchExecution = { deadlineAt: input.deadlineAt, onDemandObjectIds: new Set<string>() };
    if (deadlineExpired(input.deadlineAt)) {
      return completeUnavailableResult(plannerMessages, 'DEADLINE');
    }
    let districtResolution;
    try {
      districtResolution = await this.resolveDistrict(plannerMessages, input.geo ?? null);
    } catch (error) {
      if (!isPrismaRuntimeError(error)
        && (!(error instanceof Error) || error.message !== 'DATABASE_UNAVAILABLE')) throw error;
      return completeUnavailableResult(plannerMessages, 'DATA');
    }
    const planned = await this.planner.planWithValidation(
      {
        messages: plannerMessages,
        dialog: input.dialog,
        context: input.geo || districtResolution
          ? {
              pageContext: input.context,
              ...(districtResolution ? { districtResolution } : {}),
              ...(input.geo ? { geo: createPlannerGeoSummary(input.geo) } : {}),
            }
          : input.context,
        operationRunId: input.operationRunId,
        executionId: input.executionId,
        deadlineAt: input.deadlineAt,
      },
      async (intent, request, attempts) => {
        if (intent.taskType === 'LEGAL_TAX') {
          return {
            content: [
              'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
              'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
            ].join(' '),
            answer: { kind: 'SAFE_BOUNDARY' } as const,
            evidence: [] as AssistantSearchEvidence[],
            candidateEvidence: [] as AssistantSearchEvidence[],
          };
        }
        if (intent.needsClarification) {
          return {
            content: intent.clarificationQuestion!,
            answer: {
              kind: 'CLARIFICATION',
              reason: intent.clarificationReason ?? 'MISSING_NUMERIC_VALUE',
            } as const,
            evidence: [] as AssistantSearchEvidence[],
            candidateEvidence: [] as AssistantSearchEvidence[],
          };
        }

        const plannedGeo = await this.resolvePlannedGeo(intent, input);
        if ('terminal' in plannedGeo) return plannedGeo.terminal;
        const effectiveGeo = plannedGeo.geo;

        const query = createAssistantKnowledgeQueryContext(plannerMessages, input.context);
        let knowledgeContext = createAssistantKnowledgePageContext(plannerMessages, input.context);
        if (intent.taskType === 'OBJECT') {
          if (!this.platformCatalog) throw new Error('ASSISTANT_PLATFORM_CATALOG_UNAVAILABLE');
          const result = await this.platformCatalog.ground({
            query,
            intent,
            context: input.context,
          });
          const grounded = buildAssistantObjectAnswer(result.evidence, result.totalObjects, query);
          validateAssistantObjectAnswer(grounded, result.evidence, result.totalObjects, query);
          const { content, ...answer } = grounded;
          const selectedIds = new Set([
            ...answer.objects.map(({ objectId }) => objectId),
            ...answer.additionalObjects.map(({ objectId }) => objectId),
          ]);
          return {
            content,
            answer,
            evidence: result.evidence.filter(({ objectId }) => selectedIds.has(objectId)),
            candidateEvidence: result.evidence,
          };
        }
        if (intent.taskType === 'FACT' && this.knowledge) {
          const currentVerificationRequested = requiresAssistantKnowledgeCurrentVerification(query);
          const projectReferenceClause = extractAssistantKnowledgeProjectReferenceClause(query);
          if (projectReferenceClause) {
            const canResolveProject = typeof this.knowledge.resolveProjectContext === 'function';
            const resolvedProjectContext = await this.knowledge.resolveProjectContext?.(query);
            if (resolvedProjectContext === null
              || (canResolveProject
                && resolvedProjectContext === undefined
                && hasExplicitAssistantKnowledgeProjectReference(query))) {
              return sourceNotConnectedResult([]);
            }
            if (resolvedProjectContext) {
              knowledgeContext = resolvedProjectContext;
            } else if (input.context?.kind === 'OBJECT') {
              knowledgeContext = input.context;
            } else {
              return knowledgeScopeRequiredResult([]);
            }
          } else {
            knowledgeContext = input.context;
          }
          if (currentVerificationRequested
            && knowledgeContext?.kind !== 'OBJECT'
            && knowledgeContext?.kind !== 'DEVELOPER') {
            return knowledgeScopeRequiredResult([]);
          }
          const evidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: false,
            context: knowledgeContext,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const grounded = buildAssistantKnowledgeAnswer(evidence, now, query);
          const refreshRequired = currentVerificationRequested
            || grounded.evidence.some((item) => isStaleKnowledgeEvidence(item, now));
          if (refreshRequired) {
            if (!this.currentFactRefresh || !request.operationRunId) {
              return currentVerificationFailure(evidence);
            }
            const refresh = await this.currentFactRefresh.refreshForRun({
              operationRunId: request.operationRunId,
              context: knowledgeContext,
              preferredSourceId: grounded.evidence[0]?.sourceId ?? null,
              deadlineAt: input.deadlineAt ?? new Date(now.getTime() + 15_000),
            });
            if (refresh.status === 'SOURCE_NOT_CONNECTED') {
              return sourceNotConnectedResult(evidence);
            }
            if (refresh.status !== 'COMPLETED') return currentVerificationFailure(evidence);
            const refreshedEvidence = await this.knowledge.retrieve({
              query,
              intent,
              includeExternalLots: false,
              context: knowledgeContext,
              now,
              embeddingOperation: {
                operationRunId: request.operationRunId,
                executionId: request.executionId,
                nextAttemptOrdinal: attempts.nextAttemptOrdinal,
              },
            });
            const refreshedGrounded = buildAssistantKnowledgeAnswer(refreshedEvidence, now, query);
            if (refreshedGrounded.answer.facts.length > 0
              && !refreshedGrounded.evidence.some((item) => isStaleKnowledgeEvidence(item, now))) {
              return { ...refreshedGrounded, candidateEvidence: refreshedEvidence };
            }
            return currentVerificationFailure(refreshedEvidence);
          }
          if (grounded.answer.facts.length > 0) return { ...grounded, candidateEvidence: evidence };
          return {
            content: 'Не могу подтвердить ответ по доступным источникам.',
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantKnowledgeEvidence[],
            candidateEvidence: evidence,
          };
        }

        if (intent.taskType === 'COMPARE' && intent.comparisonTargets.length === 2) {
          const comparisonContext = input.context?.kind === 'CATALOG_FILTERS'
            ? input.context
            : null;
          let comparisonResults;
          try {
            comparisonResults = await Promise.all(intent.comparisonTargets.map((target, index) => (
              this.search.search({
                ...intent,
                comparisonTargets: [target],
                comparisonTargetModes: [intent.comparisonTargetModes?.[index] ?? 'EXACT'],
              }, comparisonContext, effectiveGeo, searchExecution)
            )));
          } catch (error) {
            return unavailableFromExecutionError(error);
          }
          const grounded = buildAssistantComparisonAnswer(intent, comparisonResults.map((result, index) => ({
            target: intent.comparisonTargets[index]!,
            evidence: result.exact,
            totalExactResults: result.totalExactResults,
            summary: result.summary,
          })), now);
          const geoResult = comparisonResults.find(({ geo }) => geo !== null)?.geo ?? null;
          const geo = geoResult
            ? createGeoSearchView(
                geoResult,
                grounded.evidence,
                new Set(grounded.evidence.map(({ unitId }) => unitId)),
              )
            : null;
          return {
            ...grounded,
            answer: { ...grounded.answer, ...(geo ? { geo } : {}) },
            candidateEvidence: uniqueSearchEvidence(comparisonResults.flatMap(({ exact }) => exact)),
          };
        }

        let searchResult;
        try {
          searchResult = await this.search.search(
            intent,
            input.context,
            effectiveGeo,
            searchExecution,
          );
        } catch (error) {
          return unavailableFromExecutionError(error);
        }
        if (!effectiveGeo && !intent.predicates?.length && searchResult.exact.length === 0 && this.knowledge) {
          const knowledgeEvidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: true,
            context: knowledgeContext,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const knowledgeAnswer = buildAssistantKnowledgeAnswer(knowledgeEvidence, now, query);
          if (knowledgeAnswer.answer.externalLots.length > 0) {
            return { ...knowledgeAnswer, candidateEvidence: knowledgeEvidence };
          }
        }
        const evidence = [...searchResult.exact, ...searchResult.alternatives];
        const grounded = buildAssistantSearchAnswer(
          intent,
          searchResult.exact,
          searchResult.alternatives,
          now,
          searchResult.totalExactResults,
        );
        validateAssistantSearchAnswer(
          grounded,
          evidence,
          intent,
          now,
          searchResult.totalExactResults,
        );
        const selectedIds = new Set([
          ...grounded.exactResults.map(({ unitId }) => unitId),
          ...grounded.additionalExactResults.map(({ unitId }) => unitId),
          ...grounded.alternatives.map(({ unitId }) => unitId),
        ]);
        const selectedEvidence = evidence.filter(({ unitId }) => selectedIds.has(unitId));
        const geoVisibleIds = new Set([
          ...grounded.exactResults.map(({ unitId }) => unitId),
          ...grounded.alternatives.map(({ unitId }) => unitId),
        ]);
        const geo = searchResult.geo
          ? createGeoSearchView(
              searchResult.geo,
              evidence.filter(({ unitId }) => geoVisibleIds.has(unitId)),
              new Set(grounded.exactResults.map(({ unitId }) => unitId)),
            )
          : null;
        return {
          content: grounded.content,
          answer: {
            kind: 'SEARCH_RESULTS',
            totalExactResults: grounded.totalExactResults,
            exactResults: grounded.exactResults,
            additionalExactResults: grounded.additionalExactResults,
            alternatives: grounded.alternatives,
            ...(geo ? { geo } : {}),
          } as const,
          evidence: selectedEvidence,
          candidateEvidence: evidence,
        };
      },
    ).catch((error: unknown) => {
      if (!(error instanceof AssistantPlannerError)) throw error;
      if (error.code === 'ASSISTANT_TRAVEL_CONSTRAINT_UNSUPPORTED') {
        return plannedUnavailableResult(plannerMessages, 'ROUTING', error.telemetry);
      }
      if (error.code === 'ASSISTANT_EXECUTION_DEADLINE_EXCEEDED') {
        return plannedUnavailableResult(plannerMessages, 'DEADLINE', error.telemetry);
      }
      if (error.telemetry.at(-1)?.outcome === 'PROVIDER_ERROR') {
        return plannedUnavailableResult(plannerMessages, 'PROVIDER', error.telemetry);
      }
      if (error.pipelineCause !== undefined) {
        return {
          intent: createUnavailableIntent(plannerMessages),
          value: unavailableFromExecutionError(error.pipelineCause),
          telemetry: error.telemetry,
        };
      }
      throw error;
    });

    return {
      ...planned.value,
      intent: planned.intent,
      telemetry: planned.telemetry,
    };
  }

  private async resolvePlannedGeo(
    intent: AssistantStructuredIntent,
    input: {
      messages: string[];
      geo?: AssistantGeoSearchSelection | null;
      actorUserId?: string;
      deadlineAt?: Date;
    },
  ): Promise<
    | { geo: AssistantGeoSearchSelection | null }
    | { terminal: Omit<AssistantAnswerResult, 'intent' | 'telemetry'> }
  > {
    if (input.geo) return { geo: input.geo };
    const predicate = intent.predicates?.find((item) => item.type === 'SPATIAL');
    if (!predicate) {
      for (const message of [...input.messages].reverse()) {
        try {
          if (parseResolveInputs({ content: message }).constraints.length > 0) {
            return this.resolveGeoText(message, input);
          }
        } catch {
          return { terminal: unavailableResult('PLACE_RESOLUTION') };
        }
        // A later turn that names its own location replaces the place of an earlier one.
        // Without this the whole conversation stayed pinned to the first place it mentioned:
        // «квартиру в ЦАО на 3 комнаты» kept being answered about a shopping centre asked
        // about three messages earlier, and re-asked the same unanswerable clarification.
        if (mentionsOwnLocation(message)) return { geo: null };
      }
      return { geo: null };
    }
    return this.resolveGeoText(`внутри «${predicate.place}»`, input);
  }

  private async resolveGeoText(
    content: string,
    input: {
      actorUserId?: string;
      deadlineAt?: Date;
    },
  ): Promise<
    | { geo: AssistantGeoSearchSelection | null }
    | { terminal: Omit<AssistantAnswerResult, 'intent' | 'telemetry'> }
  > {
    if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now()) {
      return { terminal: unavailableResult('DEADLINE') };
    }
    if (!this.places) return { terminal: unavailableResult('PLACE_RESOLUTION') };

    let resolution;
    try {
      resolution = await this.places.resolve({
        content,
        locale: 'ru',
        country: 'ru',
      }, input.actorUserId ?? null);
    } catch {
      return { terminal: unavailableResult('PROVIDER') };
    }
    const converted = resolutionToGeoSelection(resolution);
    if (converted.status === 'AMBIGUOUS') {
      const labels = converted.candidateLabels ?? [];
      return {
        terminal: {
          content: labels.length > 0
            ? `Уточните, какое именно место вы имеете в виду: ${labels.join(', ')}.`
            : 'Уточните, какое именно место вы имеете в виду.',
          answer: { kind: 'CLARIFICATION', reason: 'AMBIGUOUS_PLACE' },
          evidence: [],
          candidateEvidence: [],
        },
      };
    }
    if (converted.status !== 'RESOLVED') {
      return {
        terminal: unavailableResult(
          converted.status === 'UNAVAILABLE' ? 'PROVIDER' : 'PLACE_RESOLUTION',
        ),
      };
    }
    return { geo: converted.geo };
  }

  private async resolveDistrict(messages: string[], geo: AssistantGeoSearchSelection | null) {
    const district = extractAssistantExplicitHardFilters(messages).district;
    if (!district || !this.places) return null;
    const administrativeDistrict = await this.places.findAdministrativeDistrict(district);
    if (administrativeDistrict) {
      return {
        input: district,
        canonicalName: administrativeDistrict.name,
        resolvedByGeo: false,
      };
    }
    const landmarks = geo ? geoConstraints(geo).filter((constraint) =>
      constraint.source === 'LANDMARK' && Boolean(constraint.landmarkId)) : [];
    for (const constraint of landmarks) {
      const resolvedByGeo = await this.places.matchesTrustedLandmark(constraint.landmarkId!, district);
      if (resolvedByGeo) return { input: district, canonicalName: null, resolvedByGeo: true };
    }
    // A candidate only the loose extractor produced («в продаже», «на севере») is not a district:
    // report it as unresolved so the planner drops it instead of filtering every object out.
    // An explicit «район X» stays a hard filter even when `locations` does not know the name.
    const strict = messages.some((message) => extractAssistantStrictDistrictFromText(message) === district);
    return strict ? null : { input: district, canonicalName: null, resolvedByGeo: false };
  }
}

function resolutionToGeoSelection(resolution: AssistantGeoResolution):
  | { status: 'RESOLVED'; geo: AssistantGeoSearchSelection }
  | { status: 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE'; candidateLabels?: string[] } {
  if (resolution.status === 'NOT_APPLICABLE') return { status: 'NOT_FOUND' };
  if (resolution.status === 'COMPOSITE') {
    const slots = resolution.constraints.map(narrowSamePlaceAmbiguity);
    const failure = slots.find(({ status }) => status !== 'RESOLVED');
    if (failure) {
      return {
        status: resolutionFailureStatus(failure.status),
        ...(failure.status === 'AMBIGUOUS' ? { candidateLabels: distinctCandidateLabels(failure.candidates) } : {}),
      };
    }
    const constraints = slots.flatMap((slot) => {
      if (slot.status !== 'RESOLVED') return [];
      const candidate = slot.candidates[0];
      const constraint = candidate ? candidateToSelection(candidate, slot) : null;
      return constraint ? [constraint] : [];
    });
    if (constraints.length !== slots.length) return { status: 'NOT_FOUND' };
    return { status: 'RESOLVED', geo: { operator: 'ALL', constraints } };
  }
  const narrowed = narrowSamePlaceAmbiguity(resolution);
  if (narrowed.status !== 'RESOLVED') {
    return {
      status: resolutionFailureStatus(narrowed.status),
      ...(narrowed.status === 'AMBIGUOUS'
        ? { candidateLabels: distinctCandidateLabels('candidates' in narrowed ? narrowed.candidates : []) }
        : {}),
    };
  }
  const candidate = narrowed.candidates[0];
  const constraint = candidate ? candidateToSelection(candidate, narrowed) : null;
  return constraint
    ? { status: 'RESOLVED', geo: constraint }
    : { status: 'NOT_FOUND' };
}

// A geocoder answers «павелецкая плаза» with the mall, its office block and its retail part:
// three candidates a few hundred metres apart, all labelled the same. Asking the broker to pick
// between them cannot be answered and used to end the conversation, so candidates that sit well
// inside the search radius are treated as one place.
function narrowSamePlaceAmbiguity<Resolution extends AssistantGeoResolution | AssistantGeoResolutionSlot>(
  resolution: Resolution,
): Resolution {
  if (resolution.status !== 'AMBIGUOUS') return resolution;
  const candidates = resolution.candidates;
  const points = candidates.map(readCandidatePoint);
  if (points.length < 2 || points.some((point) => point === null)) return resolution;
  const radiusMeters = candidates[0]?.distanceMeters ?? assistantGeoDefaultPointDistanceMeters;
  const tolerance = Math.max(100, Math.min(500, radiusMeters * 0.25));
  const spread = maximumPairwiseDistanceMeters(points as AssistantGeoPoint[]);
  if (spread > tolerance) return resolution;
  return { ...resolution, status: 'RESOLVED', candidates: [candidates[0]!] };
}

function readCandidatePoint(candidate: AssistantGeoCandidate): AssistantGeoPoint | null {
  if (candidate.kind !== 'POINT') return null;
  if (candidate.point) return candidate.point;
  return typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number'
    ? { latitude: candidate.latitude, longitude: candidate.longitude }
    : null;
}

function maximumPairwiseDistanceMeters(points: AssistantGeoPoint[]) {
  let maximum = 0;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      maximum = Math.max(maximum, distanceMeters(points[left]!, points[right]!));
    }
  }
  return maximum;
}

function distanceMeters(left: AssistantGeoPoint, right: AssistantGeoPoint) {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeLeft = toRadians(left.latitude);
  const latitudeRight = toRadians(right.latitude);
  const deltaLatitude = latitudeRight - latitudeLeft;
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitudeLeft) * Math.cos(latitudeRight) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

// A turn names its own location when the deterministic extractors read a district or a metro
// station out of it, even though neither becomes a geo constraint.
function mentionsOwnLocation(message: string) {
  const filters = extractAssistantExplicitHardFilters([message]);
  return Boolean(filters.district || filters.metro);
}

function distinctCandidateLabels(candidates: AssistantGeoCandidate[]) {
  const labels = [...new Set(candidates.map(({ label }) => label.trim()).filter(Boolean))];
  return labels.length > 1 ? labels.slice(0, 3) : [];
}

function resolutionFailureStatus(status: AssistantGeoResolutionSlot['status']) {
  if (status === 'UNAVAILABLE') return 'UNAVAILABLE' as const;
  if (status === 'AMBIGUOUS' || status === 'REFINE_REQUIRED') return 'AMBIGUOUS' as const;
  return 'NOT_FOUND' as const;
}

function candidateToSelection(
  candidate: AssistantGeoCandidate,
  metadata: {
    mode: 'NEAR' | 'INSIDE';
    distanceMeters?: number;
    slotId?: string;
    sourceSpan?: { start: number; end: number };
  },
): AssistantGeoConstraint | null {
  const common = {
    label: candidate.label,
    source: 'LANDMARK' as const,
    landmarkId: candidate.id,
    slotId: metadata.slotId,
    sourceSpan: metadata.sourceSpan,
  };
  if (metadata.mode === 'INSIDE') {
    return candidate.kind === 'AREA'
      ? { ...common, kind: 'AREA', mode: 'INSIDE' }
      : null;
  }
  const distanceMeters = candidate.distanceMeters ?? metadata.distanceMeters;
  if (!distanceMeters) return null;
  if (candidate.kind === 'POINT') {
    const point = candidate.point ?? (typeof candidate.latitude === 'number'
      && typeof candidate.longitude === 'number'
      ? { latitude: candidate.latitude, longitude: candidate.longitude }
      : null);
    return point ? { ...common, kind: 'POINT', mode: 'NEAR', point, distanceMeters } : null;
  }
  return { ...common, kind: candidate.kind, mode: 'NEAR', distanceMeters };
}

function unavailableResult(
  reason: Extract<AssistantAnswer, { kind: 'UNAVAILABLE' }>['reason'],
): Omit<AssistantAnswerResult, 'intent' | 'telemetry'> {
  return {
    content: 'Не удалось выполнить запрос по подтверждённым данным. Попробуйте позже.',
    answer: { kind: 'UNAVAILABLE', reason },
    evidence: [],
    candidateEvidence: [],
  };
}

function unavailableFromExecutionError(error: unknown) {
  if (error instanceof AssistantMetroTravelTimeUnavailableError) {
    return unavailableResult(error.code === 'ASSISTANT_EXECUTION_DEADLINE_EXCEEDED'
      ? 'DEADLINE'
      : 'ROUTING');
  }
  if (error instanceof Error && error.message === 'ASSISTANT_EXECUTION_DEADLINE_EXCEEDED') {
    return unavailableResult('DEADLINE');
  }
  if (isPrismaRuntimeError(error)) return unavailableResult('DATA');
  throw error;
}

function isPrismaRuntimeError(error: unknown) {
  return error instanceof Error && new Set([
    'PrismaClientInitializationError',
    'PrismaClientKnownRequestError',
    'PrismaClientRustPanicError',
    'PrismaClientUnknownRequestError',
  ]).has(error.constructor.name);
}

function deadlineExpired(deadlineAt?: Date) {
  return Boolean(deadlineAt && deadlineAt.getTime() <= Date.now());
}

function completeUnavailableResult(
  messages: string[],
  reason: Extract<AssistantAnswer, { kind: 'UNAVAILABLE' }>['reason'],
): AssistantAnswerResult {
  return {
    ...unavailableResult(reason),
    intent: createUnavailableIntent(messages),
    telemetry: [],
  };
}

function plannedUnavailableResult(
  messages: string[],
  reason: Extract<AssistantAnswer, { kind: 'UNAVAILABLE' }>['reason'],
  telemetry: AssistantPlannerTelemetry[],
) {
  return {
    intent: createUnavailableIntent(messages),
    value: unavailableResult(reason),
    telemetry,
  };
}

function createUnavailableIntent(messages: string[]): AssistantStructuredIntent {
  const logical = extractAssistantLogicalPredicates(messages);
  return {
    schemaVersion: 'AssistantLogicalPlanV1',
    taskType: 'SEARCH',
    comparisonTargets: [],
    comparisonTargetModes: [],
    hardFilters: {
      ...createEmptyAssistantSearchFilters(),
      ...extractAssistantExplicitHardFilters(messages),
    },
    softPreferences: createEmptyAssistantSearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
    predicates: logical.predicates,
    clarificationReason: null,
  };
}

function isStaleKnowledgeEvidence(evidence: AssistantKnowledgeEvidence, now: Date) {
  const verifiedAt = Date.parse(evidence.verifiedAt);
  return !Number.isFinite(verifiedAt) || now.getTime() - verifiedAt >= 24 * 60 * 60 * 1_000;
}

function currentVerificationFailure(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Не удалось подтвердить текущие условия по зарегистрированному источнику.',
    answer: { kind: 'REFUSAL' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function sourceNotConnectedResult(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Для этого объекта не найден доверенный зарегистрированный источник.',
    answer: { kind: 'REFUSAL', code: 'SOURCE_NOT_CONNECTED' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function knowledgeScopeRequiredResult(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Нужно указать ЖК или открыть страницу объекта, чтобы подтвердить ответ.',
    answer: { kind: 'REFUSAL' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function uniqueSearchEvidence(evidence: AssistantSearchEvidence[]) {
  return [...new Map(evidence.map((item) => [item.unitId, item])).values()];
}

function createGeoSearchView(
  geo: AssistantGeoSearchResult,
  evidence: AssistantSearchEvidence[],
  primaryIds: Set<string>,
): AssistantGeoView {
  let primaryCount = 0;
  let alternativeCount = 0;
  const isComposite = 'operator' in geo;
  return {
    ...geo,
    markers: evidence.flatMap((candidate) => {
      if (typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') return [];
      if (!isComposite && geo.mode === 'NEAR' && typeof candidate.distanceMeters !== 'number') return [];
      const kind = primaryIds.has(candidate.unitId) ? 'PRIMARY' as const : 'ALTERNATIVE' as const;
      if (kind === 'PRIMARY' && primaryCount >= 3) return [];
      if (kind === 'ALTERNATIVE' && alternativeCount >= 2) return [];
      if (kind === 'PRIMARY') primaryCount += 1;
      else alternativeCount += 1;
      return [{
        unitId: candidate.unitId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        ...(!isComposite && typeof candidate.distanceMeters === 'number'
          ? { distanceMeters: candidate.distanceMeters }
          : {}),
        kind,
      }];
    }),
  } as AssistantGeoView;
}

function geoConstraints(geo: AssistantGeoSearchSelection): AssistantGeoConstraint[] {
  return 'operator' in geo ? geo.constraints : [geo];
}

function createPlannerGeoSummary(geo: AssistantGeoSearchSelection) {
  const summarize = (constraint: AssistantGeoSearchContext) => ({
    kind: constraint.kind,
    mode: constraint.mode,
    label: constraint.label,
    source: constraint.source,
    ...(constraint.source === 'LANDMARK' ? { landmarkId: constraint.landmarkId } : {}),
    ...(constraint.mode === 'NEAR' ? { distanceMeters: constraint.distanceMeters } : {}),
  });
  return 'operator' in geo
    ? { hasGeoConstraint: true, operator: 'ALL' as const, constraints: geo.constraints.map(summarize) }
    : { hasGeoConstraint: true, ...summarize(geo) };
}
