function createSafeTrainingTestEnvironment(parentEnvironment) {
  const environment = {
    ...parentEnvironment,
    NODE_ENV: 'test',
    OPENAI_PROVIDER_MODE: 'fake',
    OPENAI_SMOKE_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'fake',
  };
  delete environment.OPENAI_API_KEY;
  return environment;
}

module.exports = {
  createSafeTrainingTestEnvironment,
};
