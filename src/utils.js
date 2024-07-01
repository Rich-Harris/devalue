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
	 */
	constructor(message, keys) {
		super(message);
		this.name = 'DevalueError';
		this.path = keys.join('');
	}
}

/** @param {any} thing */
export function is_primitive(thing) {
	return Object(thing) !== thing;
}

const object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(
	Object.prototype
)
	.sort()
	.join('\0');

/** @param {any} thing */
export function is_plain_object(thing) {
	const proto = Object.getPrototypeOf(thing);

	return (
		proto === Object.prototype ||
		proto === null ||
		Object.getOwnPropertyNames(proto).sort().join('\0') === object_proto_names
	);
}

/** @param {any} thing */
export function get_type(thing) {
	return Object.prototype.toString.call(thing).slice(8, -1);
}

const escape_chars = /["<\\\n\r\t\b\f\u2028\u2029\x00-\x1f]/
const u2028_all = /\u2028/g;
const u2029_all = /\u2029/g;
const lt_all = /</g;
/** @param {string} str */
export function stringify_string(str) {
	if (!escape_chars.test(str)){
		return `"${str}"`;
	}

	return JSON.stringify(str)
		.replace(u2028_all, '\\u2028')
		.replace(u2029_all, '\\u2029')
		.replace(lt_all, '\\u003C');
}

/** @param {Record<string | symbol, any>} object */
export function enumerable_symbols(object) {
	return Object.getOwnPropertySymbols(object).filter(
		(symbol) => Object.getOwnPropertyDescriptor(object, symbol).enumerable
	);
}
