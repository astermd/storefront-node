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

      // EMR doesn't know this session: replace it. A failed read (null) never does.
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
    // New session, nothing to reconcile.
    state.reconciled = true;

    // Save the row now; flush() only updates existing rows.
    const updatedAt = await this.sessions.insert(uuid, state.toArray(), incoming.toArray());
    journey.adopt(uuid, state, updatedAt);
    await this.events.append(uuid, 'session_created', { source_category: incoming.derived.sourceCategory });
    await this.recordRejectedResume(uuid, candidate);

    return new SessionResolution(uuid, true);
  }

  /** Replaces a session the EMR no longer knows with a new one and moves the buyer's journey over. */
  private async remint(
    stale: string,
    state: JourneyState,
    incoming: Attribution,
    request: Request,
    journey: JourneyStore,
  ): Promise<SessionResolution> {
    const attribution = Attribution.firstTouch(state.attribution, incoming);
    const context = SessionResolver.requestContext(request);

    // Same uuid back counts as a failure.
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

    // Save the row now; the save-back won't write an adopted state.
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

    return Attribution.capture(
      query,
      encrypted,
      referrer,
      request.get('User-Agent') ?? null,
      request.hostname ?? null,
      token === '' ? null : token,
    );
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
