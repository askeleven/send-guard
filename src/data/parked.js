/**
 * Nameserver hosts used by domain-parking services. A domain on one of these is
 * for sale, not in use, and mail to it goes nowhere. Matched as a substring of the NS host.
 */
export const PARKED_NAMESERVERS = new Set([
  "buydomains.com", "domain-is-4-sale-at-domainmarket.com",
  "eftydns.com", "namebrightdns.com",
  "orderbox-dns.com", "parkingcrew.net",
  "parklogic.com", "sedoparking.com",
  "smartname.com", "this-domain-is-for-sale.com",
])
