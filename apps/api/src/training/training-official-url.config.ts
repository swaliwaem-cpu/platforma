function readPositiveInteger(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBoundedPositiveInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = readPositiveInteger(name, fallback);
  return Math.min(maximum, Math.max(minimum, value));
}

export const TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_MAX_RESPONSE_BYTES',
  5 * 1024 * 1024,
);
export const TRAINING_OFFICIAL_URL_MAX_EXTRACTED_CHARACTERS =
  readPositiveInteger(
    'TRAINING_OFFICIAL_URL_MAX_EXTRACTED_CHARACTERS',
    1_000_000,
  );
export const TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS =
  readPositiveInteger(
    'TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS',
    2_000,
  );
export const TRAINING_OFFICIAL_URL_MAX_REDIRECTS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_MAX_REDIRECTS',
  3,
);
export const TRAINING_OFFICIAL_URL_CONNECT_TIMEOUT_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_CONNECT_TIMEOUT_MS',
  5_000,
);
export const TRAINING_OFFICIAL_URL_READ_TIMEOUT_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_READ_TIMEOUT_MS',
  5_000,
);
export const TRAINING_OFFICIAL_URL_TOTAL_TIMEOUT_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_TOTAL_TIMEOUT_MS',
  20_000,
);
export const TRAINING_OFFICIAL_URL_JOB_POLL_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_JOB_POLL_MS',
  2_000,
);
export const TRAINING_OFFICIAL_URL_JOB_LEASE_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_JOB_LEASE_MS',
  60_000,
);
export const TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN',
  25,
);
export const TRAINING_OFFICIAL_URL_DRAIN_DEADLINE_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_DRAIN_DEADLINE_MS',
  45_000,
);
export const TRAINING_OFFICIAL_URL_SHUTDOWN_TIMEOUT_MS = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_SHUTDOWN_TIMEOUT_MS',
  25_000,
);
export const TRAINING_OFFICIAL_URL_SNAPSHOT_PUT_TIMEOUT_MS =
  readBoundedPositiveInteger(
    'TRAINING_OFFICIAL_URL_SNAPSHOT_PUT_TIMEOUT_MS',
    60_000,
    5_000,
    120_000,
  );
export const TRAINING_OFFICIAL_URL_SNAPSHOT_LINK_WINDOW_MS = 60_000;
const requestedOrphanGraceMs = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS',
  5 * 60_000,
);
export const TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS = Math.max(
  requestedOrphanGraceMs,
  TRAINING_OFFICIAL_URL_SNAPSHOT_PUT_TIMEOUT_MS +
    TRAINING_OFFICIAL_URL_SNAPSHOT_LINK_WINDOW_MS +
    1,
);
export const TRAINING_OFFICIAL_URL_ORPHAN_BATCH_SIZE = readPositiveInteger(
  'TRAINING_OFFICIAL_URL_ORPHAN_BATCH_SIZE',
  25,
);
export const TRAINING_OFFICIAL_URL_ORPHAN_DELETE_TIMEOUT_MS =
  readBoundedPositiveInteger(
    'TRAINING_OFFICIAL_URL_ORPHAN_DELETE_TIMEOUT_MS',
    5_000,
    1_000,
    15_000,
  );
export const TRAINING_OFFICIAL_URL_ORPHAN_SWEEP_DEADLINE_MS =
  readBoundedPositiveInteger(
    'TRAINING_OFFICIAL_URL_ORPHAN_SWEEP_DEADLINE_MS',
    10_000,
    2_000,
    30_000,
  );
