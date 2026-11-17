/** Canonical tracking keys and their vendor aliases. Alias order is precedence. */
export class CanonicalKeys {
  private static table: ReadonlyArray<readonly [string, readonly string[]]> | null = null;

  /** Canonical keys, in table order. */
  static all(): string[] {
    return CanonicalKeys.aliases().map(([canonical]) => canonical);
  }

  /** Canonical key => aliases, most-preferred first. */
  static aliases(): ReadonlyArray<readonly [string, readonly string[]]> {
    if (CanonicalKeys.table !== null) return CanonicalKeys.table;

    const table: Array<readonly [string, readonly string[]]> = [
      ['network_id', ['network_id', 'nid', 'net_id']],
      ['affiliate_id', ['affiliate_id', 'aff_id', 'affid', 'aff']],
      ['sub_affiliate_id', ['sub_affiliate_id', 'saff_id', 'sub_id', 'sub1', 's1']],
      ['source_id', ['source_id', 'src', 'source', 'utm_source']],
    ];

    // c1..c19 and their vendor spellings.
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
