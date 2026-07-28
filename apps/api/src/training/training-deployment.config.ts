export type TrainingDeploymentEnvironment =
  | 'development'
  | 'test'
  | 'staging'
  | 'production';

export function readTrainingDeploymentEnvironment(
  env: NodeJS.ProcessEnv,
): TrainingDeploymentEnvironment {
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  const explicit = env.DEPLOYMENT_ENV?.trim().toLowerCase();
  const deployment =
    explicit ||
    (nodeEnv === 'production'
      ? 'production'
      : nodeEnv === 'test'
        ? 'test'
        : 'development');
  if (
    !['development', 'test', 'staging', 'production'].includes(deployment)
  ) {
    throw new Error(
      'DEPLOYMENT_ENV must be development, test, staging or production',
    );
  }
  if (
    (deployment === 'staging' || deployment === 'production') &&
    nodeEnv !== 'production'
  ) {
    throw new Error(
      'NODE_ENV=production is required for staging and production deployments',
    );
  }
  return deployment as TrainingDeploymentEnvironment;
}

export function allowStagingFakeProviders(env: NodeJS.ProcessEnv) {
  const value = env.STAGING_ALLOW_FAKE_PROVIDERS?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      'STAGING_ALLOW_FAKE_PROVIDERS must be "true" or "false"',
    );
  }
  return value === 'true';
}
