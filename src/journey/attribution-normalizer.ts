import { CanonicalKeys } from './canonical-keys';

/** Maps raw query params onto canonical tracking keys; unknown or blank values are dropped. */
export class AttributionNormalizer {
  static normalize(params: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};

    for (const [canonical, aliases] of CanonicalKeys.aliases()) {
      for (const alias of aliases) {
        if (!Object.prototype.hasOwnProperty.call(params, alias)) continue;

        const raw = params[alias];
        if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;

        const value = String(raw).trim();
        if (value === '') continue;

        out[canonical] = value;
        break;
      }
    }

    return out;
  }
}
