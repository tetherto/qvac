"""Compare first-forward operation fingerprints without aligning different graphs."""
import json
from pathlib import Path
from compare import PAIRS


def read_trace(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    if not rows or rows[-1].get('event') != 'end' or rows[-1].get('nodes') != len(rows) - 1:
        raise ValueError(f'Incomplete operation trace: {path}')
    nodes = rows[:-1]
    if not nodes or any(row.get('event') != 'node' or row.get('index') != i for i, row in enumerate(nodes)):
        raise ValueError(f'Invalid operation sequence: {path}')
    return nodes


def structure(row):
    return [{key: tensor[key] for key in ('type', 'op', 'ne', 'nb')} for tensor in [row['output'], *row['sources']]]


def compare_nodes(a, b):
    result = {'expectedNodes': len(a), 'actualNodes': len(b), 'comparable': False, 'firstDifference': None}
    if len(a) != len(b):
        result['reason'] = 'Different graph lengths; no ordinal alignment attempted'
        return result
    for i, (x, y) in enumerate(zip(a, b)):
        if structure(x) != structure(y):
            result.update(reason='Different graph structure; no ordinal alignment attempted', structuralDifferenceIndex=i)
            return result
    result['comparable'] = True
    result['unhashedNodes'] = sum(x['fnv1a64'] is None or y['fnv1a64'] is None for x, y in zip(a, b))
    for i, (x, y) in enumerate(zip(a, b)):
        if x['fnv1a64'] is not None and y['fnv1a64'] is not None and x['fnv1a64'] != y['fnv1a64']:
            result['firstDifference'] = {'index': i, 'expected': x, 'actual': y}
            break
    return result


def compare_traces(root, reference=None):
    lanes = sorted({lane for pair in PAIRS for lane in pair})
    current = {lane: read_trace(root / lane / 'operations.jsonl') for lane in lanes}
    earlier = current if reference is None else {lane: read_trace(reference / lane / 'operations.jsonl') for lane in lanes}
    pairs = PAIRS + [('resident-no-kv', 'resident-kv'), ('stream-no-kv', 'stream-kv')] if reference is None else [(lane, lane) for lane in lanes]
    return [{'baseline': a, 'candidate': b, **compare_nodes(earlier[a], current[b])} for a, b in pairs]
