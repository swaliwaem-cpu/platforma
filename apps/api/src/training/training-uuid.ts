const UUID_V1_TO_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V1_TO_V8_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isTrainingUuid(
  value: unknown,
  maximumVersion: 5 | 8 = 5,
): value is string {
  return (
    typeof value === 'string' &&
    (maximumVersion === 8
      ? UUID_V1_TO_V8_PATTERN
      : UUID_V1_TO_V5_PATTERN
    ).test(value)
  );
}
