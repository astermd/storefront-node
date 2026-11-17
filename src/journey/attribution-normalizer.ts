import { CanonicalKeys } from './canonical-keys';

/**
 * Reduces a raw parameter bag to canonical tracking keys.
 *
 * Pure and total: unrecognised parameters are dropped rather than carried along, and a value that
 * is absent, blank after trimming, or not a scalar is treated as not present at all — so a link
 * carrying `?aff_id=` never shadows a real affiliate id arriving under another alias.
 */
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
