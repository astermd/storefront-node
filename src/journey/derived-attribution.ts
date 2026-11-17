/** Derives source, device, browser and OS. Match lists are first-match-wins; keep their order. */
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

  /** Ignores a referrer from our own host, so the site isn't credited as its own source. */
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
