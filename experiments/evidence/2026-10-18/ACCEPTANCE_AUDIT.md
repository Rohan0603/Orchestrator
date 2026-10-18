# Acceptance audit

Required invariant:

1. Acceptance criteria pass.
2. Mandatory deterministic checks pass.
3. Independent review passes.
4. No blocking findings remain.
5. Diff, artifacts, and evidence are durable and valid.
6. Policy and approval obligations remain satisfied.
7. Durable run/attempt/acceptance states are consistent.

The three retained trials satisfy criteria 1, 2, 5, 6, and the observed durable
state path for 7. Criterion 3 is unavailable and therefore criterion 4 fails
closed. Each trial records `acceptance.status=blocked` and
`review.status=blocked`; worker success does not become acceptance.

This is a self-audit. It is not independent review.

