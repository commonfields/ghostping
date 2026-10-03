# Security (SSRF)

Reject localhost, loopback, RFC1918, link-local, multicast, metadata
(169.254.169.254, 100.100.100.200), non-http(s). DNS resolved pre-connect
and revalidated on every redirect; redirect targets to forbidden networks
rejected as SECURITY_REJECTED. Tests inject transport/resolver; production
policy never weakened.
