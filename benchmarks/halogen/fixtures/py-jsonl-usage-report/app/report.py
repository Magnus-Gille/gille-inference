"""Deterministic aggregate and CSV rendering for request events."""
from collections.abc import Iterable


def summarize(lines: Iterable[str]) -> dict[str, object]:
    """Aggregate request records by model."""
    raise NotImplementedError


def render_csv(report: dict[str, object]) -> str:
    """Render a report using the stable CSV schema."""
    raise NotImplementedError
