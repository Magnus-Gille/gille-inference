import assert from 'node:assert/strict';
import { canonical, validateSchema } from '../../scripts/lib/code-health-schema.mjs';

const valid = (schema, value) => assert.deepEqual(validateSchema(schema, value), []);
const invalid = (schema, value) => assert.notDeepEqual(validateSchema(schema, value), []);

// Closed objects reject private or otherwise unrecognized fields at every depth.
const closed = {
  type: 'object', additionalProperties: false,
  properties: {
    profile: {
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string' } }, required: ['name'],
    },
  }, required: ['profile'],
};
valid(closed, { profile: { name: 'Ada' } });
invalid(closed, { profile: { name: 'Ada', privateNote: 'hidden' } });
invalid(closed, { profile: { name: 'Ada' }, surprise: true });

// oneOf requires exactly one matching branch, including rejection of overlap.
const exclusive = { oneOf: [
  { type: 'integer', minimum: 0 },
  { type: 'integer', maximum: 10 },
] };
invalid(exclusive, 5); // matches both
valid(exclusive, -1);
valid(exclusive, 11);
invalid(exclusive, '5'); // matches neither

// Local references resolve through $defs and are applied to the instance.
const referenced = {
  $defs: { label: { type: 'string', minLength: 2 } },
  type: 'object', properties: { label: { $ref: '#/$defs/label' } },
};
valid(referenced, { label: 'ok' });
invalid(referenced, { label: 'x' });
assert.throws(() => validateSchema({ $ref: '#/$defs/missing' }, 'x'), /unresolved schema reference/);

// Unknown schema keywords must fail closed instead of being silently ignored.
assert.throws(() => validateSchema({ type: 'string', unevaluatedProperties: false }, 'ok'), /unsupported keyword/);

// Calendar validation accepts actual leap days and rejects impossible dates/times.
const timestamp = { type: 'string', format: 'date-time' };
valid(timestamp, '2024-02-29T12:30:45Z');
invalid(timestamp, '2023-02-29T12:30:45Z');
invalid(timestamp, '2024-04-31T12:30:45Z');
invalid(timestamp, '2024-01-01T25:00:00Z');

// Length counts Unicode code points rather than UTF-16 code units.
valid({ type: 'string', maxLength: 1 }, '😀');
invalid({ type: 'string', maxLength: 1 }, '😀a');

// Arrays enforce uniqueness and both size bounds.
const list = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2, uniqueItems: true };
valid(list, [1, 2]);
invalid(list, []);
invalid(list, [1, 2, 3]);
invalid(list, [1, 1]);
invalid({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]);

// Number and integer types reject non-finite and unsafe numeric values.
valid({ type: 'number' }, 1.5);
invalid({ type: 'number' }, Infinity);
invalid({ type: 'number' }, NaN);
valid({ type: 'integer' }, Number.MAX_SAFE_INTEGER);
invalid({ type: 'integer' }, Number.MAX_SAFE_INTEGER + 1);
invalid({ type: 'integer' }, 1.25);

// Required fields are checked, while present fields still follow their schemas.
const required = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
valid(required, { id: 'x' });
invalid(required, {});
invalid(required, { id: 3 });

// Canonical equality ignores object key order, including nested const values.
assert.equal(canonical({ z: 1, a: { y: 2, x: 3 } }), canonical({ a: { x: 3, y: 2 }, z: 1 }));
valid({ const: { z: 1, a: { y: 2, x: 3 } } }, { a: { x: 3, y: 2 }, z: 1 });

console.log('code-health-schema tests passed');
