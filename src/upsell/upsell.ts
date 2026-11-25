/**
 * One resolved post-purchase offer, ready to render on the upsell page.
 */
export class Upsell {
  constructor(
    public readonly key: string,
    public readonly slug: string,
    public readonly variantId: string | null,
    public readonly eyebrow: string,
    public readonly headline: string,
    public readonly body: string,
    public readonly bullets: string[],
    public readonly image: string | null,
    public readonly acceptLabel: string,
    public readonly declineLabel: string,
    public readonly footnote: string | null,
    public readonly name: string,
    public readonly priceCents: number,
    public readonly providerOffer: string | null,
    public readonly providerItem: string | null,
    public readonly kind: string,
    /** The EMR's own ids for the same variant, for a provider whose order the EMR reads back by them. */
    public readonly emrProductId: string | null = null,
    public readonly emrVariantId: string | null = null,
    /** The provider's own variant of `providerItem`, when the mapping names one. */
    public readonly providerVariant: string | null = null,
  ) {}
}
