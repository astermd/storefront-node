import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { JourneyStore } from '../../src/journey/journey-store';
import { createTestApp } from '../support/test-app';

/**
 * Proves the step guard over the real, fully-wired app (not a standalone mini-module):
 * `/checkout/` with an empty cart 303/302-redirects away per the funnel's routing decision, and —
 * extending the synthetic redirect test in `middleware-ordering.e2e-spec.ts` with the *real* `StepGuardMiddleware` now — the
 * `journeySaveBack` flush still runs on that real guard-redirect.
 */
describe('StepGuardMiddleware over the real app', () => {
  let app: NestExpressApplication;
  let flushSpy: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await createTestApp(moduleRef);
    flushSpy = jest.spyOn(JourneyStore.prototype, 'flush');
  });

  afterEach(() => {
    flushSpy.mockClear();
  });

  afterAll(async () => {
    flushSpy.mockRestore();
    await app.close();
  });

  it('redirects an empty-cart GET /checkout/ away, per the funnel routing decision', async () => {
    const res = await request(app.getHttpServer()).get('/checkout/').redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('still flushes journey state on that real guard-redirect', async () => {
    await request(app.getHttpServer()).get('/checkout/').redirects(0);

    expect(flushSpy).toHaveBeenCalled();
  });

  it('lets an unguarded path (home) through untouched', async () => {
    const res = await request(app.getHttpServer()).get('/');

    // `/` is a real route — the guard must let it render normally, not redirect it,
    // since `home` has no requirements.
    expect(res.status).toBe(200);
  });
});
