import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_primitive,
	valid_array_indices
} from './utils.js';

/**
 * A direct child of a captured node: the canonical node for a non-primitive value, or the
 * primitive value itself. Nodes are always objects, so `is_node` distinguishes the two
 * without a wrapper allocation.
 * @typedef {CapturedNode | null | undefined | boolean | number | string | bigint} Child
 */
/**
 * A source expression for reaching a non-primitive value created on the client.
 *
 * @typedef {object} ClientPath
 * @property {string} root Expression that evaluates to the reference's starting object.
 * @property {string[]} segments Property-access segments appended to `root`.
 */
/**
 * A captured non-primitive value. Discovery fills `value` through `children`; streaming
 * emission temporarily fills `region_id` through `rendering` while planning its output.
 *
 * The meaning of `keys`, `children`, and `data` depends on `kind`:
 * - `Array`: `keys` are populated index strings, `children` their values, `data` the array length.
 * - `Object` / `NullObject`: `keys` are property names, `children` their values.
 * - `Set`: `children` are the members in insertion order.
 * - `Map`: `children` alternate key, value, key, value, … in insertion order.
 * - ArrayBuffer views and `DataView`: `children[0]` is the buffer; `data` holds `byteOffset`, `byteLength`, `length`.
 * - `Custom`: `children` are the replacer template's holes in order; `data` is the template.
 * - `Async`: no children; `data` is the descriptor plan.
 * - Scalars (`Date`, `RegExp`, boxed primitives, …): no children; `data` is the captured representation.
 *
 * @typedef {object} CapturedNode
 * @property {any} value The original value represented by this node. Its contents are not read again during emission.
 * @property {string} kind The reconstruction tag, such as `Array`, `Map`, `Custom`, or `Async`.
 * @property {string[]} keys Property names or index strings parallel to `children`; empty for other kinds.
 * @property {Child[]} children Direct dependencies needed to reconstruct this value, in reconstruction order.
 * @property {any} data Kind-specific captured representation.
 * @property {number} opaque Number of custom constructors embedding this node; when positive, emission must preserve it as a named value rather than duplicate it inline.
 * @property {number} region_id Identifies the emitted region for which the following planning fields are valid.
 * @property {number} position This node's position in the current emission's child-before-parent order.
 * @property {number} uses Number of references to this node in the current emission.
 * @property {boolean} hoisted Whether this node must be assigned to a temporary variable.
 * @property {boolean} early Whether an empty container must be created before normal declarations.
 * @property {number} latest Furthest declaration position reached by expanding this node inline.
 * @property {string} name Temporary variable name, or an empty string when the node is inlined.
 * @property {boolean} rendering Whether this node is currently being expanded inline.
 */
/**
 * A reusable snapshot of the non-primitive values discovered during one stream session.
 *
 * @typedef {object} CapturedGraph
 * @property {unknown} root_value The initial value, retained to provide context in serialization errors.
 * @property {CapturedNode[]} nodes Every captured non-primitive value, in discovery order.
 * @property {Map<object, CapturedNode>} identities Maps each original non-primitive identity to its canonical node, preserving sharing and cycles.
 * @property {(value: unknown, node: CapturedNode) => void} classify Fills in a reserved node's `kind`, `keys`, `children`, and `data`.
 * @property {string[]} unwind Formatted path segments collected innermost-first while a discovery error propagates.
 */

/** Shared by every node without keys or children; never mutated. @type {never[]} */
const EMPTY = [];

/**
 * Reports whether a child is a captured node rather than a primitive.
 *
 * @param {Child} child
 * @returns {child is CapturedNode}
 */
export function is_node(child) {
	return typeof child === 'object' && child !== null;
}

/**
 * Builds a snapshot of a value and everything it contains. Each non-primitive identity gets one node,
 * even when it appears more than once, and each node records the values it refers to.
 * Later code can therefore generate output from this snapshot without reading the
 * original objects again.
 *
 * Streaming output reuses this graph across multiple emitted values. Before emitting
 * one value, `uneval-stream` walks only the nodes reachable from that value and works
 * out how to reproduce their object identity. A value used once can usually be written
 * inline, while a shared or cyclic value needs a temporary variable so every reference
 * points to the same object. The `region_id` through `rendering` fields on each node hold
 * this per-emission analysis. They are reset for nodes in the current walk; `region_id`
 * distinguishes those results from values left on nodes by previous walks.
 *
 * The graph is append-only. A caller that needs atomic discovery records `nodes.length`
 * before calling `discover` and passes it to `rollback` if discovery throws: every node
 * appended since is removed along with its identity entry, so no per-addition tagging
 * is needed and the success path pays nothing.
 *
 * @param {unknown} root
 * @param {(value: unknown, node: CapturedNode, graph: CapturedGraph) => boolean} custom_classify Fills in the node and returns true, or returns false to use built-in discovery.
 * @returns {CapturedGraph}
 */
export function create_captured_graph(root, custom_classify) {
	/** @type {CapturedGraph} */
	const graph = {
		root_value: root,
		nodes: [],
		identities: new Map(),
		classify: (value, node) => {
			if (!custom_classify(value, node, graph)) builtin_classify(graph, node, value);
		},
		unwind: []
	};
	return graph;
}

/**
 * Removes every node appended since `mark` (a previously observed `nodes.length`) and
 * finalizes the path of the `DevalueError` that interrupted the walk, if any.
 *
 * Containers do not track their position while descending; instead each container's
 * catch handler records its segment as the error unwinds, so the happy path performs no
 * bookkeeping at all. The segments arrive innermost-first and are reversed here.
 *
 * @param {CapturedGraph} graph
 * @param {number} mark
 * @param {unknown} error
 */
export function rollback(graph, mark, error) {
	const nodes = graph.nodes;
	const identities = graph.identities;
	for (let i = nodes.length - 1; i >= mark; i--) identities.delete(nodes[i].value);
	nodes.length = mark;
	const unwind = graph.unwind;
	if (unwind.length) {
		if (error instanceof DevalueError) error.path = unwind.reverse().join('');
		unwind.length = 0;
	}
}

/**
 * Discovers a value into the graph and returns its canonical node, or undefined for primitives.
 * Nested calls from a custom classifier share the walk in progress.
 *
 * @param {CapturedGraph} graph
 * @param {unknown} value
 * @returns {CapturedNode | undefined}
 */
export function discover(graph, value) {
	if (is_primitive(value)) {
		if (typeof value === 'symbol') throw error(graph, 'Cannot stringify a Symbol primitive', value);
		return undefined;
	}

	const identity = /** @type {object} */ (value);
	const existing = graph.identities.get(identity);
	if (existing) return existing;

	/** @type {CapturedNode} */
	const node = {
		value,
		kind: '',
		keys: EMPTY,
		children: EMPTY,
		data: undefined,
		opaque: 0,
		region_id: 0,
		position: 0,
		uses: 0,
		hoisted: false,
		early: false,
		latest: -1,
		name: '',
		rendering: false
	};
	graph.nodes.push(node);
	graph.identities.set(identity, node);
	graph.classify(value, node);
	return node;
}

/**
 * Discovers a child value and returns what its parent should record for it.
 *
 * @param {CapturedGraph} graph
 * @param {unknown} value
 * @returns {Child}
 */
export function child(graph, value) {
	return discover(graph, value) ?? /** @type {Child} */ (value);
}

/**
 * Fills in a reserved node with the built-in reconstruction plan for its value.
 * @param {CapturedGraph} graph
 * @param {CapturedNode} node
 * @param {any} value
 */
function builtin_classify(graph, node, value) {
	if (typeof value === 'function') throw error(graph, 'Cannot stringify a function', value);
	const type = get_type(value);
	node.kind = type;

	switch (type) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			node.data = value.valueOf();
			return;
		case 'Date':
			node.data = /** @type {Date} */ (value).getTime();
			return;
		case 'RegExp': {
			const regexp = /** @type {RegExp} */ (value);
			node.data = { source: regexp.source, flags: regexp.flags };
			return;
		}
		case 'URL':
		case 'URLSearchParams':
		case 'Temporal.Duration':
		case 'Temporal.Instant':
		case 'Temporal.PlainDate':
		case 'Temporal.PlainTime':
		case 'Temporal.PlainDateTime':
		case 'Temporal.PlainMonthDay':
		case 'Temporal.PlainYearMonth':
		case 'Temporal.ZonedDateTime':
			node.data = String(value);
			return;
		case 'ArrayBuffer':
			node.data = new Uint8Array(/** @type {ArrayBuffer} */ (value));
			return;
		case 'Array': {
			const array = /** @type {unknown[]} */ (value);
			const keys = /** @type {string[]} */ (valid_array_indices(array));
			const children = new Array(keys.length);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				try {
					children[i] = child(graph, array[/** @type {any} */ (key)]);
				} catch (e) {
					graph.unwind.push(`[${key}]`);
					throw e;
				}
			}
			node.keys = keys;
			node.children = children;
			node.data = array.length;
			return;
		}
		case 'Set': {
			const children = [];
			for (const member of /** @type {Set<unknown>} */ (value)) children.push(child(graph, member));
			node.children = children;
			return;
		}
		case 'Map': {
			const children = [];
			for (const [key, member] of /** @type {Map<unknown, unknown>} */ (value)) {
				try {
					children.push(child(graph, key), child(graph, member));
				} catch (e) {
					graph.unwind.push(`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`);
					throw e;
				}
			}
			node.children = children;
			return;
		}
		case 'Int8Array':
		case 'Uint8Array':
		case 'Uint8ClampedArray':
		case 'Int16Array':
		case 'Uint16Array':
		case 'Float16Array':
		case 'Int32Array':
		case 'Uint32Array':
		case 'Float32Array':
		case 'Float64Array':
		case 'BigInt64Array':
		case 'BigUint64Array':
		case 'DataView': {
			const view = /** @type {ArrayBufferView & { length?: number }} */ (value);
			node.children = [/** @type {CapturedNode} */ (discover(graph, view.buffer))];
			node.data = { byteOffset: view.byteOffset, byteLength: view.byteLength, length: view.length };
			return;
		}
		default: {
			const object = /** @type {Record<string | symbol, unknown>} */ (value);
			if (!is_plain_object(object)) throw error(graph, 'Cannot stringify arbitrary non-POJOs', value);
			if (enumerable_symbols(object).length) {
				throw error(graph, 'Cannot stringify POJOs with symbolic keys', value);
			}
			node.kind = Object.getPrototypeOf(object) === null ? 'NullObject' : 'Object';
			const keys = Object.keys(object);
			const children = new Array(keys.length);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				if (key === '__proto__') {
					throw error(graph, 'Cannot stringify objects with __proto__ keys', value);
				}
				try {
					children[i] = child(graph, object[key]);
				} catch (e) {
					graph.unwind.push(stringify_key(key));
					throw e;
				}
			}
			node.keys = keys;
			node.children = children;
			return;
		}
	}
}

/**
 * @param {CapturedGraph} graph
 * @param {string} message
 * @param {unknown} value
 */
function error(graph, message, value) {
	// The path is unknown here; enclosing containers append their segments as the error
	// unwinds and `rollback` assembles them.
	return new DevalueError(message, [], value, graph.root_value);
}
