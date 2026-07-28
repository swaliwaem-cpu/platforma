import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { TrainingModuleConfigResponse } from '@platforma/shared' with { 'resolution-mode': 'import' };

export const TRAINING_MODULE_ENABLED_ENV = 'TRAINING_MODULE_ENABLED';

export function parseTrainingModuleEnabled(value: string | undefined) {
  if (value === undefined || value.trim() === '') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  throw new Error(`${TRAINING_MODULE_ENABLED_ENV} must be "true" or "false"`);
}

@Injectable()
export class TrainingConfigService {
  isEnabled() {
    return parseTrainingModuleEnabled(
      process.env[TRAINING_MODULE_ENABLED_ENV],
    );
  }

  assertEnabled() {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException({
        code: 'TRAINING_DISABLED',
        message: 'Training module is temporarily disabled',
      });
    }
  }

  getConfig(): TrainingModuleConfigResponse {
    const enabled = this.isEnabled();
    return {
      enabled,
      status: enabled ? 'enabled' : 'disabled',
    };
  }
}

export class TrainingFeatureDisabledAfterClaimError extends Error {
  constructor() {
    super('Training module was disabled after the job was claimed');
    this.name = 'TrainingFeatureDisabledAfterClaimError';
  }
}
