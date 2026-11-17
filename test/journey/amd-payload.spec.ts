import { QueryParamCipher } from '@astermd-hq/sdk';
import { AmdPayload } from '../../src/journey/amd-payload';

const KEY = '00112233445566778899aabbccddeeff';
const PREVIOUS_KEY = 'ffeeddccbbaa99887766554433221100';

describe('AmdPayload', () => {
  it('decodes a token into a flat parameter map', () => {
    const token = QueryParamCipher.encrypt({ aff_id: '4412', sub1: 'creativeA' }, KEY);
    expect(AmdPayload.decode(token, [KEY])).toEqual({ aff_id: '4412', sub1: 'creativeA' });
  });

  it('decrypts links signed before a rotation with the previous key', () => {
    const token = QueryParamCipher.encrypt({ aff_id: '4412' }, PREVIOUS_KEY);
    expect(AmdPayload.decode(token, [KEY])).toBeNull();
    expect(AmdPayload.decode(token, [KEY, PREVIOUS_KEY])).toEqual({ aff_id: '4412' });
  });

  it('still decrypts a current-key token while both keys are configured', () => {
    const token = QueryParamCipher.encrypt({ aff_id: 'current' }, KEY);
    expect(AmdPayload.decode(token, [KEY, PREVIOUS_KEY])).toEqual({ aff_id: 'current' });
  });

  it('returns null without throwing for every unreadable token', () => {
    const valid = QueryParamCipher.encrypt({ a: 'b' }, KEY);

    expect(AmdPayload.decode('', [KEY])).toBeNull();
    expect(AmdPayload.decode('!!!not-base64!!!', [KEY])).toBeNull();
    expect(AmdPayload.decode('c2hvcnQ=', [KEY])).toBeNull();
    expect(AmdPayload.decode(valid, [])).toBeNull();
    expect(AmdPayload.decode(valid, ['not-a-key'])).toBeNull();
  });

  it('decodes a valueless entry to an empty string', () => {
    const token = QueryParamCipher.encrypt({ aff_id: '' }, KEY);
    expect(AmdPayload.decode(token, [KEY])).toEqual({ aff_id: '' });
  });
});
