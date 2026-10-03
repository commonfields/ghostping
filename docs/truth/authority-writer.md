# Authority Writer

Modes: HOSTED (default; absent row = legacy behavior, unchanged) and
REPOSITORY_MANIFEST. First manifest sync on an empty business claims
REPOSITORY mode; any business with facts stays HOSTED and rejects sync
(`ManifestSyncRejectedForHosted`). Repository businesses reject direct
hosted create/supersede/retire (`FactAuthorityManagedByRepository`) at
both the repository layer and a DB trigger (sync runs under
`SET LOCAL ghostping.authority_sync = '1'`). Mode changes are refused
once facts exist. No UI switching in V1.
