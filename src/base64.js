/* Baseline 2025 runtimes */

/**	@type {(array_buffer: ArrayBuffer) => string} */
export function encode_native(array_buffer) {
	return new Uint8Array(array_buffer).toBase64();
}

/**	@type {(base64: string) => ArrayBuffer} */
export function decode_native(base64) {
	return Uint8Array.fromBase64(base64).buffer;
}

/* Node-compatible runtimes */

/** @type {(array_buffer: ArrayBuffer) => string} */
export function encode_buffer(array_buffer) {
	return Buffer.from(array_buffer).toString('base64');
}

/**	@type {(base64: string) => ArrayBuffer} */
export function decode_buffer(base64) {
	return Uint8Array.from(Buffer.from(base64, 'base64')).buffer;
}

/* Legacy runtimes */

/** @type {(array_buffer: ArrayBuffer) => string} */
export function encode_legacy(array_buffer) {
	const array = new Uint8Array(array_buffer);
	let binary = '';

	// the maximum number of arguments to String.fromCharCode.apply
	// should be around 0xFFFF in modern engines
	const chunk_size = 0x8000;
	for (let i = 0; i < array.length; i += chunk_size) {
		const chunk = array.subarray(i, i + chunk_size);
		// `apply` accepts any array-like at runtime; lib types only admit `number[]`.
		binary += String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {unknown} */ (chunk)));
	}

	return btoa(binary);
}

/**	@type {(base64: string) => ArrayBuffer} */
export function decode_legacy(base64) {
	const binary_string = atob(base64);
	const len = binary_string.length;
	const array = new Uint8Array(len);

	for (let i = 0; i < len; i++) {
		array[i] = binary_string.charCodeAt(i);
	}

	return array.buffer;
}

const native = typeof Uint8Array.fromBase64 === 'function';
const buffer = typeof process === 'object' && process.versions?.node !== undefined;

export const encode64 = native ? encode_native : buffer ? encode_buffer : encode_legacy;
export const decode64 = native ? decode_native : buffer ? decode_buffer : decode_legacy;
