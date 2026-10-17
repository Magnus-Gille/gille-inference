"""Reference implementation for interval validation and metrics."""


def parse_intervals(value):
    if not isinstance(value, list):
        raise ValueError("intervals must be a list")
    result = []
    for pair in value:
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError("interval must be [start, end]")
        start, end = pair
        if type(start) is not int or type(end) is not int or end <= start:
            raise ValueError("interval endpoints must be increasing integers")
        result.append((start, end))
    return result


def normalize(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def peak_concurrency(intervals):
    events = (
        [(start, 1) for start, _ in intervals]
        + [(end, -1) for _, end in intervals]
    )
    current = 0
    peak = 0
    for _, delta in sorted(events, key=lambda event: (event[0], event[1])):
        current += delta
        peak = max(peak, current)
    return peak
