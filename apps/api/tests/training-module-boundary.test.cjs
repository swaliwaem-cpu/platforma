require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { Inject, Injectable, Module } = require('@nestjs/common');
const { ApplicationConfig } = require('@nestjs/core/application-config');
const { NestContainer } = require('@nestjs/core/injector/container');
const { Injector } = require('@nestjs/core/injector/injector');
const { GraphInspector } = require('@nestjs/core/inspector/graph-inspector');
const { MetadataScanner } = require('@nestjs/core/metadata-scanner');
const { DependenciesScanner } = require('@nestjs/core/scanner');

const {
  TRAINING_MODULE_ENABLED_ENV,
  TrainingConfigService,
} = require('../dist/training/training.config.js');
const { TrainingModule } = require('../dist/training/training.module.js');

class ExternalTrainingConfigProbe {
  constructor(config) {
    this.config = config;
  }

  getConfig() {
    return this.config.getConfig();
  }
}

Inject(TrainingConfigService)(ExternalTrainingConfigProbe, undefined, 0);
Injectable()(ExternalTrainingConfigProbe);

class TrainingModuleConsumer {}

Module({
  imports: [TrainingModule],
  providers: [ExternalTrainingConfigProbe],
})(TrainingModuleConsumer);

test('an external Nest module resolves the training configuration contract', async () => {
  const previousValue = process.env[TRAINING_MODULE_ENABLED_ENV];
  process.env[TRAINING_MODULE_ENABLED_ENV] = 'true';

  const applicationConfig = new ApplicationConfig();
  const container = new NestContainer(applicationConfig);
  const scanner = new DependenciesScanner(
    container,
    new MetadataScanner(),
    new GraphInspector(container),
    applicationConfig,
  );

  try {
    await scanner.scan(TrainingModuleConsumer);
    const consumerModule = [...container.getModules().values()].find(
      (candidate) => candidate.metatype === TrainingModuleConsumer,
    );
    assert.ok(consumerModule, 'Nest did not register the consumer module');

    const probe = consumerModule.providers.get(ExternalTrainingConfigProbe);
    assert.ok(probe, 'Nest did not register the external config probe');

    await new Injector().loadProvider(probe, consumerModule);
    assert.ok(probe.instance instanceof ExternalTrainingConfigProbe);
    assert.ok(probe.instance.config instanceof TrainingConfigService);
    assert.deepEqual(probe.instance.getConfig(), {
      enabled: true,
      status: 'enabled',
    });
  } finally {
    container.clear();
    if (previousValue === undefined) {
      delete process.env[TRAINING_MODULE_ENABLED_ENV];
    } else {
      process.env[TRAINING_MODULE_ENABLED_ENV] = previousValue;
    }
  }
});
