/**
 * One step of the path `stringify` records to the value being serialized,
 * kept raw and formatted only when a `DevalueError` is raised: a property
 * key, an array index, or an already formatted `.get(…)` step of a Map.
 */
export type PathSegment = string | number | { formatted: string };

export type StringValueTag =
	| 'URL'
	| 'URLSearchParams'
	| 'Temporal.Duration'
	| 'Temporal.Instant'
	| 'Temporal.PlainDate'
	| 'Temporal.PlainTime'
	| 'Temporal.PlainDateTime'
	| 'Temporal.PlainMonthDay'
	| 'Temporal.PlainYearMonth'
	| 'Temporal.ZonedDateTime';

export type ViewTag =
	| 'Int8Array'
	| 'Uint8Array'
	| 'Uint8ClampedArray'
	| 'Int16Array'
	| 'Uint16Array'
	| 'Float16Array'
	| 'Int32Array'
	| 'Uint32Array'
	| 'Float32Array'
	| 'Float64Array'
	| 'BigInt64Array'
	| 'BigUint64Array'
	| 'DataView';

export type TypedArray =
	| Int8Array
	| Uint8Array
	| Uint8ClampedArray
	| Int16Array
	| Uint16Array
	| Float16Array
	| Int32Array
	| Uint32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

/**
 * The introspection/extraction operations `stringify` performs on the value
 * being serialized. Every dynamic operation — property reads, prototype
 * method calls, iteration, type classification — goes through this
 * interface, so overriding members lets you control exactly how values are
 * inspected.
 *
 * Use cases:
 * - **Side-effect-free serialization**: replace operations that can execute
 *   user code (getters, proxy traps, patched prototypes, `Symbol.toStringTag`
 *   accessors) with implementations based on captured intrinsics, internal
 *   slots, or property descriptors.
 * - **Foreign-runtime serialization**: serialize values that live in another
 *   JavaScript runtime (a `node:vm` context, a WASM-hosted engine, a remote
 *   process) by implementing the operations over handle objects. The
 *   `stringify` algorithm never touches the value directly, so "value" can
 *   be any opaque token as long as the operations agree on what it means.
 *
 * All members are optional when passed to `stringify` — omitted members fall
 * back to the defaults (native behavior, exported as
 * `defaultStringifyOperations`).
 *
 * Members are named by what they do with the value:
 * - `isXxx`/`hasXxx` — predicates returning booleans
 * - `toXxx` — conversions whose whole result crosses into host JavaScript
 *   (`toPrimitive`, `toISOString`) or into a native container (`toPromise`)
 * - `xxxOf` — queries returning host data *about* the value (`typeOf`,
 *   `tagOf`, `lengthOf`) or its constituents, which remain in value space
 *   (`valuesOf`, `entriesOf`)
 * - `xxxInfo` — multi-field descriptors mixing host data and constituent
 *   values (`viewInfo`, `regExpInfo`)
 * - bare verbs (`get`, `unbox`, `identify`) — accessors whose results remain
 *   in value space
 *
 * (`toStringValue` and `unbox` deliberately avoid the names `toString` and
 * `valueOf`, which would shadow `Object.prototype` methods on the operations
 * object.)
 */
export interface StringifyOperations {
	/**
	 * Returns the key used for deduplication and cycle detection (compared
	 * with `Map` key semantics). Two values that represent the same logical
	 * object must return the same key. Default: the value itself.
	 *
	 * Override this when serializing through handles, where two distinct
	 * handle objects may refer to the same underlying value.
	 *
	 * Keys are compared across *every* value in the payload, including
	 * primitives, so an implementation that derives keys for objects must
	 * make sure they cannot collide with a primitive that appears in the
	 * same payload — returning e.g. the string `'42'` as an object's key
	 * would alias it to the string `'42'` elsewhere in the payload and emit
	 * a wrong back-reference. Prefer keys that are unforgeable, such as the
	 * underlying object itself, a symbol, or a wrapper object.
	 */
	identify(value: any): unknown;

	/**
	 * Classifies a value. Same contract as the `typeof` operator, except
	 * `null` must be reported as `'null'` (not `'object'`).
	 */
	typeOf(value: any):
		| 'undefined'
		| 'null'
		| 'boolean'
		| 'number'
		| 'bigint'
		| 'string'
		| 'symbol'
		| 'function'
		| 'object';

	/**
	 * Extracts the host-JavaScript primitive from a value whose `typeOf` is
	 * `'null'`, `'boolean'`, `'number'`, `'bigint'` or `'string'`.
	 * Default: the value itself (it already is the primitive).
	 */
	toPrimitive(value: any): undefined | null | boolean | number | bigint | string;

	/**
	 * Returns the brand of an object value — the strings produced by
	 * `Object.prototype.toString` without the wrapping (`'Date'`, `'Array'`,
	 * `'Map'`, `'Object'`, `'Temporal.Instant'`, …). This decides which
	 * serialization strategy is used, so hardened implementations should use
	 * engine-level brand checks rather than (spoofable, getter-invoking)
	 * `Symbol.toStringTag` lookups.
	 */
	tagOf(value: any): string;

	/** Returns true if the object value should be treated as a thenable. */
	isThenable(value: any): boolean;

	/**
	 * Converts a thenable into a native promise, whose settled value is then
	 * serialized. The returned promise may reject, in which case
	 * `stringifyAsync` rejects. Only called from `stringifyAsync`, for values
	 * where `isThenable` returned true.
	 */
	toPromise(thenable: any): Promise<any>;

	/**
	 * Extracts the inner value of a boxed primitive (`Number`, `String`,
	 * `Boolean`, `BigInt` objects). Equivalent to `boxed.valueOf()`. The
	 * result is serialized recursively, so it may be a foreign value/handle.
	 */
	unbox(boxed: any): any;

	/**
	 * Returns the ISO string for a `Date` value, or `''` for an invalid
	 * date. Equivalent to `date.toISOString()`.
	 */
	toISOString(date: any): string;

	/**
	 * Returns the string form of a `URL`, `URLSearchParams` or `Temporal.*`
	 * value. Equivalent to `value.toString()`.
	 */
	toStringValue(value: any): string;

	/** Returns the source and flags of a `RegExp` value. */
	regExpInfo(regexp: any): { source: string; flags: string };

	/**
	 * Returns an iterable over the elements of a `Set` value. The iterable
	 * is consumed on the host; elements may be foreign values/handles.
	 */
	valuesOf(set: any): Iterable<any>;

	/**
	 * Returns an iterable over the `[key, value]` entries of a `Map` value.
	 * The iterable is consumed on the host; keys/values may be foreign
	 * values/handles.
	 */
	entriesOf(map: any): Iterable<[any, any]>;

	/**
	 * Returns the view metadata of a typed array or `DataView` value.
	 * `length` is only meaningful for typed arrays. `buffer` is serialized
	 * recursively, so it may be a foreign value/handle.
	 */
	viewInfo(view: any): {
		buffer: any;
		byteOffset: number;
		byteLength: number;
		length?: number;
		bufferByteLength: number;
	};

	/**
	 * Returns a host `ArrayBuffer` with the bytes of an `ArrayBuffer` value.
	 * Default: the value itself. Foreign-runtime implementations should copy
	 * the bytes into a host buffer.
	 */
	toArrayBuffer(buffer: any): ArrayBuffer;

	/** Returns the length of an `Array` value. */
	lengthOf(array: any): number;

	/**
	 * Returns true if a value has an own property at `key`. Same contract as
	 * `Object.hasOwn(value, key)`.
	 */
	hasOwn(value: any, key: string | number): boolean;

	/**
	 * Returns the populated indices of a (sparse) `Array` value as strings,
	 * in ascending order.
	 *
	 * Implementations that already have the value's own enumerable string
	 * keys — as a foreign-runtime implementation typically does — should pass
	 * them through the exported `filterArrayIndices` helper rather than
	 * reimplementing the filtering, which encodes the sparse-array heuristic.
	 *
	 * Equivalent to `Object.keys(array)` filtered to
	 * valid array indices.
	 */
	indicesOf(array: any): string[];

	/**
	 * Classifies a plain-object candidate:
	 * - `{ kind: 'plain' | 'null-proto', keys }` — a serializable POJO and
	 *   its own enumerable string keys
	 * - `{ kind: 'not-plain' }` — a non-POJO (stringify throws)
	 * - `{ kind: 'symbol-keys' }` — a POJO with enumerable symbol keys
	 *   (stringify throws)
	 */
	shapeOf(
		value: any
	):
		| { kind: 'plain' | 'null-proto'; keys: string[] }
		| { kind: 'not-plain' }
		| { kind: 'symbol-keys' };

	/**
	 * Reads a property from an `Array` or plain-object value. Equivalent to
	 * `value[key]`. Hardened implementations can read through property
	 * descriptors to control what happens for accessor properties.
	 */
	get(value: any, key: string | number): any;
}

/** The native JavaScript implementation exported as `defaultStringifyOperations`. */
export interface DefaultStringifyOperations extends StringifyOperations {
	identify(value: any): any;
	toPrimitive(
		value: undefined | null | boolean | number | bigint | string
	): undefined | null | boolean | number | bigint | string;
	toISOString(date: Date): string;
	regExpInfo(regexp: RegExp): { source: string; flags: string };
	valuesOf(set: Set<any>): Set<any>;
	entriesOf(map: Map<any, any>): Map<any, any>;
	viewInfo(view: any): {
		buffer: ArrayBufferLike;
		byteOffset: number;
		byteLength: number;
		length?: number;
		bufferByteLength: number;
	};
	toArrayBuffer(buffer: ArrayBuffer): ArrayBuffer;
	lengthOf(array: any[]): number;
	indicesOf(array: any[]): string[];
}

/** Options for `stringify` and `stringifyAsync`. */
export interface StringifyOptions {
	/**
	 * Overrides for the introspection/extraction operations used while
	 * serializing. Omitted members fall back to `defaultStringifyOperations`.
	 */
	operations?: Partial<StringifyOperations>;
}

/**
 * The construction operations `parse` and `unflatten` perform while reviving
 * a value. Every value the algorithm creates — primitives, built-in
 * instances, containers — and every mutation it performs to populate those
 * containers goes through this interface, so overriding members lets you
 * control exactly what gets built.
 *
 * Use cases:
 * - **Cross-realm revival**: construct values from the intrinsics of a
 *   different realm (e.g. a `node:vm` context) so that the result passes
 *   `instanceof` checks inside that realm.
 * - **Foreign-runtime revival**: build values inside another JavaScript
 *   runtime (a WASM-hosted engine, a remote process) by implementing the
 *   operations over handle objects. The algorithm never inspects the values
 *   it creates — it only passes them back into other operations — so
 *   "value" can be any opaque token.
 *
 * The naming follows the same scheme as `StringifyOperations`, with the
 * host/value-space boundary running the other way:
 *
 * - `fromXxx` — conversions whose input is entirely host data and whose
 *   result crosses into value space; each is the inverse of the
 *   corresponding `toXxx` (`fromPrimitive` / `toPrimitive`,
 *   `fromISOString` / `toISOString`, `fromStringValue` / `toStringValue`,
 *   `fromArrayBuffer` / `toArrayBuffer`).
 * - `fromXxxInfo` — construction from a multi-field descriptor, the inverse
 *   of the corresponding `xxxInfo` (`fromRegExpInfo` / `regExpInfo`,
 *   `fromViewInfo` / `viewInfo`).
 * - `createXxx` — empty value-space containers, populated afterwards by the
 *   mutators. That ordering is what makes cyclic values possible: the empty
 *   container is cached before its contents are revived.
 * - bare verbs — value-space operations whose operands and results stay in
 *   value space (`box` inverts `unbox`, `set` inverts `get`, `addValue`
 *   inverts `valuesOf`, `addEntry` inverts `entriesOf`).
 *
 * All members are optional when passed to `parse`/`unflatten` — omitted
 * members fall back to the defaults (native behavior, exported as
 * `defaultParseOperations`).
 */
export interface ParseOperations {
	/**
	 * Wraps a host primitive (`string`, `number`, `boolean`, `bigint`,
	 * `null`, `undefined`, and the special values `NaN`, `±Infinity`, `-0`)
	 * into the representation the other operations expect. The inverse of
	 * `toPrimitive`. Default: the value itself.
	 */
	fromPrimitive(
		primitive: string | number | boolean | bigint | null | undefined
	): any;

	/**
	 * Creates a `Date` from an ISO string. The inverse of `toISOString`.
	 * An empty string represents an invalid date (as produced for
	 * `new Date(NaN)`).
	 */
	fromISOString(iso: string): any;

	/**
	 * Creates a `URL`, `URLSearchParams` or `Temporal.*` value from its
	 * string form — the same tags `toStringValue` serializes, and its
	 * inverse. `tag` distinguishes them (e.g. `'URL'`,
	 * `'Temporal.Instant'`).
	 */
	fromStringValue(tag: StringValueTag, text: string): any;

	/**
	 * Creates an `ArrayBuffer` from a host `ArrayBuffer` holding the decoded
	 * bytes. The inverse of `toArrayBuffer`. Default: the buffer itself.
	 * Foreign-runtime implementations should copy the bytes into the target
	 * runtime.
	 */
	fromArrayBuffer(buffer: ArrayBuffer): any;

	/**
	 * Creates a `RegExp` from its source and flags. The inverse of
	 * `regExpInfo`. `flags` is `undefined` when the pattern had no flags.
	 */
	fromRegExpInfo(source: string, flags: string | undefined): any;

	/**
	 * Creates a typed array or `DataView` over an already-revived buffer.
	 * The inverse of `viewInfo`. `tag` is the constructor name (e.g.
	 * `'Uint8Array'`, `'DataView'`). `byteOffset` and `length` are
	 * `undefined` when the view spans the whole buffer; otherwise `length`
	 * is the element count for typed arrays and the byte length for
	 * `DataView`, matching the constructor signatures.
	 */
	fromViewInfo(
		tag: ViewTag,
		buffer: any,
		byteOffset: number | undefined,
		length: number | undefined
	): any;

	/**
	 * Creates a boxed primitive object (`Number`, `String`, `Boolean`,
	 * `BigInt` wrapper) around an already-revived inner primitive. The
	 * inverse of `unbox`. Equivalent to `Object(value)`.
	 */
	box(value: any): any;

	/**
	 * Creates an array of the given length, to be populated with `set`.
	 * The length is bounded by the size of the input, so it is safe to
	 * allocate eagerly. Indices that are never set must remain holes.
	 */
	createArray(length: number): any;

	/**
	 * Creates a sparse array of the given length, to be populated with
	 * `set`. Unlike `createArray`, the length comes from the input rather
	 * than being bounded by it, so implementations must not allocate
	 * storage proportional to it.
	 */
	createSparseArray(length: number): any;

	/** Creates an empty object, to be populated with `set`. */
	createObject(): any;

	/**
	 * Creates an empty null-prototype object, to be populated with `set`.
	 * Equivalent to `Object.create(null)`.
	 */
	createNullPrototypeObject(): any;

	/** Creates an empty `Set`, to be populated with `addValue`. */
	createSet(): any;

	/** Creates an empty `Map`, to be populated with `addEntry`. */
	createMap(): any;

	/**
	 * Sets an element or property on a value created by `createArray`,
	 * `createSparseArray`, `createObject` or `createNullPrototypeObject`.
	 * The inverse of `get`, which likewise serves both arrays and objects.
	 */
	set(target: any, key: string | number, value: any): void;

	/** Adds a value to a `Set` created by `createSet`. The inverse of `valuesOf`. */
	addValue(set: any, value: any): void;

	/** Adds an entry to a `Map` created by `createMap`. The inverse of `entriesOf`. */
	addEntry(map: any, key: any, value: any): void;
}

/** The native JavaScript implementation exported as `defaultParseOperations`. */
export interface DefaultParseOperations extends ParseOperations {
	fromPrimitive(
		primitive: string | number | boolean | bigint | null | undefined
	): string | number | boolean | bigint | null | undefined;
	fromISOString(iso: string): Date;
	fromStringValue(tag: StringValueTag, text: string): URL | URLSearchParams | object;
	fromArrayBuffer(buffer: ArrayBuffer): ArrayBuffer;
	fromRegExpInfo(source: string, flags: string | undefined): RegExp;
	fromViewInfo(
		tag: ViewTag,
		buffer: ArrayBufferLike,
		byteOffset: number | undefined,
		length: number | undefined
	): TypedArray | DataView;
	box(value: any): object;
	createArray(length: number): any[];
	createSparseArray(length: number): any[];
	createObject(): Record<string, any>;
	createNullPrototypeObject(): Record<string, any>;
	createSet(): Set<any>;
	createMap(): Map<any, any>;
	addValue(set: Set<any>, value: any): void;
	addEntry(map: Map<any, any>, key: any, value: any): void;
}

/** Options for `parse` and `unflatten`. */
export interface ParseOptions {
	/**
	 * Overrides for the construction operations used while reviving.
	 * Omitted members fall back to `defaultParseOperations`.
	 */
	operations?: Partial<ParseOperations>;
}
