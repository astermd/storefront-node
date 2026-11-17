import { DerivedAttribution } from '../../src/journey/derived-attribution';

function category(params: Record<string, string>, referrer: string | null): [string | null, string | null] {
  const derived = DerivedAttribution.from(params, referrer, null);
  return [derived.sourceCategory, derived.sourceDetail];
}

describe('DerivedAttribution', () => {
  it('prefers affiliate, then email, then social, then referral', () => {
    expect(category({ affiliate_id: '4412', utm_medium: 'email' }, 'https://news.example/')).toEqual(['affiliate', '4412']);
    expect(category({ utm_medium: 'newsletter', utm_campaign: 'spring-sale' }, 'https://news.example/')).toEqual(['email_campaign', 'spring-sale']);
    expect(category({ utm_medium: 'email', utm_source: 'mailer' }, null)).toEqual(['email_campaign', 'mailer']);
    expect(category({ utm_source: 'facebook' }, null)).toEqual(['social_media', 'facebook']);
    expect(category({}, 'https://blog.example/post/')).toEqual(['referral', 'https://blog.example/post/']);
    expect(category({}, null)).toEqual([null, null]);
    expect(category({}, '')).toEqual([null, null]);
  });

  it('tests tablet before mobile', () => {
    const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    expect(DerivedAttribution.from({}, null, ipad).deviceType).toBe('tablet');

    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    expect(DerivedAttribution.from({}, null, iphone).deviceType).toBe('mobile');
    expect(DerivedAttribution.from({}, null, iphone).os).toBe('iOS');

    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(DerivedAttribution.from({}, null, desktop).deviceType).toBe('desktop');
  });

  it('keeps browser detection order against impersonating user agents', () => {
    const edge = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0';
    expect(DerivedAttribution.from({}, null, edge).browser).toBe('Edge');

    const opera = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 OPR/106.0';
    expect(DerivedAttribution.from({}, null, opera).browser).toBe('Opera');

    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
    expect(DerivedAttribution.from({}, null, chrome).browser).toBe('Chrome');
    expect(DerivedAttribution.from({}, null, chrome).os).toBe('macOS');

    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
    expect(DerivedAttribution.from({}, null, safari).browser).toBe('Safari');
  });

  it('yields nulls for an empty user agent', () => {
    const derived = DerivedAttribution.from({}, null, null);
    expect(derived.deviceType).toBeNull();
    expect(derived.browser).toBeNull();
    expect(derived.os).toBeNull();
  });

  it('does not treat a referrer from our own host as a traffic source', () => {
    const derived = DerivedAttribution.from({}, 'http://127.0.0.1:8123/', null, '127.0.0.1');
    expect(derived.sourceCategory).toBeNull();
    expect(derived.sourceDetail).toBeNull();
  });

  it('decides self-referral by host alone, ignoring case, scheme, port and path', () => {
    expect(DerivedAttribution.from({}, 'https://Example.test/products/nad/', null, 'example.test').sourceCategory).toBeNull();
  });

  it('keeps an external or unparseable referrer as a source', () => {
    const external = DerivedAttribution.from({}, 'https://www.google.com/', null, 'example.test');
    expect(external.sourceCategory).toBe('referral');
    expect(external.sourceDetail).toBe('https://www.google.com/');

    expect(DerivedAttribution.from({}, 'not-a-url', null, 'example.test').sourceCategory).toBe('referral');
  });

  it('keeps every referrer as a source when no self host is known', () => {
    expect(DerivedAttribution.from({}, 'http://127.0.0.1:8123/', null, null).sourceCategory).toBe('referral');
  });
});
