export class TrainingReviewSubmission {
  constructor(uuid?: () => string);
  keyFor(payload: unknown): string;
  complete(): void;
}
