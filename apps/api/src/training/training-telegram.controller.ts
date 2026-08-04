import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  PayloadTooLargeException,
  Post,
} from '@nestjs/common';

import { TrainingTelegramService } from './training-telegram.service';
import { isTrainingModuleEnabled } from './training-runtime-config';

@Controller('training/telegram')
export class TrainingTelegramController {
  private readonly logger = new Logger(TrainingTelegramController.name);

  constructor(private readonly telegram: TrainingTelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Body() body: unknown,
  ) {
    if (!isTrainingModuleEnabled()) return { ok: true, disabled: true };

    this.telegram.assertWebhookSecret(secret);

    const declaredLength = Number(contentLength);
    const actualLength = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');

    if (
      (Number.isFinite(declaredLength) && declaredLength > this.telegram.maxUpdateBytes) ||
      actualLength > this.telegram.maxUpdateBytes
    ) {
      throw new PayloadTooLargeException('Telegram update is too large');
    }

    const startedAt = Date.now();
    const deliveries = await this.telegram.handleWebhookUpdate(body);
    const durationMs = Date.now() - startedAt;

    if (durationMs >= 1_000) {
      this.logger.warn({
        event: 'training_telegram_webhook_slow',
        durationMs,
      });
    }
    this.telegram.dispatchWebhookDeliveries(deliveries);
    return { ok: true };
  }
}
