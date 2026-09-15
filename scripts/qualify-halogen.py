#!/usr/bin/env python3
"""Synthetic Halogen compatibility gate. Run inside the no-network candidate container.
Only loopback HTTP is used. Stdout is content-blind JSON evidence; no credentials.
This gate does not certify agent usefulness or production readiness.
"""
import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:8731' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as response:
        return json.load(response)


def text(response):
    choices = response.get('choices', [])
    if len(choices) != 1:
        return None
    choice = choices[0]
    if choice.get('finish_reason') != 'stop':
        return None
    return choice.get('message', {}).get('content')


def run(profile_hash, runner_commit):
    rows = []
    health = request('/health')
    version = health.get('version', {})
    if version.get('api') != '0.9.1' or version.get('engine') != '0.9.1' or version.get('match') is not True:
        raise ValueError('candidate runtime identity mismatch')
    models = request('/v1/models')
    if 'qwen38-flash-next' not in [m.get('id') for m in models.get('data', [])]:
        raise ValueError('candidate model identity mismatch')
    base = {'model': 'qwen38-flash-next', 'max_tokens': 256, 'temperature': 0,
            'chat_template_kwargs': {'enable_thinking': False, 'preserve_thinking': True},
            'stream': False}
    cases = [
        ('single', [{'role': 'user', 'content': 'Reply with exactly READY and nothing else.'}], 'READY'),
        ('system-user', [{'role': 'system', 'content': 'Reply with exactly READY.'},
                         {'role': 'user', 'content': 'Perform the required response.'}], 'READY'),
        ('multi-message', [{'role': 'user', 'content': 'Remember the number 17.'},
                           {'role': 'assistant', 'content': 'I will remember 17.'},
                           {'role': 'user', 'content': 'What number did I give? Reply with the number only.'}], '17'),
        ('tool-result', [{'role': 'user', 'content': 'Read the counter and return its value only.'},
                         {'role': 'assistant', 'content': None, 'tool_calls': [
                             {'id': 'counter1', 'type': 'function', 'function': {'name': 'read_counter', 'arguments': '{}'}}]},
                         {'role': 'tool', 'tool_call_id': 'counter1', 'name': 'read_counter', 'content': '29'}], '29'),
    ]
    for name, messages, expected in cases:
        body = {**base, 'messages': messages}
        started = time.monotonic()
        try:
            response = request('/v1/chat/completions', body)
            answer = text(response)
            passed = isinstance(answer, str) and answer.strip() == expected
            choice = response.get('choices', [{}])[0]
            rows.append({'case': name, 'pass': passed, 'requestSha256': sha(body),
                         'responseSha256': sha(response), 'wallMs': round((time.monotonic()-started)*1000),
                         'finishReason': choice.get('finish_reason') if choice.get('finish_reason') in ('stop', 'length', 'tool_calls') else 'unknown',
                         'usage': {k: v for k, v in (response.get('usage') or {}).items()
                                   if k in ('prompt_tokens', 'completion_tokens', 'total_tokens')
                                   and type(v) is int and v >= 0},
                         'errorClass': None if passed else 'incorrect-or-incomplete'})
        except (urllib.error.URLError, TimeoutError, ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
            rows.append({'case': name, 'pass': False, 'requestSha256': sha(body),
                         'wallMs': round((time.monotonic()-started)*1000), 'errorClass': type(error).__name__})
            break
    # One actual tool call followed by its real result, rather than only a synthetic history.
    tool = {'type': 'function', 'function': {'name': 'read_counter', 'description': 'Read current counter.',
            'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}}
    body = {**base, 'messages': [{'role': 'user', 'content': 'Call read_counter, then report only its value.'}],
            'tools': [tool], 'tool_choice': {'type': 'function', 'function': {'name': 'read_counter'}}}
    if len(rows) == len(cases) and all(r['pass'] for r in rows):
        started = time.monotonic()
        request_hashes = [sha(body)]
        response_hashes = []
        valid = False
        error_class = None
        try:
            response = request('/v1/chat/completions', body)
            response_hashes.append(sha(response))
            choices = response.get('choices', [])
            choice = choices[0] if len(choices) == 1 else {}
            message = choice.get('message', {})
            calls = message.get('tool_calls', [])
            valid = (choice.get('finish_reason') == 'tool_calls' and message.get('role') == 'assistant'
                     and len(calls) == 1 and calls[0].get('type') == 'function'
                     and calls[0].get('function', {}).get('name') == 'read_counter'
                     and isinstance(calls[0].get('id'), str) and bool(calls[0]['id'])
                     and json.loads(calls[0]['function']['arguments']) == {})
            if valid:
                body = {**base, 'tools': [tool], 'messages': [*body['messages'], message,
                        {'role': 'tool', 'tool_call_id': calls[0]['id'], 'name': 'read_counter', 'content': '43'}]}
                request_hashes.append(sha(body))
                response = request('/v1/chat/completions', body)
                response_hashes.append(sha(response))
                answer = text(response)
                valid = isinstance(answer, str) and answer.strip() == '43'
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, urllib.error.URLError, TimeoutError) as error:
            valid = False
            error_class = type(error).__name__
        rows.append({'case': 'native-tool-roundtrip', 'pass': valid,
                     'requestSha256': request_hashes, 'responseSha256': response_hashes,
                     'wallMs': round((time.monotonic()-started)*1000),
                     'errorClass': error_class if error_class else (None if valid else 'incorrect-or-incomplete')})
    return {'schemaVersion': 1, 'gate': 'synthetic-compatibility-only',
            'requestProfile': {'temperature': 0, 'maxTokens': 256, 'thinking': False},
            'profileSha256': profile_hash, 'runnerCommit': runner_commit,
            'healthSha256': sha(health), 'modelsSha256': sha(models),
            'pass': len(rows) == 5 and all(r['pass'] for r in rows), 'rows': rows}


if __name__ == '__main__':
    import re
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-sha256', required=True)
    parser.add_argument('--runner-commit', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{64}', args.profile_sha256) or not re.fullmatch('[a-f0-9]{40}', args.runner_commit):
        parser.error('immutable profile and runner hashes required')
    try:
        result = run(args.profile_sha256, args.runner_commit)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, urllib.error.URLError, TimeoutError) as error:
        result = {'schemaVersion': 1, 'gate': 'synthetic-compatibility-only', 'pass': False,
                  'profileSha256': args.profile_sha256, 'runnerCommit': args.runner_commit,
                  'errorClass': type(error).__name__, 'errorSha256': sha(str(error))}
    print(json.dumps(result))
    raise SystemExit(0 if result['pass'] else 1)
