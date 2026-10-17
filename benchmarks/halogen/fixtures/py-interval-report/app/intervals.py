"""Validation and interval calculations for the report task."""
from collections.abc import Sequence


def parse_intervals(value: object) -> list[tuple[int, int]]:
    """Validate a JSON value and return integer half-open intervals."""
    raise NotImplementedError


def normalize(intervals: Sequence[tuple[int, int]]) -> list[list[int]]:
    """Return the sorted union, merging overlaps and adjacent intervals."""
    raise NotImplementedError


def peak_concurrency(intervals: Sequence[tuple[int, int]]) -> int:
    """Return maximum active intervals, processing ends before starts at ties."""
    raise NotImplementedError
