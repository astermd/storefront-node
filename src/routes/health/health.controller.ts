import { Controller, Get, HttpCode } from '@nestjs/common';
import { ConfigService } from '../../support/config';

/**
 * The health route, still reduced: the persistence/config/storage checks it will grow (config,
 * DB, storage, form cache -> 503 if any false) land alongside their owning phases.
 *
 * `info` shows whether the tracking keys are set, never the keys themselves.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @HttpCode(200)
  check() {
    return {
      checks: {},
      info: {
        analytics_sessions: this.config.app.session.analytics === true,
        attribution_key: HealthController.presence(this.config.app.attribution.key),
        attribution_previous_key: HealthController.presence(this.config.app.attribution.previousKey),
      },
    };
  }

  private static presence(value: unknown): 'configured' | 'missing' {
    return typeof value === 'string' && value.trim() !== '' ? 'configured' : 'missing';
  }
}
