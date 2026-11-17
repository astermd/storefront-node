import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_GATEWAY } from '../core/tokens';
import { EventRepository } from '../repository/event-repository';
import { SessionRepository } from '../repository/session-repository';
import { OperatorLog } from '../support/operator-log';
import { AmdPayload } from './amd-payload';
import { Attribution } from './attribution';
import { JourneyState } from './journey-state';
import { JourneyStore } from './journey-store';
import { SessionGateway, SessionViewResult } from '../emr/session-gateway';
import { SessionOptions } from './session-options';
import { SessionResolution } from './session-resolution';

interface ResumeAdoption {
  uuid: string;
  snapshot: SessionViewResult | null;
}

/**
 * Decides which analytics session this request belongs to, and captures first-touch attribution
 * while doing it.
 *
 * Order of precedence:
 *   1. A valid resume link (`?amd_session=<uuid>`) beats the cookie, because it comes from a
 *      message the storefront itself sent (`[21.3]`). The session is adopted, its journey restored,
 *      and the cookie re-issued for it. A malformed value is ignored silently (`[4.10]`); a
 *      well-formed one the EMR does not know is logged and recorded as `session_resume_rejected`
 *      (`[21.2]`), and the visitor carries on as if no link had been given.
 *   2. The cookie beats minting (`[4.2]`). A cookie whose journey is not yet reconciled is read
 *      against the EMR once; one the EMR says it does not know is replaced (`remint()`).
 *   3. Otherwise a session is minted, when the request may create one (`[4.1]`).
 */
@Injectable()
export class SessionResolver {
  /**
   * Generation of the EMR read-model extractors, stamped next to `reconciled`. Bump it whenever
   * the extractors change, so every journey reconciled under the old ones is re-read once.
   */
  static readonly READ_MODEL_SHAPE = 1;

  /** Accepted session-identifier shape (`[4.10]`): a canonical UUID or a hex object id. */
  private static readonly UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;

  constructor(
    @Inject(SESSION_GATEWAY) private readonly gateway: SessionGateway,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly log: OperatorLog,
    private readonly options: SessionOptions,
  ) {}

  async resolve(request: Request, journey: JourneyStore, mayCreate: boolean): Promise<SessionResolution> {
    const incoming = this.captureAttribution(request);

    const candidate = SessionResolver.validUuid(SessionResolver.queryString(request, this.options.resumeParam));
    const adoption = candidate !== null ? await this.adoptFromResumeLink(candidate) : null;
    if (adoption !== null) {
      const state = await this.hydrate(journey, adoption.uuid, incoming, adoption.snapshot);
      await this.events.append(adoption.uuid, 'session_adopted');
      await this.auditResumeAccess(adoption.uuid, state);
      return new SessionResolution(adoption.uuid, true);
    }

    const cookies = (request as { cookies?: Record<string, string> }).cookies ?? {};
    const cookie = SessionResolver.validUuid(cookies[this.options.cookieName] ?? '');

    if (cookie !== null) {
      const state = await journey.load(cookie);
      const snapshot = SessionResolver.needsReconciliationRead(state) ? await this.gateway.view(cookie) : null;

      // An authoritative "the EMR does not know this session" is actionable rather than something
      // to record and carry: every mirror call this journey makes from here would fail and be
      // swallowed (`[7.12]`). `reconciled` is deliberately NOT stamped on this path — when the
      // re-mint cannot happen on this request, the next page view has to re-read and try again
      // rather than inherit the wrong answer forever. A failed read (null) is not an answer: the
      // EMR being unreachable says nothing about the session, so it never triggers a re-mint.
      if (snapshot !== null && snapshot.exists !== true) {
        if (mayCreate) {
          return this.remint(cookie, state, incoming, request, journey);
        }

        state.attribution = Attribution.firstTouch(state.attribution, incoming);
        return new SessionResolution(cookie);
      }

      if (snapshot !== null) {
        SessionResolver.applySnapshot(state, snapshot);
      }
      state.attribution = Attribution.firstTouch(state.attribution, incoming);
      return new SessionResolution(cookie);
    }

    if (!mayCreate) {
      return new SessionResolution(null);
    }

    const context = SessionResolver.requestContext(request);
    const uuid = await this.gateway.create(incoming.emrSessionPayload(), context.userAgent, context.clientIp);
    if (uuid === null || SessionResolver.validUuid(uuid) === null) {
      this.log.warning('session.create_failed', { path: request.path });
      return new SessionResolution(null);
    }

    const state = new JourneyState();
    state.attribution = incoming;
    // A session minted on this request has no server-side history, so the reconciliation read
    // would be a round-trip for nothing. No read-model generation is stamped, because none was
    // consulted: that leaves a later resume link its single confirming read (`[4.12]`).
    state.reconciled = true;

    // The row is inserted here, not left to the save-back: `flush()` only updates an existing row,
    // so without it this request's journey (first-touch attribution, `reconciled`) is never stored
    // and the next request's `load()` starts the session over from an empty, unreconciled row.
    const updatedAt = await this.sessions.insert(uuid, state.toArray(), incoming.toArray());
    journey.adopt(uuid, state, updatedAt);
    await this.events.append(uuid, 'session_created', { source_category: incoming.derived.sourceCategory });
    await this.recordRejectedResume(uuid, candidate);

    return new SessionResolution(uuid, true);
  }

  /**
   * Replaces a cookie the EMR no longer recognises with a fresh session, carrying the journey
   * across.
   *
   * What moves and what does not is decided for every durable field; a field with no decision
   * defaults to *not carried*, and the spec enumerates the whole state so a field added later
   * cannot join either side by omission.
   *
   * Carried — facts about this buyer: attribution, the opportunity link, the cart, the furthest
   * step, the questionnaire (answers, per-form status, any standing disqualification), the
   * identity verdict, the checkout's working state (buyer details, promotion, accepted bumps,
   * consents), and the whole record of a purchase that already happened (placed orders, upsell
   * outcomes, the retained receipt, the fire-once completion guard and the retirement flag)
   * (`[5.12]`, `[5.21]`, `[21.7]`, `[9.8]`, `[21.5]`, `[13.30]`, `[22.20]`, `[17.1]`, `[4.17]`,
   * `[4.18]`).
   *
   * Not carried — the old session's relationship with something else: its recorded EMR events
   * (carrying them would suppress "initiated" events on a session where nothing has fired yet,
   * `[4.13]`), the cart-mirror flag (the new session has no remote cart), the read-model generation
   * (nothing was read for the new identifier), the promotion's cart digest (re-quoting is the safe
   * direction, `[14.6b]`), a payment pending on the old session's checkout attempt, and the
   * post-purchase working state — credential handle, upsell queue, cursor and quotes. Without a
   * handle the remaining offers are skipped silently (`[15.13]`), which costs one optional add-on;
   * carrying it without its queue position would re-offer something already charged.
   *
   * Also not carried: `identityDocument` and `paymentSummary`.
   *
   * A failed mint leaves the visitor on the old identifier with the journey still unreconciled,
   * so the next page view tries again rather than settling into the broken state.
   */
  private async remint(
    stale: string,
    state: JourneyState,
    incoming: Attribution,
    request: Request,
    journey: JourneyStore,
  ): Promise<SessionResolution> {
    const attribution = Attribution.firstTouch(state.attribution, incoming);
    const context = SessionResolver.requestContext(request);

    // Getting the rejected identifier back is not a new session: the insert would no-op on
    // conflict and the same cookie would be re-issued over the same unreconciled row, minting
    // again on every page view. Treated as a failed mint for that reason.
    const uuid = await this.gateway.create(attribution.emrSessionPayload(), context.userAgent, context.clientIp);
    if (uuid === null || uuid === stale || SessionResolver.validUuid(uuid) === null) {
      this.log.warning('session.remint_failed', { path: request.path });
      state.attribution = attribution;
      return new SessionResolution(null);
    }

    const fresh = new JourneyState();
    fresh.attribution = attribution;
    fresh.opportunityId = state.opportunityId;
    fresh.cart = state.cart;
    fresh.furthestStep = state.furthestStep;
    fresh.reconciled = true;
    fresh.answers = state.answers;
    fresh.formStatus = state.formStatus;
    fresh.disqualifiedRule = state.disqualifiedRule;
    fresh.disqualifiedTeleform = state.disqualifiedTeleform;
    fresh.verification = state.verification;
    fresh.buyer = state.buyer;
    fresh.promotion = state.promotion;
    fresh.acceptedBumps = state.acceptedBumps;
    fresh.consents = state.consents;
    fresh.placedOrders = state.placedOrders;
    fresh.upsellOutcomes = state.upsellOutcomes;
    fresh.receipt = state.receipt;
    fresh.completedAt = state.completedAt;
    fresh.sessionRetired = state.sessionRetired;

    // The opportunity is passed to the insert rather than left to the save-back: adopt()
    // fingerprints the state it is handed, so nothing downstream sees the transplant as a change.
    const updatedAt = await this.sessions.insert(uuid, fresh.toArray(), attribution.toArray(), fresh.opportunityId);
    journey.adopt(uuid, fresh, updatedAt);
    await this.events.append(uuid, 'session_reminted', { replaced: stale });
    this.log.info('session.reminted', { session: uuid, replaced: stale });

    return new SessionResolution(uuid, true);
  }

  /**
   * Accepts a resume-link session if this storefront already holds a reconciled journey for it, or
   * if the EMR confirms it exists. Uses a read-only lookup rather than `JourneyStore.load()`, which
   * would create a row for an identifier this may be about to reject.
   */
  private async adoptFromResumeLink(candidate: string): Promise<ResumeAdoption | null> {
    const row = await this.sessions.find(candidate);
    if (row !== null && SessionResolver.carriesCurrentReadModel(JourneyState.fromArray(row.journeyState, null, null))) {
      return { uuid: candidate, snapshot: null };
    }

    const snapshot = await this.gateway.view(candidate);
    if (snapshot === null || snapshot.exists !== true) {
      this.log.info('session.resume_rejected', { session: candidate });
      return null;
    }

    return { uuid: candidate, snapshot };
  }

  /** Loads the adopted journey, folds in the EMR snapshot (if any) and this request's attribution. */
  private async hydrate(
    journey: JourneyStore,
    uuid: string,
    incoming: Attribution,
    snapshot: SessionViewResult | null,
  ): Promise<JourneyState> {
    const state = await journey.load(uuid);

    if (snapshot === null && SessionResolver.needsReconciliationRead(state)) {
      snapshot = await this.gateway.view(uuid);
    }
    if (snapshot !== null) {
      SessionResolver.applySnapshot(state, snapshot);
    }

    state.attribution = Attribution.firstTouch(state.attribution, incoming);
    return state;
  }

  /**
   * `[30.7]`/`[30.8]`: a resume link put someone's journey — possibly including intake answers —
   * back in front of a browser. The link never expires, so this row is the only record that it was
   * used. Records whether answers came back, never the answers themselves.
   */
  private async auditResumeAccess(uuid: string, state: JourneyState): Promise<void> {
    const teleforms = Object.keys(state.answers).length;
    await this.events.append(uuid, 'access.journey_resumed', {
      actor: 'resume_link',
      reason: 'journey_resumed',
      restored_intake: teleforms > 0,
      teleforms,
    });
  }

  /** A well-formed resume value that adoption still rejected names a session the EMR does not know. */
  private async recordRejectedResume(uuid: string, candidate: string | null): Promise<void> {
    if (candidate !== null) {
      await this.events.append(uuid, 'session_resume_rejected', { rejected: candidate });
    }
  }

  /**
   * Merges an EMR snapshot into the journey: the opportunity only if none is set, and events as a
   * union so one recorded locally on this request isn't lost (`[4.12]`, `[4.13]`).
   */
  private static applySnapshot(state: JourneyState, snapshot: SessionViewResult): void {
    if (snapshot.exists) {
      state.opportunityId ??= snapshot.opportunityId;
      for (const name of snapshot.events) {
        state.recordEmrEvent(name);
      }
    }

    state.reconciled = true;
    state.readModelShape = SessionResolver.READ_MODEL_SHAPE;
  }

  private static needsReconciliationRead(state: JourneyState): boolean {
    if (!state.reconciled) return true;
    return state.readModelShape !== null && state.readModelShape !== SessionResolver.READ_MODEL_SHAPE;
  }

  private static carriesCurrentReadModel(state: JourneyState): boolean {
    return state.reconciled && state.readModelShape === SessionResolver.READ_MODEL_SHAPE;
  }

  private captureAttribution(request: Request): Attribution {
    const referrer = request.get('Referer') || null;
    const query = { ...(request.query as Record<string, unknown>) };
    const raw = query[this.options.payloadParam];
    const token = typeof raw === 'string' ? raw : '';
    delete query[this.options.payloadParam];

    let encrypted: Record<string, string> = {};
    if (token !== '') {
      const decoded = AmdPayload.decode(token, this.options.trackingKeys);
      if (decoded === null) {
        this.log.warning('amd_decrypt_failed', { keys_tried: this.options.trackingKeys.length });
      } else {
        encrypted = decoded;
      }
    }

    return Attribution.capture(query, encrypted, referrer, request.get('User-Agent') ?? null, request.hostname ?? null);
  }

  /** A single string query value; anything else (absent, repeated, nested) reads as empty. */
  private static queryString(request: Request, name: string): string {
    const value = (request.query as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : '';
  }

  private static requestContext(request: Request): { userAgent: string | null; clientIp: string | null } {
    return {
      userAgent: request.get('User-Agent') ?? null,
      clientIp: request.ip ?? null,
    };
  }

  private static validUuid(value: string): string | null {
    const trimmed = value.trim();
    return SessionResolver.UUID_PATTERN.test(trimmed) ? trimmed : null;
  }
}
