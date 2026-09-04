import { MAX_ARRAY_INDEX, MAX_ARRAY_LEN } from './constants.js';

/** @type {Record<string, string>} */
export const escaped = {
	'<': '\\u003C',
	'\\': '\\\\',
	'\b': '\\b',
	'\f': '\\f',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};

export class DevalueError extends Error {
	/**
	 * @param {string} message
	 * @param {string[]} keys
	 * @param {any} [value] - The value that failed to be serialized
	 * @param {any} [root] - The root value being serialized
	 */
	constructor(message, keys, value, root) {
		super(message);
		this.name = 'DevalueError';
		this.path = keys.join('');
		this.value = value;
		this.root = root;
	}
}

/** @param {any} thing */
export function is_primitive(thing) {
	return thing === null || (typeof thing !== 'object' && typeof thing !== 'function');
}

const object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(Object.prototype)
	.sort()
	.join('\0');

/** @param {any} thing */
export function is_plain_object(thing) {
	const proto = Object.getPrototypeOf(thing);

	return (
		proto === Object.prototype ||
		proto === null ||
		Object.getPrototypeOf(proto) === null ||
		Object.getOwnPropertyNames(proto).sort().join('\0') === object_proto_names
	);
}

/** @param {any} thing */
export function get_type(thing) {
	return Object.prototype.toString.call(thing).slice(8, -1);
}

/** @param {string} char */
function get_escaped_char(char) {
	switch (char) {
		case '"':
			return '\\"';
		case '<':
			return '\\u003C';
		case '\\':
			return '\\\\';
		case '\n':
			return '\\n';
		case '\r':
			return '\\r';
		case '\t':
			return '\\t';
		case '\b':
			return '\\b';
		case '\f':
			return '\\f';
		case '\u2028':
			return '\\u2028';
		case '\u2029':
			return '\\u2029';
		default:
			return char < ' ' ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : '';
	}
}

/** @param {string} str */
export function stringify_string(str) {
	let result = '';
	let last_pos = 0;
	const len = str.length;

	for (let i = 0; i < len; i += 1) {
		const code = str.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdfff) {
			// A well-formed surrogate pair passes through untouched; an unpaired
			// surrogate cannot survive UTF-8 transport, so it is escaped.
			if (code <= 0xdbff && i + 1 < len && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
				i += 1;
				continue;
			}
			result += str.slice(last_pos, i) + `\\u${code.toString(16)}`;
			last_pos = i + 1;
			continue;
		}
		const replacement = get_escaped_char(str[i]);
		if (replacement) {
			result += str.slice(last_pos, i) + replacement;
			last_pos = i + 1;
		}
	}

	return `"${last_pos === 0 ? str : result + str.slice(last_pos)}"`;
}

/**
 * Emits executable source for a primitive value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringify_primitive(value) {
	if (typeof value === 'string') return stringify_string(value);
	if (value === undefined) return 'void 0';
	if (value === 0 && 1 / value < 0) return '-0';
	if (typeof value === 'number') return String(value).replace(/^(-)?0\./, '$1.');
	if (typeof value === 'bigint') return `${value}n`;
	return String(value);
}

/** @param {Record<string | symbol, any>} object */
export function enumerable_symbols(object) {
	// Own symbols always have a descriptor; the optional chain only satisfies the lib's
	// `PropertyDescriptor | undefined` return type.
	return Object.getOwnPropertySymbols(object).filter(
		(symbol) => Object.getOwnPropertyDescriptor(object, symbol)?.enumerable
	);
}

const is_identifier = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;

/** @param {string} key */
export function stringify_key(key) {
	return is_identifier.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']';
}

/** @param {number} n */
export function is_valid_array_index(n) {
	if (!Number.isInteger(n)) return false;
	if (n < 0) return false;
	if (n > MAX_ARRAY_INDEX) return false;
	return true;
}

/** @param {number} n */
export function is_valid_array_len(n) {
	if (!Number.isInteger(n)) return false;
	if (n < 0) return false;
	if (n > MAX_ARRAY_LEN) return false;
	return true;
}

/** @param {string} s */
function is_valid_array_index_string(s) {
	if (s.length === 0) return false;
	if (s.length > 1 && s.charCodeAt(0) === 48) return false; // leading zero
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	// by this point we know it's a string of digits, but it has to be within
	// the range of valid array indices
	return is_valid_array_index(+s);
}

/**
 * Returns the length of the leading run of valid array indices in `keys`.
 * @param {readonly string[]} keys
 */
function array_index_cut(keys) {
	for (var i = keys.length - 1; i >= 0; i--) {
		if (is_valid_array_index_string(keys[i])) {
			break;
		}
	}
	return i + 1;
}

/**
 * Finds the populated indices of an array, as index strings in ascending order.
 * @param {unknown[]} array
 * @returns {string[]}
 */
export function valid_array_indices(array) {
	const keys = Object.keys(array);
	keys.length = array_index_cut(keys);
	return keys;
}

/**
 * Given the own enumerable string keys of an array-like value, in property
 * order, returns the leading run of them that are valid array indices.
 *
 * This is the filtering half of the `indicesOf` stringify operation,
 * exposed so that custom operations — which typically already have the keys
 * in hand, e.g. from a foreign runtime — don't have to reimplement it.
 *
 * Does not modify `keys`.
 *
 * @param {readonly string[]} keys
 * @returns {string[]}
 */
export function filter_array_indices(keys) {
	return keys.slice(0, array_index_cut(keys));
}
