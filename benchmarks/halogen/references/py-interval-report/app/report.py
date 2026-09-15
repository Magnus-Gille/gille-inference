"""Reference implementation for interval report assembly."""
from intervals import normalize, parse_intervals, peak_concurrency


def build_report(value):
    intervals = parse_intervals(value)
    merged = normalize(intervals)
    return {
        "intervals": merged,
        "totalDuration": sum(end - start for start, end in merged),
        "peakConcurrency": peak_concurrency(intervals),
    }
