/**
 * Heuristics derived from the captured parameters, the landing referrer and the user agent.
 *
 * Two orderings here are deliberate and must not be "simplified": source-category matching is
 * first-match-wins down a fixed list (`[5.14]`), and device and browser classification test the
 * impersonators before the impersonated (`[5.15]`) — tablet before mobile because an iPad's user
 * agent also says `Mobile`, Edge and Opera before Chrome and Chrome before Safari because each
 * carries the earlier one's token. An empty user agent yields nulls, which callers omit rather than
 * sending as blanks.
 */
export interface DerivedValues {
  sourceCategory: string | null;
  sourceDetail: string | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
}

/** Tokens that identify social traffic in a UTM source or medium. */
const SOCIAL_TOKENS = [
  'facebook', 'instagram', 'twitter', 'x.com', 'linkedin', 'tiktok',
  'reddit', 'pinterest', 'snapchat', 'youtube', 'threads',
];

const TABLET_TOKENS = ['ipad', 'tablet', 'playbook', 'silk', 'kindle'];
const MOBILE_TOKENS = ['mobi', 'iphone', 'ipod', 'android', 'phone'];

// Order matters: each later entry's token appears in the earlier ones.
const BROWSERS: ReadonlyArray<readonly [string, string]> = [
  ['Edg', 'Edge'], ['OPR', 'Opera'], ['Opera', 'Opera'], ['Chrome', 'Chrome'], ['Firefox', 'Firefox'], ['Safari', 'Safari'],
];

// iOS before macOS: an iPhone's user agent also says "like Mac OS X".
const SYSTEMS: ReadonlyArray<readonly [string, string]> = [
  ['iPhone', 'iOS'], ['iPad', 'iOS'], ['iPod', 'iOS'], ['Android', 'Android'], ['Windows', 'Windows'],
  ['Mac OS X', 'macOS'], ['Macintosh', 'macOS'], ['Linux', 'Linux'],
];

export class DerivedAttribution {
  /** @param params canonical parameters (see `AttributionNormalizer`) */
  static from(params: Record<string, string>, referrer: string | null, userAgent: string | null, selfHost: string | null = null): DerivedValues {
    const [sourceCategory, sourceDetail] = DerivedAttribution.source(params, DerivedAttribution.externalReferrer(referrer, selfHost));

    return {
      sourceCategory,
      sourceDetail,
      deviceType: DerivedAttribution.device(userAgent),
      browser: DerivedAttribution.browser(userAgent),
      os: DerivedAttribution.os(userAgent),
    };
  }

  private static source(params: Record<string, string>, referrer: string | null): [string | null, string | null] {
    const affiliate = params.affiliate_id ?? '';
    if (affiliate !== '') {
      return ['affiliate', affiliate];
    }

    const medium = (params.utm_medium ?? '').toLowerCase();
    const utmSource = params.utm_source ?? '';
    if (medium === 'email' || medium === 'newsletter') {
      const detail = (params.utm_campaign ?? '') !== '' ? params.utm_campaign : utmSource;
      return ['email_campaign', detail === '' ? null : detail];
    }

    const haystack = `${utmSource} ${medium}`.toLowerCase();
    if (SOCIAL_TOKENS.some((token) => haystack.includes(token))) {
      return ['social_media', utmSource === '' ? null : utmSource];
    }

    if (referrer !== null && referrer !== '') {
      return ['referral', referrer];
    }

    return [null, null];
  }

  /**
   * The referrer, unless it is this storefront referring to itself.
   *
   * A visitor moving from one page of ours to another sends a `Referer` naming our own host, and
   * treating that as a traffic source records the site as its own referral. Under `[5.12]`'s
   * first-touch rule that is worse than noise: one internally-referred capture can pin a journey's
   * attribution to the storefront itself for its whole life.
   *
   * Only the derived source is affected; the raw referrer is still stored verbatim. A referrer we
   * cannot parse a host out of is left alone: it is not evidence of a same-origin visit, and
   * dropping it would lose a real external source to a malformed header.
   */
  private static externalReferrer(referrer: string | null, selfHost: string | null): string | null {
    if (referrer === null || referrer === '' || selfHost === null || selfHost === '') {
      return referrer;
    }

    let host: string;
    try {
      host = new URL(referrer).hostname;
    } catch {
      return referrer;
    }
    if (host === '') return referrer;

    return host.toLowerCase() === selfHost.toLowerCase() ? null : referrer;
  }

  private static device(userAgent: string | null): string | null {
    if (userAgent === null || userAgent === '') return null;

    const agent = userAgent.toLowerCase();
    if (TABLET_TOKENS.some((token) => agent.includes(token))) return 'tablet';
    if (MOBILE_TOKENS.some((token) => agent.includes(token))) return 'mobile';
    return 'desktop';
  }

  private static browser(userAgent: string | null): string | null {
    if (userAgent === null || userAgent === '') return null;
    return BROWSERS.find(([token]) => userAgent.includes(token))?.[1] ?? null;
  }

  private static os(userAgent: string | null): string | null {
    if (userAgent === null || userAgent === '') return null;
    return SYSTEMS.find(([token]) => userAgent.includes(token))?.[1] ?? null;
  }
}
