import { AttributionNormalizer } from './attribution-normalizer';
import { DerivedAttribution as Derive, DerivedValues } from './derived-attribution';

/**
 * The attribution captured for one journey: canonical parameters, the landing referrer, the
 * values derived from them, and the affiliate link the visitor arrived on.
 *
 * Immutable by construction — attribution is captured once on first touch and never overwritten
 * for the life of the journey (`[5.12]`); `firstTouch()` keys off the existence of an existing
 * instance, not its emptiness, so an empty landing referrer still counts as a capture (`[5.13]`).
 *
 * The affiliate link is the one value that is not decrypted here. The sales service resolves a
 * link to its owning affiliate itself and accepts either the plain link id or the raw `_amd`
 * token, so the token is forwarded exactly as it arrived. A marketing token decrypts to an object
 * carrying the link id beside a `data` list, and `AmdPayload` reads only a bare list, so the link
 * id cannot be recovered from the token here. It is kept apart from `params` because it is not a
 * tracking parameter, and keeping the token out of the normalised bag is what `[5.4]` asks for.
 */
export type DerivedAttribution = DerivedValues;

export interface AttributionData {
  params: Record<string, string>;
  referrer: string | null;
  derived: DerivedAttribution;
  /** Absent on rows stored before the affiliate link was captured. */
  affiliateLinkId?: string | null;
}

const EMPTY_DERIVED: DerivedAttribution = {
  sourceCategory: null,
  sourceDetail: null,
  deviceType: null,
  browser: null,
  os: null,
};

export class Attribution {
  private constructor(
    readonly params: Readonly<Record<string, string>>,
    readonly referrer: string | null,
    readonly derived: Readonly<DerivedAttribution>,
    readonly affiliateLinkId: string | null = null,
  ) {}

  /**
   * @param encryptedParams the decoded `_amd` payload, or `{}`
   * @param amdToken the raw `_amd` value exactly as it arrived, still encrypted
   */
  static capture(
    plainQuery: Record<string, unknown>,
    encryptedParams: Record<string, unknown>,
    referrer: string | null,
    userAgent: string | null = null,
    selfHost: string | null = null,
    amdToken: string | null = null,
  ): Attribution {
    // Encrypted values win over plain ones.
    const params = { ...AttributionNormalizer.normalize(plainQuery), ...AttributionNormalizer.normalize(encryptedParams) };
    const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const trimmedReferrer = referrer === null ? null : referrer.trim();

    return new Attribution(
      sorted,
      trimmedReferrer,
      Derive.from(sorted, trimmedReferrer, userAgent, selfHost),
      Attribution.affiliateLinkIdFrom(amdToken, plainQuery),
    );
  }

  /**
   * The token beats a plain `affid` beside it: the token is the form an affiliate link is issued
   * in, and the one the sales service resolves the owning affiliate from. Only `affid` names a
   * link; the other affiliate aliases carry a network's own affiliate identifier, which is not a
   * link id and stays in `params` as `affiliate_id`.
   */
  private static affiliateLinkIdFrom(amdToken: string | null, plainQuery: Record<string, unknown>): string | null {
    for (const candidate of [amdToken, plainQuery.affid]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
    }

    return null;
  }

  /** Whatever was captured first stands (`[5.12]`, `[5.13]`). */
  static firstTouch(existing: Attribution | null, incoming: Attribution): Attribution {
    return existing ?? incoming;
  }

  get(key: string): string | null {
    return this.params[key] ?? null;
  }

  isEmpty(): boolean {
    return (
      Object.keys(this.params).length === 0 &&
      this.affiliateLinkId === null &&
      (this.referrer === null || this.referrer === '')
    );
  }

  toArray(): AttributionData {
    return {
      params: { ...this.params },
      referrer: this.referrer,
      derived: { ...this.derived },
      affiliateLinkId: this.affiliateLinkId,
    };
  }

  static fromArray(data: AttributionData): Attribution {
    const link = typeof data.affiliateLinkId === 'string' && data.affiliateLinkId !== '' ? data.affiliateLinkId : null;

    return new Attribution(data.params ?? {}, data.referrer ?? null, { ...EMPTY_DERIVED, ...data.derived }, link);
  }

  /**
   * The attribution the EMR session-creation call carries (`[4.4]`): the landing referrer, the
   * UTM triple and the affiliate link. Channel binding and geo are derived server-side by the EMR
   * and deliberately not sent.
   */
  emrSessionPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};

    if (this.referrer) {
      payload.referrer = this.referrer;
    }

    const utm = Object.fromEntries(
      (['source', 'medium', 'campaign'] as const)
        .map((key) => [key, this.get(`utm_${key}`)] as const)
        .filter(([, value]) => value !== null),
    );
    if (Object.keys(utm).length > 0) {
      payload.utm = utm;
    }

    if (this.affiliateLinkId !== null) {
      payload.affiliate_link_id = this.affiliateLinkId;
    }

    return payload;
  }
}
