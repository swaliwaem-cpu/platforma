import { TrainingAdminCriteriaController } from './training-admin-criteria.controller';
import { TrainingAdminDocumentsController } from './training-admin-documents.controller';
import { TrainingAdminFactsController } from './training-admin-facts.controller';
import { TrainingAdminFactSuggestionsController } from './training-admin-fact-suggestions.controller';
import { TrainingAdminOfficialUrlSourcesController } from './training-admin-official-url-sources.controller';
import { TrainingAdminQuestionsController } from './training-admin-questions.controller';
import { TrainingContentService } from './training-content.service';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingFactSuggestionsService } from './fact-suggestions/training-fact-suggestions.service';
import { TrainingOfficialUrlSourcesService } from './training-official-url-sources.service';

type TrainingAdminCompatibilityDelegates = {
  criteria: TrainingAdminCriteriaController;
  documents: TrainingAdminDocumentsController;
  facts: TrainingAdminFactsController;
  factSuggestions: TrainingAdminFactSuggestionsController;
  officialUrlSources: TrainingAdminOfficialUrlSourcesController;
  questions: TrainingAdminQuestionsController;
};

export class TrainingAdminControllerCompatibility {
  private readonly compatibilityDelegates: TrainingAdminCompatibilityDelegates;

  protected constructor(
    trainingContent: TrainingContentService,
    trainingDocuments: TrainingDocumentsService,
    documentWorker: TrainingDocumentWorkerService,
    officialUrlSources: TrainingOfficialUrlSourcesService,
    factSuggestions: TrainingFactSuggestionsService,
  ) {
    this.compatibilityDelegates = {
      criteria: new TrainingAdminCriteriaController(trainingContent),
      documents: new TrainingAdminDocumentsController(
        trainingDocuments,
        documentWorker,
      ),
      facts: new TrainingAdminFactsController(trainingContent),
      factSuggestions: new TrainingAdminFactSuggestionsController(
        factSuggestions,
      ),
      officialUrlSources: new TrainingAdminOfficialUrlSourcesController(
        officialUrlSources,
      ),
      questions: new TrainingAdminQuestionsController(trainingContent),
    };
  }
}

export interface TrainingAdminControllerCompatibility
  extends Pick<
      TrainingAdminCriteriaController,
      keyof TrainingAdminCriteriaController
    >,
    Pick<
      TrainingAdminDocumentsController,
      keyof TrainingAdminDocumentsController
    >,
    Pick<TrainingAdminFactsController, keyof TrainingAdminFactsController>,
    Pick<
      TrainingAdminFactSuggestionsController,
      keyof TrainingAdminFactSuggestionsController
    >,
    Pick<
      TrainingAdminOfficialUrlSourcesController,
      keyof TrainingAdminOfficialUrlSourcesController
    >,
    Pick<
      TrainingAdminQuestionsController,
      keyof TrainingAdminQuestionsController
    > {}

const compatibilityMethods = [
  ['documents', 'listRealEstateObjects'],
  ['documents', 'listDocuments'],
  ['officialUrlSources', 'listOfficialUrlSources'],
  ['officialUrlSources', 'createOfficialUrlSource'],
  ['officialUrlSources', 'getOfficialUrlSourceText'],
  ['officialUrlSources', 'retryOfficialUrlSource'],
  ['officialUrlSources', 'deleteOfficialUrlSource'],
  ['factSuggestions', 'createFactSuggestionRun'],
  ['factSuggestions', 'getLatestFactSuggestionRun'],
  ['factSuggestions', 'listFactSuggestions'],
  ['factSuggestions', 'acceptFactSuggestion'],
  ['factSuggestions', 'rejectFactSuggestion'],
  ['documents', 'uploadDocument'],
  ['documents', 'getDocumentText'],
  ['documents', 'updateDocumentText'],
  ['documents', 'retryDocument'],
  ['documents', 'deleteDocument'],
  ['documents', 'getDocumentContent'],
  ['questions', 'listQuestions'],
  ['questions', 'createQuestion'],
  ['questions', 'updateQuestion'],
  ['questions', 'deleteQuestion'],
  ['facts', 'listFacts'],
  ['facts', 'createFact'],
  ['facts', 'updateFact'],
  ['facts', 'deleteFact'],
  ['criteria', 'listCriteria'],
  ['criteria', 'createCriterion'],
  ['criteria', 'updateCriterion'],
  ['criteria', 'deleteCriterion'],
] as const satisfies ReadonlyArray<
  readonly [keyof TrainingAdminCompatibilityDelegates, string]
>;

for (const [delegateName, methodName] of compatibilityMethods) {
  Object.defineProperty(TrainingAdminControllerCompatibility.prototype, methodName, {
    configurable: false,
    enumerable: false,
    value: function (
      this: TrainingAdminControllerCompatibility,
      ...args: unknown[]
    ) {
      const delegates = (
        this as unknown as {
          compatibilityDelegates: Record<
            keyof TrainingAdminCompatibilityDelegates,
            Record<string, (...methodArgs: unknown[]) => unknown>
          >;
        }
      ).compatibilityDelegates;
      return delegates[delegateName][methodName]!(...args);
    },
    writable: false,
  });
}
