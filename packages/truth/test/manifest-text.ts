export const VALID_MANIFEST_TEXT = `schema: openrecord/truth-manifest-v1
business:
  key: acme
authority:
  mode: repository
facts:
  starter-price:
    subject: plan:starter
    predicate: price
    type: money
    value:
      amount: "49.00"
      currency: USD
    valid_from: 2026-10-03T00:00:00Z
    source:
      url: https://acme.example/pricing
  salesforce-supported:
    subject: product
    predicate: integration.salesforce
    type: boolean
    value: false
    valid_from: 2026-10-03T00:00:00Z
  tagline:
    subject: brand
    predicate: tagline
    type: text
    value: Pay per seat
    valid_from: 2026-10-03T00:00:00Z
projections:
  starter-offer:
    kind: JSON_LD
    output: public/generated/starter-offer.json
    document:
      "@context": https://schema.org
      "@type": Offer
      price:
        fact: starter-price
        component: amount
      priceCurrency:
        fact: starter-price
        component: currency
    verify:
      url: https://acme.example/pricing
      extractor:
        kind: JSON_LD
        selector: offers.price
      comparator: MONEY
`
