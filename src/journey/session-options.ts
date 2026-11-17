import { Injectable } from '@nestjs/common';
import { ConfigService } from '../support/config';

/**
 * The session and attribution
 * settings, read from config once and passed as one value instead of several constructor
 * arguments.
 *
 * `trackingKeys`: `_amd` decryption keys, current first, blanks skipped.
 */
@Injectable()
export class SessionOptions {
  readonly cookieName: string;
  readonly resumeParam: string;
  readonly payloadParam: string;
  readonly lifetimeDays: number;
  readonly excludePaths: string[];
  readonly trackingKeys: string[];

  constructor(config: ConfigService) {
    this.cookieName = config.app.session.cookie;
    this.resumeParam = config.app.session.resumeParam;
    this.payloadParam = config.app.attribution.payloadParam;
    this.lifetimeDays = config.app.session.lifetimeDays;
    this.excludePaths = config.app.session.excludePaths;
    this.trackingKeys = [config.app.attribution.key, config.app.attribution.previousKey]
      .map((key) => (key ?? '').trim())
      .filter((key) => key !== '');
  }
}
