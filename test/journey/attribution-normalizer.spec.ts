import { Attribution } from '../../src/journey/attribution';
import { AttributionNormalizer } from '../../src/journey/attribution-normalizer';
import { CanonicalKeys } from '../../src/journey/canonical-keys';

describe('AttributionNormalizer', () => {
  it('maps vendor aliases onto canonical keys and drops unknown parameters', () => {
    const normalized = AttributionNormalizer.normalize({
      aff_id: '4412',
      nid: '77',
      gclid: 'Cj0KEQ',
      utm_medium: 'cpc',
      unknown_param: 'ignored',
    });

    expect(normalized.affiliate_id).toBe('4412');
    expect(normalized.network_id).toBe('77');
    expect(normalized.gclid).toBe('Cj0KEQ');
    expect(normalized.utm_medium).toBe('cpc');
    expect(normalized).not.toHaveProperty('unknown_param');
  });

  it('lets the first alias present win, and matches aliases case-sensitively', () => {
    expect(AttributionNormalizer.normalize({ aff_id: 'second', affiliate_id: 'first' }).affiliate_id).toBe('first');
    expect(AttributionNormalizer.normalize({ AFF_ID: '4412' })).toEqual({});
  });

  it('lets one raw parameter feed two canonical keys', () => {
    const normalized = AttributionNormalizer.normalize({ utm_source: 'newsletter', sub1: 'creativeA' });

    expect(normalized.utm_source).toBe('newsletter');
    expect(normalized.source_id).toBe('newsletter');
    expect(normalized.c1).toBe('creativeA');
    expect(normalized.sub_affiliate_id).toBe('creativeA');
  });

  it('accepts provider slot names inbound', () => {
    const normalized = AttributionNormalizer.normalize({ tracking3: 'x', sourceValue2: 'y' });
    expect(normalized.c3).toBe('x');
    expect(normalized.c2).toBe('y');
  });

  it('drops empty, blank and non-scalar values', () => {
    expect(AttributionNormalizer.normalize({ aff_id: '', nid: '   ', c1: ['array'], gclid: 'kept' })).toEqual({ gclid: 'kept' });
  });

  it('supports custom sub-identifiers through c19', () => {
    const normalized = AttributionNormalizer.normalize({ c19: 'nineteen', sub14: 'fourteen' });
    expect(normalized.c19).toBe('nineteen');
    expect(normalized.c14).toBe('fourteen');
    expect(CanonicalKeys.all()).toContain('c19');
  });
});

describe('Attribution.capture', () => {
  it('stores canonical params only and fills the derived values', () => {
    const attribution = Attribution.capture(
      { aff: '4412', amd_session: '11111111-1111-4111-8111-111111111111', _amd: 'token' },
      {},
      'https://news.example/',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'shop.example',
    );

    expect(attribution.params).toEqual({ affiliate_id: '4412' });
    expect(attribution.derived).toEqual({
      sourceCategory: 'affiliate',
      sourceDetail: '4412',
      deviceType: 'mobile',
      browser: null,
      os: 'iOS',
    });
  });

  it('lets an encrypted value beat a plain one after normalisation, and drives derivation with it', () => {
    const attribution = Attribution.capture({ aff_id: 'plain', utm_medium: 'cpc' }, { affiliate_id: 'encrypted' }, null);

    expect(attribution.get('affiliate_id')).toBe('encrypted');
    expect(attribution.get('utm_medium')).toBe('cpc');
    expect(attribution.derived.sourceDetail).toBe('encrypted');
  });
});
