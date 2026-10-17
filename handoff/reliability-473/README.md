# Accepted client artifact for session continuation

This branch preserves the exact accepted M5 client 1.5.4 tarball for continuation on another
operator workstation. It does not publish to npm or establish production acceptance.

- Accepted gateway receipt: PR #473, `d14a132d3ed132340ca38092f01fe0063f2fbb4c`.
- Tarball SHA256: `00d28af593ed6bc0baa924d0c9aef346fb3b4d504476459a8bd967842806ba39`.
- Every tarball member was compared byte-for-byte with the already published client source
  at that accepted release. No credentials, local configuration or operational logs are included.
- The later main change in PR #475 needs drift assessment before selecting a production revision;
  never select a release simply from the current checkout.

Fetch this branch/its immutable commit to retrieve the tarball and verify its SHA256 before use.
This handoff branch and the `codex/archive-20261017-*` preservation branches are not deployment
candidates. The archives contain earlier work superseded by PR #473. Keep production selection
bound to accepted source/review/CI evidence and the applicable operator mandate.

The portable operator handoff and exact non-secret release gates are tracked privately.
Keep local ignored status files and private execution records out of this public repository.
The execution-context documentation gap is tracked in
[Brokkr #142](https://github.com/Magnus-Gille/brokkr/issues/142).
