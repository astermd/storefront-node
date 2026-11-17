import { Controller, Get, HttpCode } from '@nestjs/common';
import { ConfigService } from '../../support/config';

/**
 * The health route, still reduced: the persistence/config/storage checks it will grow (config,
 * DB, storage, form cache -> 503 if any false) land alongside their owning phases.
 *
 * `info` carries configuration facts an operator needs but that do not make this instance
 * unhealthy. The tracking keys are reported by presence only — a key never appears in a response.
 * A missing `attribution_key` is otherwise visible only as `amd_decrypt_failed` in the log, once
 * per affiliate landing.
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
