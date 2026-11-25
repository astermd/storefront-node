import { QueryParamCipher } from '@astermd-hq/sdk';
import type { Request } from 'express';
import { SessionGateway, SessionViewResult } from '../../src/emr/session-gateway';
import { JourneyState } from '../../src/journey/journey-state';
import { JourneyStore } from '../../src/journey/journey-store';
import { SessionOptions } from '../../src/journey/session-options';
import { SessionResolver } from '../../src/journey/session-resolver';
import { EventRepository } from '../../src/repository/event-repository';
import { SessionRepository, SessionRow } from '../../src/repository/session-repository';
import { OperatorLog } from '../../src/support/operator-log';

/** Covers the `?amd_session=<uuid>` resume link. */

const RESUMED = '11111111-1111-4111-8111-111111111111';
const COOKIE = '22222222-2222-4222-8222-222222222222';
const MINTED = '33333333-3333-4333-8333-333333333333';
const TRACKING_KEY = '00112233445566778899aabbccddeeff';

class InMemorySessions {
  rows = new Map<string, SessionRow>();

  async find(uuid: string): Promise<SessionRow | null> {
    return this.rows.get(uuid) ?? null;
  }

  async insert(
    uuid: string,
    journeyState: SessionRow['journeyState'],
    attribution: SessionRow['attribution'] = null,
    opportunityId: string | null = null,
  ): Promise<string> {
    const updatedAt = new Date().toISOString();
    if (!this.rows.has(uuid)) {
      this.rows.set(uuid, { journeyState, attribution, opportunityId, updatedAt });
    }
    return this.rows.get(uuid)!.updatedAt;
  }
}

class RecordingEvents {
  appended: Array<{ uuid: string; name: string; payload: Record<string, unknown> }> = [];

  async append(uuid: string, name: string, payload: Record<string, unknown> = {}): Promise<void> {
    this.appended.push({ uuid, name, payload });
  }

  names(): string[] {
    return this.appended.map((e) => e.name);
  }
}

class StubGateway implements SessionGateway {
  views: string[] = [];
  creates = 0;
  createPayloads: Array<Record<string, unknown>> = [];

  constructor(
    private readonly known: Record<string, SessionViewResult> = {},
    private readonly mintUuid: string | null = MINTED,
    private readonly failingViews: string[] = [],
  ) {}

  async create(data: Record<string, unknown>): Promise<string | null> {
    this.creates += 1;
    this.createPayloads.push(data);
    return this.mintUuid;
  }

  async view(uuid: string): Promise<SessionViewResult | null> {
    this.views.push(uuid);
    if (this.failingViews.includes(uuid)) return null;
    return this.known[uuid] ?? { exists: false, opportunityId: null, events: [] };
  }
}

function request(query: Record<string, unknown>, cookies: Record<string, string> = {}): Request {
  return { query, cookies, path: '/', ip: '127.0.0.1', get: () => undefined } as unknown as Request;
}

function setup(known: Record<string, SessionViewResult> = {}, mintUuid: string | null = MINTED, failingViews: string[] = []) {
  const sessions = new InMemorySessions();
  const events = new RecordingEvents();
  const gateway = new StubGateway(known, mintUuid, failingViews);
  const log = { info: jest.fn(), warning: jest.fn(), error: jest.fn() } as unknown as OperatorLog;
  const options = {
    cookieName: 'amd_session',
    resumeParam: 'amd_session',
    payloadParam: '_amd',
    trackingKeys: [TRACKING_KEY],
  } as SessionOptions;
  const resolver = new SessionResolver(
    gateway,
    sessions as unknown as SessionRepository,
    events as unknown as EventRepository,
    log,
    options,
  );
  const journey = () => new JourneyStore(sessions as unknown as SessionRepository);

  return { sessions, events, gateway, log, resolver, journey };
}

describe('SessionResolver resume link', () => {
  it('restores a stored journey, including intake answers, and re-issues the cookie', async () => {
    const { sessions, events, gateway, resolver, journey } = setup();
    sessions.rows.set(RESUMED, {
      journeyState: { reconciled: true, readModelShape: SessionResolver.READ_MODEL_SHAPE, answers: { tf_1: { weight: '80' } } },
      attribution: null,
      opportunityId: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const store = journey();

    const resolution = await resolver.resolve(request({ amd_session: RESUMED }), store, true);

    expect(resolution.sessionUuid).toBe(RESUMED);
    expect(resolution.issueCookie).toBe(true);
    expect(store.currentState()?.answers).toEqual({ tf_1: { weight: '80' } });
    expect(gateway.views).toEqual([]); // already reconciled: no EMR read
    expect(gateway.creates).toBe(0);
    expect(events.names()).toEqual(['session_adopted', 'access.journey_resumed']);
    expect(events.appended[1].payload).toEqual({ actor: 'resume_link', reason: 'journey_resumed', restored_intake: true, teleforms: 1 });
  });

  it('beats a cookie for a different session', async () => {
    const { resolver, journey } = setup({ [RESUMED]: { exists: true, opportunityId: 'opp_9', events: ['cart_initiated'] } });
    const store = journey();

    const resolution = await resolver.resolve(request({ amd_session: RESUMED }, { amd_session: COOKIE }), store, true);

    expect(resolution.sessionUuid).toBe(RESUMED);
    expect(resolution.issueCookie).toBe(true);
    const state = store.currentState()!;
    expect(state.opportunityId).toBe('opp_9');
    expect(state.emrEvents).toEqual(['cart_initiated']);
    expect(state.reconciled).toBe(true);
    expect(state.readModelShape).toBe(SessionResolver.READ_MODEL_SHAPE);
  });

  it('adopts a session this storefront has never stored when the EMR knows it', async () => {
    const { sessions, resolver, journey } = setup({ [RESUMED]: { exists: true, opportunityId: null, events: [] } });

    const resolution = await resolver.resolve(request({ amd_session: RESUMED }), journey(), false);

    expect(resolution.sessionUuid).toBe(RESUMED);
    expect(sessions.rows.has(RESUMED)).toBe(true);
  });

  it('ignores a session the EMR does not know, records the rejection, and mints as usual', async () => {
    const { sessions, events, resolver, journey } = setup();

    const resolution = await resolver.resolve(request({ amd_session: RESUMED }), journey(), true);

    expect(resolution.sessionUuid).toBe(MINTED);
    expect(sessions.rows.has(RESUMED)).toBe(false);
    expect(events.appended).toEqual([
      { uuid: MINTED, name: 'session_created', payload: { source_category: null } },
      { uuid: MINTED, name: 'session_resume_rejected', payload: { rejected: RESUMED } },
    ]);
  });

  it('falls back to the cookie when the link is rejected', async () => {
    // The EMR knows the cookie's session, so the fallback keeps it rather than re-minting.
    const { events, resolver, journey } = setup({ [COOKIE]: { exists: true, opportunityId: null, events: [] } });

    const resolution = await resolver.resolve(request({ amd_session: RESUMED }, { amd_session: COOKIE }), journey(), true);

    expect(resolution.sessionUuid).toBe(COOKIE);
    expect(resolution.issueCookie).toBe(false);
    expect(events.appended).toEqual([]);
  });

  it('stores a freshly minted session, so a later resume link finds its journey', async () => {
    const { sessions, events, resolver, journey } = setup({ [MINTED]: { exists: true, opportunityId: null, events: [] } });

    const resolution = await resolver.resolve(request({}), journey(), true);

    expect(resolution.sessionUuid).toBe(MINTED);
    expect(sessions.rows.get(MINTED)?.journeyState).toMatchObject({ reconciled: true });
    expect(events.appended).toEqual([{ uuid: MINTED, name: 'session_created', payload: { source_category: null } }]);

    sessions.rows.get(MINTED)!.journeyState.answers = { tf_1: { weight: '80' } };
    const store = journey();
    const resumed = await resolver.resolve(
      request({ amd_session: MINTED }),
      store,
      true,
    );

    expect(resumed.sessionUuid).toBe(MINTED);
    expect(events.names()).toContain('session_adopted');
    expect(store.currentState()?.answersFor('tf_1')).toEqual({ weight: '80' });
  });

  it('records the source category of a freshly minted session', async () => {
    const { events, resolver, journey } = setup();

    await resolver.resolve(request({ utm_source: 'facebook', utm_medium: 'paid' }), journey(), true);

    expect(events.appended).toEqual([{ uuid: MINTED, name: 'session_created', payload: { source_category: 'social_media' } }]);
  });

  it('lets an encrypted _amd payload beat plain parameters and keeps the token out of them', async () => {
    const { log, resolver, journey } = setup();
    const token = QueryParamCipher.encrypt({ aff_id: 'encrypted' }, TRACKING_KEY);
    const store = journey();

    await resolver.resolve(request({ aff_id: 'plain', _amd: token }), store, true);

    const attribution = store.currentState()?.attribution;
    expect(attribution?.get('affiliate_id')).toBe('encrypted');
    expect(attribution?.derived.sourceCategory).toBe('affiliate');
    // [5.4]: the wrapper never becomes a tracking parameter; it is kept only as the affiliate link.
    expect(JSON.stringify(attribution?.params)).not.toContain(token);
    expect(attribution?.affiliateLinkId).toBe(token);
    expect(log.warning).not.toHaveBeenCalled();
  });

  it('sends a landing affid to the session create as the affiliate link', async () => {
    const { sessions, gateway, resolver, journey } = setup();
    const store = journey();

    await resolver.resolve(request({ affid: '6a906a42a002ad6ea5037d8e', utm_source: 'partner' }), store, true);

    expect(gateway.createPayloads[0].affiliate_link_id).toBe('6a906a42a002ad6ea5037d8e');
    expect(gateway.createPayloads[0].utm).toEqual({ source: 'partner' });
    expect(sessions.rows.get(MINTED)?.attribution).toMatchObject({ affiliateLinkId: '6a906a42a002ad6ea5037d8e' });
    expect(store.currentState()?.attribution?.affiliateLinkId).toBe('6a906a42a002ad6ea5037d8e');
  });

  it('sends the raw _amd token instead of a plain affid, even when it cannot be read here', async () => {
    const { gateway, resolver, journey } = setup();

    await resolver.resolve(request({ affid: '6a906a42a002ad6ea5037d8e', _amd: 'q2EYh8sCg_P4t5-unreadable-here' }), journey(), true);

    expect(gateway.createPayloads[0].affiliate_link_id).toBe('q2EYh8sCg_P4t5-unreadable-here');
  });

  it('never lets a later affiliate link replace the first touch', async () => {
    const { sessions, gateway, resolver, journey } = setup();
    sessions.rows.set(COOKIE, {
      journeyState: { reconciled: true, readModelShape: SessionResolver.READ_MODEL_SHAPE },
      attribution: {
        params: {},
        referrer: null,
        derived: { sourceCategory: null, sourceDetail: null, deviceType: null, browser: null, os: null },
        affiliateLinkId: '6a906a42a002ad6ea5037d8e',
      },
      opportunityId: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const store = journey();

    await resolver.resolve(request({ affid: '6a906a42a002ad6ea5037d8f' }, { amd_session: COOKIE }), store, true);

    expect(gateway.creates).toBe(0);
    expect(store.currentState()?.attribution?.affiliateLinkId).toBe('6a906a42a002ad6ea5037d8e');
  });

  it('falls back to plain parameters and logs when _amd cannot be decrypted', async () => {
    const { log, resolver, journey } = setup();
    const store = journey();

    await resolver.resolve(request({ aff_id: 'plain', _amd: 'tampered-garbage' }), store, true);

    expect(store.currentState()?.attribution?.get('affiliate_id')).toBe('plain');
    expect(log.warning).toHaveBeenCalledWith('amd_decrypt_failed', { keys_tried: 1 });
  });

  it.each([['../etc/passwd'], ['short'], [[RESUMED, RESUMED]]])('silently ignores a malformed value %p', async (value) => {
    const { events, gateway, resolver, journey } = setup();

    const resolution = await resolver.resolve(request({ amd_session: value }), journey(), true);

    expect(resolution.sessionUuid).toBe(MINTED);
    expect(gateway.views).toEqual([]);
    expect(events.names()).toEqual(['session_created']);
  });
});

describe('SessionResolver remint', () => {
  const STALE = '44444444-4444-4444-8444-444444444444';
  const KNOWN = '55555555-5555-4555-8555-555555555555';
  const ATTRIBUTION = { params: { affiliate_id: '4412' }, referrer: null, derived: { sourceCategory: 'affiliate', sourceDetail: '4412', deviceType: null, browser: null, os: null } };
  const CART = { lines: [{ slug: 'semaglutide', quantity: 1 }], territory: 'CA' } as never;
  const ANSWERS = { 'tf-weight-loss': { weight: '80' } };
  const BUYER = { email: 'buyer@example.test', first_name: 'Ada' };
  const PROMOTION = { code: 'SPRING', discount_cents: 500 };
  const CONSENTS = [{ key: 'telehealth', granted: true, copy_version: 'v1', copy_shown: 'I agree', at: '2026-08-25T10:00:00Z' }];
  const VERDICT = { status: 'verified', at: '2026-08-25T09:59:00Z', basis: 'idology', check: 'id', reference: 'ref-1' } as never;
  const RECEIPT = { order: '34788' };

  /**
   * Every durable field, each with a value distinguishable from its default — so a field that was
   * dropped cannot pass for one that was carried.
   */
  const EVERY_DURABLE_FIELD = {
    opportunityId: 'opp-1',
    attribution: ATTRIBUTION,
    reconciled: false,
    readModelShape: SessionResolver.READ_MODEL_SHAPE,
    sessionRetired: true,
    cart: CART,
    cartMirrored: true,
    furthestStep: 'receipt',
    formStatus: { 'tf-weight-loss': 'completed' },
    disqualifiedRule: 'bmi_low_hard_stop_notice',
    disqualifiedTeleform: 'tf-weight-loss',
    verification: VERDICT,
    placedOrders: ['34788'],
    paymentSummary: { method: 'card', last4: '4242' },
    identityDocument: 'uploads/id-front.jpg',
    answers: ANSWERS,
    emrEvents: ['intake_initiated'],
    buyer: BUYER,
    promotion: PROMOTION,
    promotionQuotedAgainst: 'digest-1',
    acceptedBumps: ['anti-nausea-kit'],
    consents: CONSENTS,
    pendingPayment: { reference: 'pi_1', idempotency_key: 'key-1', claimed_at: '2026-08-25T10:00:00Z' },
    reusableCredentialData: { kind: 'stripe', handle: { customer: 'cus_1' } },
    upsellQueue: ['sleep-support'],
    upsellCursor: 1,
    upsellOutcomes: { 'sleep-support': 'declined' },
    upsellQuotes: { 'sleep-support': 1900 },
    receipt: RECEIPT,
    completedAt: '2026-08-25T10:01:00+00:00',
  };

  function seedStale(sessions: InMemorySessions, attribution: unknown = ATTRIBUTION): void {
    sessions.rows.set(STALE, {
      journeyState: EVERY_DURABLE_FIELD as never,
      attribution: attribution as never,
      opportunityId: 'opp-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('discards a cookie the EMR does not recognise and re-mints, carrying the journey', async () => {
    const { sessions, events, resolver, journey } = setup();
    seedStale(sessions);
    const store = journey();

    const resolution = await resolver.resolve(request({}, { amd_session: STALE }), store, true);

    expect(resolution.sessionUuid).toBe(MINTED);
    expect(resolution.issueCookie).toBe(true);
    expect(store.sessionUuid()).toBe(MINTED);
    const row = sessions.rows.get(MINTED)!;
    expect(row.opportunityId).toBe('opp-1');
    expect((row.attribution as { params: Record<string, string> }).params.affiliate_id).toBe('4412');
    expect(events.appended).toContainEqual({ uuid: MINTED, name: 'session_reminted', payload: { replaced: STALE } });
  });

  it('makes a deliberate decision for every durable field', async () => {
    const { sessions, resolver, journey } = setup();
    seedStale(sessions);

    // The seed is the enumeration's other half: it must name every field.
    expect(Object.keys(EVERY_DURABLE_FIELD).sort()).toEqual(Object.keys(new JourneyState().toArray()).sort());

    await resolver.resolve(request({}, { amd_session: STALE }), journey(), true);

    expect(sessions.rows.get(MINTED)!.journeyState).toEqual({
      // Carried: facts about this buyer.
      opportunityId: 'opp-1',
      // A row stored before the affiliate link was captured reads back as carrying none.
      attribution: { ...ATTRIBUTION, affiliateLinkId: null },
      cart: CART,
      furthestStep: 'receipt',
      answers: ANSWERS,
      formStatus: { 'tf-weight-loss': 'completed' },
      disqualifiedRule: 'bmi_low_hard_stop_notice',
      disqualifiedTeleform: 'tf-weight-loss',
      verification: VERDICT,
      buyer: BUYER,
      promotion: PROMOTION,
      acceptedBumps: ['anti-nausea-kit'],
      consents: CONSENTS,
      placedOrders: ['34788'],
      upsellOutcomes: { 'sleep-support': 'declined' },
      receipt: RECEIPT,
      completedAt: '2026-08-25T10:01:00+00:00',
      sessionRetired: true,
      // Set, not carried: the mint is proof the EMR knows this one.
      reconciled: true,
      // Not carried: the old session's relationship with something else.
      readModelShape: null,
      emrEvents: [],
      cartMirrored: false,
      promotionQuotedAgainst: null,
      pendingPayment: null,
      reusableCredentialData: null,
      identityDocument: null,
      paymentSummary: null,
      upsellQueue: [],
      upsellCursor: 0,
      upsellQuotes: {},
    });
  });

  it('cannot remint on a request that may not create, and leaves the journey unreconciled', async () => {
    const { sessions, gateway, resolver, journey } = setup();
    seedStale(sessions);
    const store = journey();

    const resolution = await resolver.resolve(request({}, { amd_session: STALE }), store, false);

    expect(resolution.sessionUuid).toBe(STALE);
    expect(gateway.creates).toBe(0);
    expect(store.currentState()?.reconciled).toBe(false);
  });

  it('leaves the visitor on the old session after a failed mint, and keeps the first touch', async () => {
    const { sessions, log, resolver, journey } = setup({}, null);
    seedStale(sessions, null);
    const store = journey();

    const resolution = await resolver.resolve(request({ aff_id: '4412' }, { amd_session: STALE }), store, true);

    expect(resolution.sessionUuid).toBeNull();
    expect(sessions.rows.size).toBe(1);
    expect(store.sessionUuid()).toBe(STALE);
    expect(store.currentState()?.reconciled).toBe(false);
    expect(store.currentState()?.attribution?.get('affiliate_id')).toBe('4412');
    expect(log.warning).toHaveBeenCalledWith('session.remint_failed', { path: '/' });
  });

  it('treats a mint that returns the rejected identifier as a failure', async () => {
    const { sessions, events, log, resolver, journey } = setup({}, STALE);
    seedStale(sessions);
    const store = journey();

    const resolution = await resolver.resolve(request({}, { amd_session: STALE }), store, true);

    expect(resolution.sessionUuid).toBeNull();
    expect(resolution.issueCookie).toBe(false);
    expect(events.names()).not.toContain('session_reminted');
    expect(store.currentState()?.reconciled).toBe(false);
    expect(log.warning).toHaveBeenCalledWith('session.remint_failed', { path: '/' });
  });

  it('leaves a session the EMR does recognise untouched, and reconciles it', async () => {
    const { gateway, resolver, journey } = setup({ [KNOWN]: { exists: true, opportunityId: 'opp-5', events: ['visit_page'] } });
    const store = journey();

    const resolution = await resolver.resolve(request({}, { amd_session: KNOWN }), store, true);

    expect(resolution.sessionUuid).toBe(KNOWN);
    expect(resolution.issueCookie).toBe(false);
    expect(gateway.creates).toBe(0);
    expect(store.currentState()?.reconciled).toBe(true);
    expect(store.currentState()?.readModelShape).toBe(SessionResolver.READ_MODEL_SHAPE);
    expect(store.currentState()?.opportunityId).toBe('opp-5');
  });

  it('does not remint on a failed read', async () => {
    const { gateway, resolver, journey } = setup({}, MINTED, [KNOWN]);
    const store = journey();

    const resolution = await resolver.resolve(request({}, { amd_session: KNOWN }), store, true);

    expect(resolution.sessionUuid).toBe(KNOWN);
    expect(gateway.creates).toBe(0);
    expect(gateway.views).toEqual([KNOWN]);
    expect(store.currentState()?.reconciled).toBe(false);
  });

  it('does not read the EMR again for a journey already reconciled under the current read model', async () => {
    const { sessions, gateway, resolver, journey } = setup();
    sessions.rows.set(KNOWN, {
      journeyState: { reconciled: true, readModelShape: SessionResolver.READ_MODEL_SHAPE },
      attribution: null,
      opportunityId: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await resolver.resolve(request({}, { amd_session: KNOWN }), journey(), true);

    expect(gateway.views).toEqual([]);
    expect(gateway.creates).toBe(0);
  });
});
