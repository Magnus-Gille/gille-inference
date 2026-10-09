# Reviewed release regression record

The producer keeps this slot `unknown` until an owning maintainer completes and reviews a
release-window survey. It does not search commit messages or infer regressions from issue labels.

For every published release in the selected cohort, record the release reference, publication
time, and the complete 14-day observation window. For every confirmed issue, record the affected
release, introduction commit, known-good release, issue reference, reproducer or corroborating
evidence reference, maintainer confirmation reference, product-impact severity (`critical`,
`major`, or `minor`), and first observed time. The issue uses the proposed `code-health:regression`
label plus one `severity:*` label for triage; labels alone do not count as evidence.

A survey is complete only when it enumerates the full release cohort and its issues have been
reviewed by an owning maintainer. An incomplete survey stays unknown. A complete zero is reported
only with the full release inventory and closed observation windows. The exact objective payload
shape and its validity rules are in the vendored
[`code-health-contract.md`](../../contracts/grimnir-code-health-v1/docs/code-health-contract.md)
and objective schema.
