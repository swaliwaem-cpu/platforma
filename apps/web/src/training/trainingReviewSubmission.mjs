export class TrainingReviewSubmission {
  #key = null;
  #payload = null;
  #uuid;

  constructor(uuid = () => crypto.randomUUID()) {
    this.#uuid = uuid;
  }

  keyFor(payload) {
    const serialized = JSON.stringify(payload);
    if (this.#payload !== serialized) {
      this.#payload = serialized;
      this.#key = `training-review-${this.#uuid()}`;
    }
    return this.#key;
  }

  complete() {
    this.#key = null;
    this.#payload = null;
  }
}
