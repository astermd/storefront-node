import { QueryParamCipher } from '@astermd-hq/sdk';

/**
 * Reads the `_amd` tracking payload that affiliate links carry instead of plain query parameters.
 *
 * The parameters are encrypted so browser extensions cannot rewrite affiliate identifiers in
 * transit (`[5.1]`), and the cipher itself belongs to the SDK: `QueryParamCipher.decrypt()` owns
 * the wire format and the key shape, and is already total — an absent, truncated, tampered or
 * wrongly-keyed token comes back as `{}` rather than an exception, which is what lets the caller
 * fall back silently to plain parameters (`[5.3]`). A payload that decrypts but carries no entries
 * is indistinguishable here from one that could not be read; both return `null`, and the caller's
 * response is the same either way.
 *
 * What this adds is the rotation overlap (`[5.2b]`): keys are tried in order, current first, so a
 * deployment mid-rotation keeps reading links signed with the previous key that are already
 * sitting in sent emails and bought ads.
 *
 * Decryption is in-process by requirement (`[5.2a]`): it runs on the first request of every
 * affiliate landing. A decoded payload is still untrusted input — AES-CBC carries no authenticity —
 * so `Attribution.capture()` normalises it against the canonical alias table before use.
 */
export class AmdPayload {
  /**
   * @param token the raw `_amd` value from the URL
   * @param keysHex secret keys as the SDK expects them, current key first
   * @returns decoded parameters, or null when no key could read the token
   */
  static decode(token: string, keysHex: readonly string[]): Record<string, string> | null {
    if (token === '') return null;

    for (const keyHex of keysHex) {
      const params = QueryParamCipher.decrypt(token, keyHex);
      if (Object.keys(params).length > 0) return params;
    }

    return null;
  }
}
