import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export class AssistantRuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantRuntimeConfigError';
  }
}

export function isAssistantModuleEnabled(
  environment: AssistantEnvironment = process.env,
) {
  const raw = environment.ASSISTANT_MODULE_ENABLED;

  if (raw === undefined || raw.trim() === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new AssistantRuntimeConfigError('ASSISTANT_MODULE_ENABLED_INVALID');
}

@Injectable()
export class AssistantFeatureGuard implements CanActivate {
  canActivate() {
    if (isAssistantModuleEnabled()) return true;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'ASSISTANT_MODULE_DISABLED',
    });
  }
}
