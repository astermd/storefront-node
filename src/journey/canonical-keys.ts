/**
 * The canonical tracking vocabulary and the vendor aliases that map onto it.
 *
 * Traffic arrives in many vendor dialects; normalising once here means the rest of the system —
 * session creation, the provider order payload — deals in one key set instead of each learning
 * every dialect (`[5.6]`). Two properties of this table are load-bearing and easy to "tidy" into
 * bugs: alias order encodes precedence (first present and non-empty wins), and a raw parameter
 * appearing under two canonical keys is intentional, not duplication (`[5.9]`).
 */
export class CanonicalKeys {
  private static table: ReadonlyArray<readonly [string, readonly string[]]> | null = null;

  /**
   * Canonical keys in a stable order: identifiers, the nineteen custom sub-identifiers, click
   * identifiers, publisher/visitor, the offer parameter, then the five UTM parameters.
   */
  static all(): string[] {
    return CanonicalKeys.aliases().map(([canonical]) => canonical);
  }

  /**
   * Canonical key => inbound aliases, most-preferred first. The canonical spelling is always its
   * own first alias so a caller sending canonical keys needs no translation. An ordered list of
   * pairs rather than an object, because `c1`..`c19` must keep their place between the
   * identifiers and the click ids.
   */
  static aliases(): ReadonlyArray<readonly [string, readonly string[]]> {
    if (CanonicalKeys.table !== null) return CanonicalKeys.table;

    const table: Array<readonly [string, readonly string[]]> = [
      ['network_id', ['network_id', 'nid', 'net_id']],
      ['affiliate_id', ['affiliate_id', 'aff_id', 'affid', 'aff']],
      ['sub_affiliate_id', ['sub_affiliate_id', 'saff_id', 'sub_id', 'sub1', 's1']],
      ['source_id', ['source_id', 'src', 'source', 'utm_source']],
    ];

    // c1..c19: the canonical spelling, the vendor sub-id spellings, and the provider slot names
    // other CRMs forward traffic under (`[5.10]`).
    for (let i = 1; i <= 19; i += 1) {
      table.push([`c${i}`, [`c${i}`, `sub${i}`, `s${i}`, `tracking${i}`, `sourceValue${i}`]]);
    }

    table.push(
      ['click_id', ['click_id', 'clickid', 'cid']],
      ['gclid', ['gclid']],
      ['network_click_id', ['network_click_id', 'transaction_id', 'tid']],
      ['publisher_id', ['publisher_id', 'pub_id', 'pubid']],
      ['visitor_id', ['visitor_id', 'vid']],
      ['offer', ['offer', 'offer_id', 'opt']],
      ['utm_source', ['utm_source']],
      ['utm_medium', ['utm_medium']],
      ['utm_campaign', ['utm_campaign']],
      ['utm_term', ['utm_term']],
      ['utm_content', ['utm_content']],
    );

    CanonicalKeys.table = table;
    return table;
  }
}
