export class TrainingReviewSubmission {
  #key = null;
  #payload = null;
  #payloadHash = null;
  #state = 'IDLE';
  #uuid;

  constructor(uuid = () => crypto.randomUUID()) {
    this.#uuid = uuid;
  }

  begin(payload) {
    const serialized = canonicalJson(payload);
    const canReplaceOperation =
      this.#state === 'IDLE' ||
      this.#state === 'COMPLETED' ||
      (this.#state === 'POST_FAILED' && this.#payload !== serialized);
    if (canReplaceOperation) {
      this.#key = null;
      this.#payload = null;
      this.#payloadHash = null;
    }
    if (this.#payload !== null && this.#payload !== serialized) {
      throw new Error(
        'Active training review operation payload cannot be changed',
      );
    }
    if (!this.#key) {
      this.#payload = serialized;
      this.#payloadHash = hashCanonicalPayload(serialized);
      this.#key = `training-review-${this.#uuid()}`;
    }
    this.#state = 'SUBMITTING';
    return this.#snapshot();
  }

  retryAmbiguous() {
    if (this.#state !== 'POST_AMBIGUOUS') {
      throw new Error('Training review operation is not ambiguous');
    }
    this.#state = 'SUBMITTING';
    return this.#snapshot();
  }

  markCommitted() {
    this.#state = 'COMMITTED';
  }

  markRefreshing() {
    this.#state = 'REFRESHING';
  }

  markCompleted() {
    this.#state = 'COMPLETED';
  }

  markPostAmbiguous() {
    this.#state = 'POST_AMBIGUOUS';
  }

  markRefreshFailed() {
    this.#state = 'REFRESH_FAILED';
  }

  markPostFailed() {
    this.#state = 'POST_FAILED';
  }

  reset() {
    this.#key = null;
    this.#payload = null;
    this.#payloadHash = null;
    this.#state = 'IDLE';
  }

  #snapshot() {
    if (!this.#key || !this.#payload || !this.#payloadHash) {
      throw new Error('Training review operation is not initialized');
    }
    return {
      key: this.#key,
      payload: JSON.parse(this.#payload),
      payloadHash: this.#payloadHash,
    };
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonicalValue(value[key])]),
    );
  }
  return value;
}

function hashCanonicalPayload(serialized) {
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
