"""Reference implementation for the JSONL request parser."""
import json


def iter_requests(lines):
    records = {}
    order = []
    invalid = 0
    for raw in lines:
        if raw.strip() == "":
            continue
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            invalid += 1
            continue
        if (
            not isinstance(value, dict)
            or value.get("kind") != "request"
            or not isinstance(value.get("id"), str)
            or not value["id"]
            or not isinstance(value.get("model"), str)
            or not value["model"]
            or type(value.get("input_tokens")) is not int
            or value["input_tokens"] < 0
            or type(value.get("output_tokens")) is not int
            or value["output_tokens"] < 0
        ):
            invalid += 1
            continue
        if value["id"] not in records:
            order.append(value["id"])
        records[value["id"]] = value
    return [records[key] for key in order], invalid
