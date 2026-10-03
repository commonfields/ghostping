# Authority Writer

Modes: HOSTED (default; absent row = legacy behavior, unchanged) and
REPOSITORY_MANIFEST. First manifest sync on an empty business claims
REPOSITORY mode; any business with facts stays HOSTED and rejects sync
(`ManifestSyncRejectedForHosted`). Repository businesses reject direct
hosted create/supersede/retire (`FactAuthorityManagedByRepository`) at
both the repository layer and a DB trigger (sync runs under
`SET LOCAL ghostping.authority_sync = '1'`). Mode changes are refused
once facts exist. No UI switching in V1.

One manifest sync = one DB transaction: mode acquisition, the
per-business serialization lock (`SELECT ... FOR UPDATE` on the
businesses row; lock lifetime equals transaction lifetime), current
reads, creates, supersedes, retirements, and provenance inserts all
commit or roll back together. Concurrent syncs for one business
serialize; different businesses proceed independently. At most one
ACTIVE fact per (business, manifest key) is also enforced by a trigger
backstop, so history can never fork into two ACTIVE heads.

Repository fact history cannot be directly deleted: ordinary
`DELETE authoritative_facts` is rejected while the owning business
exists (retire or supersede instead — lifecycle operations). Destroying
the owning business/account still cascades as before; fact-history
mutation is a different operation from destruction of the owner.
