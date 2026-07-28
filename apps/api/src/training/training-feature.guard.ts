import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
} from '@nestjs/common';

import { TrainingConfigService } from './training.config';

@Injectable()
export class TrainingFeatureGuard implements CanActivate {
  private readonly config: TrainingConfigService;

  constructor(@Optional() config?: TrainingConfigService) {
    this.config = config ?? new TrainingConfigService();
  }

  canActivate(_context: ExecutionContext) {
    this.config.assertEnabled();
    return true;
  }
}
