import { QueryParamCipher } from '@astermd-hq/sdk';

/** Decrypts the `_amd` affiliate payload, trying the current key first, then the previous one. */
export class AmdPayload {
  /** Returns null when no key can read the token. */
  static decode(token: string, keysHex: readonly string[]): Record<string, string> | null {
    if (token === '') return null;

    for (const keyHex of keysHex) {
      const params = QueryParamCipher.decrypt(token, keyHex);
      if (Object.keys(params).length > 0) return params;
    }

    return null;
  }
}
