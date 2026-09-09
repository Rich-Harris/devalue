import { MAX_ARRAY_INDEX } from './constants.js';
import {
	enumerable_symbols,
	get_type,
	is_plain_object,
	valid_array_indices
} from './utils.js';

/**
 * Merges caller-provided operation overrides over the defaults. Iterating the
 * default keys (rather than the override's own keys) means nullish members
 * fall back to the default, and inherited members — e.g. from a class
 * instance — are picked up.
 *
 * @template {Record<string, any>} T
 * @param {T} defaults
 * @param {Partial<T> | undefined} overrides
 * @returns {T}
 */
export function merge_operations(defaults, overrides) {
	if (!overrides) return defaults;

	const merged = /** @type {T} */ ({});

	for (const key of /** @type {(keyof T)[]} */ (Object.keys(defaults))) {
		merged[key] = overrides[key] ?? defaults[key];
	}

	return merged;
}

/** @type {{ kind: 'not-plain' }} */
const NOT_PLAIN = Object.freeze({ kind: 'not-plain' });

/** @type {{ kind: 'symbol-keys' }} */
const SYMBOL_KEYS = Object.freeze({ kind: 'symbol-keys' });

/**
 * The default implementations of every introspection/extraction operation
 * `stringify` performs on the value being serialized. Each one uses native
 * JavaScript semantics (property access, iteration, prototype methods, etc).
 *
 * Pass overrides via the `operations` option of `stringify`/`stringifyAsync`
 * to customize how values are inspected — e.g. to serialize values without
 * triggering getters, proxy traps, or patched prototype methods, or to
 * serialize values that live in a different JavaScript runtime (a `node:vm`
 * context, a WASM-hosted engine, a remote process) through handle objects.
 *
 * The object is frozen — it is shared by every `stringify` call that does
 * not override a given operation.
 *
 */
/** @type {import('./types.js').DefaultStringifyOperations} */
const stringify_operations = {
	identify: (value) => value,

	typeOf: (value) => (value === null ? 'null' : typeof value),

	toPrimitive: (value) => value,

	tagOf: (value) => {
		// arrays and plain objects, the common shapes, skip the string
		// `Object.prototype.toString` allocates — unless a `Symbol.toStringTag`
		// is present, which that call would honor
		if (Symbol.toStringTag in value) return get_type(value);
		if (Array.isArray(value)) return 'Array';
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) return 'Object';
		return get_type(value);
	},

	isThenable: (value) => typeof value.then === 'function',

	toPromise: (thenable) => Promise.resolve(thenable),

	unbox: (boxed) => boxed.valueOf(),

	toISOString: (date) => (isNaN(date.getDate()) ? '' : date.toISOString()),

	toStringValue: (value) => value.toString(),

	regExpInfo: (regexp) => ({ source: regexp.source, flags: regexp.flags }),

	valuesOf: (set) => set,

	entriesOf: (map) => map,

	viewInfo: (view) => ({
		buffer: view.buffer,
		byteOffset: view.byteOffset,
		byteLength: view.byteLength,
		length: view.length,
		bufferByteLength: view.buffer.byteLength
	}),

	toArrayBuffer: (buffer) => buffer,

	lengthOf: (array) => array.length,

	hasOwn: (value, key) => Object.hasOwn(value, key),

	indicesOf: (array) => valid_array_indices(array),

	shapeOf: (value) => {
		if (!is_plain_object(value)) return NOT_PLAIN;
		if (enumerable_symbols(value).length > 0) return SYMBOL_KEYS;

		return {
			kind: Object.getPrototypeOf(value) === null ? 'null-proto' : 'plain',
			keys: Object.keys(value)
		};
	},

	get: (value, key) => value[key]
};

export const default_stringify_operations = Object.freeze(stringify_operations);

/**
 * The default implementations of every construction operation `parse` and
 * `unflatten` perform while reviving a value. Each one uses native
 * JavaScript semantics (built-in constructors, property assignment, etc).
 *
 * Pass overrides via the `operations` option of `parse`/`unflatten` to
 * customize how values are built — e.g. to construct them from the
 * intrinsics of a different realm (a `node:vm` context), or to build up
 * values inside another JavaScript runtime (a WASM-hosted engine, a remote
 * process) through handle objects.
 *
 * The object is frozen — it is shared by every `parse` call that does not
 * override a given operation.
 *
 */
/** @type {import('./types.js').DefaultParseOperations} */
const parse_operations = {
	fromPrimitive: (primitive) => primitive,

	fromISOString: (iso) => new Date(iso),

	fromStringValue: (tag, text) => {
		if (tag === 'URL') return new URL(text);
		if (tag === 'URLSearchParams') return new URLSearchParams(text);
		// 'Temporal.Instant', 'Temporal.PlainDate', ...
		// @ts-expect-error TS doesn't know about Temporal yet
		return Temporal[tag.slice(9)].from(text);
	},

	fromArrayBuffer: (buffer) => buffer,

	fromRegExpInfo: (source, flags) => new RegExp(source, flags),

	fromViewInfo: (tag, buffer, byteOffset, length) => {
		const Constructor = /** @type {any} */ (globalThis)[tag];
		return byteOffset !== undefined
			? new Constructor(buffer, byteOffset, length)
			: new Constructor(buffer);
	},

	box: (value) => Object(value),

	createArray: (length) => new Array(length),

	createSparseArray: (length) => {
		/** @type {any[]} */
		const array = [];

		// Setting `array.length = length` (or equivalently calling
		// `new Array(length)`) on an untrusted length is a DoS vector: V8
		// eagerly allocates a contiguous backing store for array lengths below
		// ~10^8, so a small payload with a huge declared length can force
		// arbitrary memory allocation. Touching the largest-possible index
		// first forces V8 into dictionary-elements mode, where `length` is
		// just a number and no contiguous allocation occurs.
		array[MAX_ARRAY_INDEX] = undefined;
		delete array[MAX_ARRAY_INDEX];
		array.length = length;

		return array;
	},

	createObject: () => ({}),

	createNullPrototypeObject: () => Object.create(null),

	createSet: () => new Set(),

	createMap: () => new Map(),

	set: (target, key, value) => {
		target[key] = value;
	},

	addValue: (set, value) => {
		set.add(value);
	},

	addEntry: (map, key, value) => {
		map.set(key, value);
	}
};

export const default_parse_operations = Object.freeze(parse_operations);
