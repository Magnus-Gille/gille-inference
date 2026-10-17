"""Validation and de-duplication for JSONL request events."""
from collections.abc import Iterable


def iter_requests(lines: Iterable[str]) -> tuple[list[dict[str, object]], int]:
    """Return valid request records and the count of invalid nonblank lines."""
    raise NotImplementedError
