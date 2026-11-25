import { LeadGateway } from '../../src/forms/lead-gateway';
import { LeadWriter } from '../../src/forms/lead-writer';
import { RecordMapper } from '../../src/forms/record-mapper';
import { Attribution } from '../../src/journey/attribution';
import { JourneyState } from '../../src/journey/journey-state';
import { OperatorLog } from '../../src/support/operator-log';

class RecordingLeadGateway implements LeadGateway {
  creates: Array<Record<string, unknown>> = [];
  updates: Array<[string, Record<string, unknown>]> = [];

  async create(payload: Record<string, unknown>): Promise<string | null> {
    this.creates.push(payload);
    return 'opp-1';
  }

  async update(opportunityId: string, payload: Record<string, unknown>): Promise<boolean> {
    this.updates.push([opportunityId, payload]);
    return true;
  }

  writes(): boolean {
    return true;
  }
}

const ANSWERS = { first_name: 'Test', email: 'test@example.test' };

function writer(gateway: LeadGateway): LeadWriter {
  const log = { info: jest.fn(), warning: jest.fn(), error: jest.fn() } as unknown as OperatorLog;
  return new LeadWriter(gateway, new RecordMapper(log), log);
}

describe('LeadWriter affiliate link', () => {
  it('sends the affiliate link in the attribution block of the create', async () => {
    const gateway = new RecordingLeadGateway();
    const state = new JourneyState();
    state.attribution = Attribution.capture({ affid: '6a906a42a002ad6ea5037d8e' }, {}, null);

    await writer(gateway).capture('sess-1', state, ANSWERS);

    expect(gateway.creates[0].attribution).toEqual({ affiliate_link_id: '6a906a42a002ad6ea5037d8e' });
  });

  it('sends no attribution block when there is no affiliate link', async () => {
    const gateway = new RecordingLeadGateway();
    const state = new JourneyState();
    state.attribution = Attribution.capture({ utm_source: 'newsletter' }, {}, null);

    await writer(gateway).capture('sess-1', state, ANSWERS);

    expect(gateway.creates[0].sessions).toEqual(['sess-1']);
    expect(gateway.creates[0]).not.toHaveProperty('attribution');
  });

  it('never resends the affiliate link on an update', async () => {
    const gateway = new RecordingLeadGateway();
    const state = new JourneyState();
    state.opportunityId = 'opp-9';
    state.attribution = Attribution.capture({ affid: '6a906a42a002ad6ea5037d8e' }, {}, null);

    await writer(gateway).capture('sess-1', state, ANSWERS);

    expect(gateway.updates).toHaveLength(1);
    expect(gateway.updates[0][1]).toHaveProperty('email');
    expect(gateway.updates[0][1]).not.toHaveProperty('attribution');
  });
});
