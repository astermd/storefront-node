import { Attribution } from '../../src/journey/attribution';

describe('Attribution affiliate link', () => {
  it('reads a plain affid as the affiliate link and sends it top-level on session create', () => {
    const attribution = Attribution.capture({ affid: '6a906a42a002ad6ea5037d8e', utm_source: 'partner' }, {}, null);

    expect(attribution.affiliateLinkId).toBe('6a906a42a002ad6ea5037d8e');
    expect(attribution.emrSessionPayload()).toEqual({
      utm: { source: 'partner' },
      affiliate_link_id: '6a906a42a002ad6ea5037d8e',
    });
  });

  it('prefers the raw _amd token over a plain affid and forwards it still encrypted', () => {
    const attribution = Attribution.capture({ affid: '6a906a42a002ad6ea5037d8e' }, {}, null, null, null, 'q2EYh8sCg_P4t5-raw-token');

    expect(attribution.affiliateLinkId).toBe('q2EYh8sCg_P4t5-raw-token');
    expect(attribution.emrSessionPayload().affiliate_link_id).toBe('q2EYh8sCg_P4t5-raw-token');
  });

  it('keeps the token out of the normalised parameters but still counts it as a capture', () => {
    const attribution = Attribution.capture({}, {}, null, null, null, 'q2EYh8sCg_P4t5-raw-token');

    expect(attribution.params).toEqual({});
    expect(attribution.isEmpty()).toBe(false);
  });

  it('does not treat the other affiliate aliases as a link id', () => {
    const attribution = Attribution.capture({ aff_id: '4412', affiliate_id: '99' }, {}, null);

    expect(attribution.get('affiliate_id')).not.toBeNull();
    expect(attribution.affiliateLinkId).toBeNull();
    expect(attribution.emrSessionPayload()).not.toHaveProperty('affiliate_link_id');
  });

  it('reads a blank affid or token as no link', () => {
    expect(Attribution.capture({ affid: '  ' }, {}, null, null, null, '').affiliateLinkId).toBeNull();
  });

  it('survives the stored form, and a row stored before the field existed reads as no link', () => {
    const attribution = Attribution.capture({ affid: '6a906a42a002ad6ea5037d8e' }, {}, null);

    expect(Attribution.fromArray(attribution.toArray()).affiliateLinkId).toBe('6a906a42a002ad6ea5037d8e');
    expect(
      Attribution.fromArray({
        params: {},
        referrer: null,
        derived: { sourceCategory: null, sourceDetail: null, deviceType: null, browser: null, os: null },
      }).affiliateLinkId,
    ).toBeNull();
  });
});
