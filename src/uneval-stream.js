/**
 * @import {
 *   AsyncSequenceDescriptor,
 *   AsyncValueDescriptor,
 *   ClientReference,
 *   UnevalStreamOptions,
 *   UnevalStreamReplacer,
 *   UnevalStreamResult,
 *   UnevalStreamTail
 * } from './types.js'
 * @import { AsyncNode, CapturedGraph, CapturedNode, Child, ClientPath, ViewKind } from './graph.js'
 * @import { JavaScriptSource } from './javascript-source.js'
 * @import { Emission } from './stream-source.js'
 */

import { DevalueError, get_name, is_primitive, stringify_primitive, stringify_string } from './utils.js';
import { child, create_captured_graph, discover, graph_error_message, is_node, roll_back } from './graph.js';
import { is_source, js, raw_source } from './javascript-source.js';
import {
	RUNTIMES,
	append_reference,
	capture_source,
	complete_expression_source,
	complete_statement_source,
	definitions_source,
	descriptor_source_values,
	describe_received,
	expression_source,
	join_sources,
	map_descriptor_source,
	map_source,
	promise_source,
	reference_source,
	reference_length,
	render_reference,
	render_stream_source_with_names,
	runtime_source,
	source_helpers,
	source_values,
	template_source,
	visit_source_instructions
} from './stream-source.js';

const promise_then = Promise.prototype.then;
/** Original failures wrapped with descriptor interpolation context. @type {WeakMap<object, unknown>} */
const descriptor_error_causes = new WeakMap();

const generic_error = js`new Error("devalue: failed to serialize asynchronous value")`;

/**
 * Stream executable source while preserving identities across asynchronous regions.
 * @param {unknown} value
 * @param {UnevalStreamReplacer} [replacer]
 * @param {UnevalStreamOptions} [options]
 * @returns {Promise<UnevalStreamResult>}
 */
export async function unevalStream(value, replacer, options = {}) {
	if (options.signal?.aborted) throw options.signal.reason;

	const scope = options.scope ?? 'globalThis.__d';
	const id = options.id ?? create_session_id();
	const session = new Session(scope, id, value, replacer, options);
	return session.serialize(value);
}

/** Coordinates transactional graph capture, durable outcome regions, client references, and tail delivery. */
class Session {
	/** Trusted assignable source expression that locates the client session table. @type {string} */
	#scope;
	/** Unescaped, unique identifier for this stream session. @type {string} */
	#id;
	/** User callback that replaces custom values. @type {UnevalStreamReplacer | undefined} */
	#replacer;
	/** Signal that cancels server-side observation and sequence pulling. @type {AbortSignal | undefined} */
	#signal;
	/** Diagnostic callback for asynchronous outcomes that fail to serialize. @type {UnevalStreamOptions['onerror']} */
	#onerror;
	/** Captured identities shared by all emitted regions. @type {CapturedGraph} */
	#graph;
	/** Async descriptor states in discovery order; a capture appends and a failed capture truncates. @type {Source[]} */
	#sources = [];
	/** Index into `#sources` of the first source not yet started. @type {number} */
	#started = 0;
	/** Events collected during the current scheduled flush window. @type {Event[]} */
	#batch = [];
	/** Whether the current batch is eligible to emit when the consumer takes it. @type {boolean} */
	#batch_ready = false;
	/** Wakes the tail generator when a batch is ready or the lifecycle changes. @type {(() => void) | undefined} */
	#wake;
	/** Number of async sources whose terminal client operation has not been generated. @type {number} */
	#active = 0;
	/** Whether a batch finalization is currently scheduled. @type {boolean} */
	#flushing = false;
	/** Scheduled batch finalization handle. @type {ReturnType<typeof setTimeout> | undefined} */
	#flush_handle;
	/** Explicit session lifecycle, independent of source accounting and reason truthiness. @type {Lifecycle} */
	#status = { state: 'preparing' };
	/** Next client anchor index; index zero is reserved for the head root. @type {number} */
	#anchor = 1;
	/** Next client pending index used to store a descriptor's private control. @type {number} */
	#pending = 0;
	/** Next client slot index used when no stable path can retain an identity. @type {number} */
	#slot = 0;
	/** Next client collection index used for a retained Map or Set sidecar. @type {number} */
	#collection = 0;
	/** Stable AbortSignal listener that forwards cancellation. @type {() => void} */
	#abort;
	/** Canonical captured node for the initial graph root. @type {CapturedNode | undefined} */
	#root;
	/** Session helpers already defined in emitted output. @type {Partial<Record<keyof typeof RUNTIMES, boolean>>} */
	#runtimes_emitted = {};
	/** Native promise sources whose terminal operation has not been emitted. @type {number} */
	#native_pending = 0;
	/** Custom nodes captured since the last atomic-cycle validation. @type {CapturedNode[]} */
	#new_custom = [];
	/** Nodes whose opacity was incremented in an active transaction. @type {CapturedNode[]} */
	#opaque_increments = [];
	/** Nodes added to the validated set in active transactions. @type {CapturedNode[]} */
	#validated_additions = [];
	/** Retained-reference heads replaced in active transactions. @type {ReferenceMutation[]} */
	#reference_mutations = [];
	/** Number of nested graph/emission transactions currently active. */
	#transaction_depth = 0;
	/** Custom nodes already proven acyclic. @type {Set<CapturedNode>} */
	#validated = new Set();
	/** Whether the head must define the block dispatch helper. @type {boolean} */
	#emit_dispatch = false;
	/** Shortest retained client paths, linked when a later path improves on an earlier one. @type {Map<CapturedNode, RetainedReference>} */
	#references = new Map();
	/** Ordered client-materialization boundary. Zero denotes the initialized head graph. */
	#availability = 0;
	/** Next coordinated generated lexical name. */
	#name = 0;
	/** Stable generated names for opaque identifier tokens. @type {Map<JavaScriptSource, string>} */
	#identifiers = new Map();
	/** Generated head/table binding visible to custom operation source. */
	#table_name = '';
	/** Generated client-session binding visible to all custom stream source. */
	#session_name = '';
	/** Monotonic owner tag for reusable node planning scratch. */
	#region_id = 0;

	/**
	 * Creates an isolated server-side stream session.
	 *
	 * @param {string} scope
	 * @param {string} id
	 * @param {unknown} root
	 * @param {UnevalStreamReplacer | undefined} replacer
	 * @param {UnevalStreamOptions} options
	 */
	constructor(scope, id, root, replacer, options) {
		const signal = options.signal;
		this.#scope = scope;
		this.#id = id;
		this.#replacer = replacer;
		this.#signal = signal;
		this.#onerror = options.onerror;
		this.#graph = create_captured_graph(root, (graph, node, value) => this.#classify(graph, node, value));
		this.#abort = () => void this.#cancel(signal?.reason, true);
		signal?.addEventListener('abort', this.#abort, { once: true });
	}

	/**
	 * @param {unknown} value
	 * @returns {Promise<UnevalStreamResult>}
	 */
	async serialize(value) {
		try {
			// walk the graph and capture the synchronous values and the first layer of async sources
			this.#capture(value, true);
			this.#active = this.#sources.length;
			if (!this.#is_active()) return await this.#throw_failure(undefined);

			if (this.#sources.length === 0) {
				const head = render_stream_source_with_names(this.#emit_region(value, false), [], 's', this.#render_identifier);
				this.#complete();
				return { head, tail: empty_tail(), id: this.#id };
			}

			this.#initialize_client_names();
			this.#status = { state: 'streaming' };
			// start observing the async sources
			this.#start_sources();
			// Give newly started sources the same host-scheduled flush window used by tail
			// batching. This is an operational scheduling window, not a task-count guarantee.
			do await macrotask();
			while (this.#flushing && this.#is_active());
			if (!this.#is_active()) return await this.#throw_failure(undefined);

			const head_region = this.#emit_region(value, true, 0, 0);
			this.#assign_references(value, { kind: 'anchor', index: 0, segments: [] }, new Map(), 0);
			// anything that settled within the window is folded into the head rather than shipped as a block
			const operations = this.#batch_ready
				? await this.#deliver(this.#take_batch(), false)
				: undefined;

			// if everything resolved in 1 task, then we ended up with a single batch, so we don't need to do anything else
			if (this.#active === 0 && this.#batch.length === 0) {
				const final_operations = operations
					? join_sources([operations, this.#cleanup_source()], ';')
					: this.#cleanup_source();
				const head = this.#wrap_head(head_region, final_operations);
				this.#complete();
				return { head, tail: empty_tail(), id: this.#id };
			}

			this.#emit_dispatch = true;
			return { head: this.#wrap_head(head_region, operations), tail: this.#tail(), id: this.#id };
		} catch (error) {
			return await this.#throw_failure(error);
		}
	}

	/**
	 * Collects helpers reachable from a finished structured block, marks only those helpers
	 * as emitted, and renders the block once with definitions at its explicit prelude point.
	 *
	 * @param {Emission} source
	 * @returns {string}
	 */
	#render_final(source) {
		const definitions = source_helpers(source).filter((key) => !this.#runtimes_emitted[key]);
		for (const key of definitions) this.#runtimes_emitted[key] = true;
		return render_stream_source_with_names(source, definitions, this.#session_name || 's', this.#render_identifier);
	}

	/** Allocates the next compact name in the session's shared custom-visible scope. */
	#next_name() {
		return get_name(this.#name++);
	}

	/** @param {JavaScriptSource} identifier */
	#render_identifier = (identifier) => {
		let name = this.#identifiers.get(identifier);
		if (name === undefined) {
			name = this.#next_name();
			this.#identifiers.set(identifier, name);
		}
		return name;
	};

	/** Reserves stable wrapper bindings before any asynchronous graph source is emitted. */
	#initialize_client_names() {
		if (this.#session_name) return;
		this.#table_name = this.#next_name();
		this.#session_name = this.#next_name();
	}

	/**
	 * Atomically walks a value's devalue-visible graph and discovers async sources.
	 *
	 * A shared transaction checkpoint restores graph nodes, sources, counters, retained
	 * references, validation state, and opacity increments on previously captured nodes.
	 *
	 * @param {unknown} value
	 * @param {boolean} root
	 * @returns {CapturedNode | undefined}
	 */
	#capture(value, root = false) {
		// Primitive capture cannot append graph or source state. Validate it directly so
		// common scalar outcomes do not open even a small graph transaction.
		if (is_primitive(value)) {
			let node;
			try {
				node = discover(this.#graph, value);
			} catch (error) {
				// Symbol discovery still creates graph-owned diagnostic state. Finalize that
				// ownership before exposing the error beyond this top-level capture boundary.
				roll_back(this.#graph, this.#graph.nodes.length, error);
				throw error;
			}
			if (!this.#is_active()) throw this.#terminal_reason();
			if (root) this.#root = node;
			return node;
		}
		const checkpoint = this.#begin_transaction();
		try {
			const node = discover(this.#graph, value);
			this.#validate_new_custom(checkpoint.new_custom);
			if (!this.#is_active()) throw this.#terminal_reason();
			this.#commit_transaction(checkpoint, true);
			if (root) this.#root = node;
			return node;
		} catch (error) {
			this.#roll_back_transaction(checkpoint, error);
			throw error;
		}
	}

	/** Captures mutable state needed to discard provisional graph/emission work. */
	#begin_transaction() {
		this.#transaction_depth++;
		return {
			nodes: this.#graph.nodes.length,
			sources: this.#sources.length,
			new_custom: this.#new_custom.length,
			validated: this.#validated_additions.length,
			opaque: this.#opaque_increments.length,
			references: this.#reference_mutations.length,
			pending: this.#pending,
			native_pending: this.#native_pending,
			active: this.#active,
			availability: this.#availability,
			anchor: this.#anchor,
			slot: this.#slot,
			collection: this.#collection,
			name: this.#name
		};
	}

	/** @param {TransactionCheckpoint} checkpoint @param {boolean} commit_sources */
	#commit_transaction(checkpoint, commit_sources) {
		if (commit_sources) {
			for (let i = checkpoint.sources; i < this.#sources.length; i++) this.#sources[i].committed = true;
		}
		this.#transaction_depth--;
		if (this.#transaction_depth === 0) {
			this.#opaque_increments.length = 0;
			this.#validated_additions.length = 0;
			this.#reference_mutations.length = 0;
		}
	}

	/** @param {TransactionCheckpoint} checkpoint @param {unknown} error */
	#roll_back_transaction(checkpoint, error) {
		for (let i = this.#sources.length - 1; i >= checkpoint.sources; i--) this.#deactivate(this.#sources[i]);
		for (let i = this.#opaque_increments.length - 1; i >= checkpoint.opaque; i--) this.#opaque_increments[i].opaque--;
		this.#opaque_increments.length = checkpoint.opaque;
		for (let i = this.#validated_additions.length - 1; i >= checkpoint.validated; i--) this.#validated.delete(this.#validated_additions[i]);
		this.#validated_additions.length = checkpoint.validated;
		for (let i = this.#reference_mutations.length - 1; i >= checkpoint.references; i--) {
			const mutation = this.#reference_mutations[i];
			if (mutation.previous) this.#references.set(mutation.node, mutation.previous);
			else this.#references.delete(mutation.node);
		}
		this.#reference_mutations.length = checkpoint.references;
		this.#sources.length = checkpoint.sources;
		this.#new_custom.length = checkpoint.new_custom;
		this.#pending = checkpoint.pending;
		this.#native_pending = checkpoint.native_pending;
		this.#active = checkpoint.active;
		this.#availability = checkpoint.availability;
		this.#anchor = checkpoint.anchor;
		this.#slot = checkpoint.slot;
		this.#collection = checkpoint.collection;
		this.#name = checkpoint.name;
		try {
			roll_back(this.#graph, checkpoint.nodes, descriptor_graph_error(error));
		} finally {
			// Diagnostic finalization must not strand nested transaction bookkeeping.
			this.#transaction_depth--;
		}
	}

	/** Records an opaque constructor dependency with rollback support. @param {CapturedNode} node */
	#make_opaque(node) {
		node.opaque++;
		if (this.#transaction_depth > 0) this.#opaque_increments.push(node);
	}

	/**
	 * Rejects direct cycles among atomic custom and async constructors, validating only
	 * nodes discovered since the previous validation. Edges are immutable once captured,
	 * so a new cycle always passes through a newly captured node.
	 */
	#validate_new_custom(start = 0) {
		if (this.#new_custom.length === start) return;
		/** @type {Set<CapturedNode>} */
		const validating = new Set();
		/** @type {Set<CapturedNode>} */
		const validated = new Set();
		/** @param {CapturedNode} node */
		const validate = (node) => {
			if (this.#validated.has(node) || validated.has(node)) return;
			if (validating.has(node)) throw this.#error('Cannot stringify an atomic custom cycle', node.value);
			validating.add(node);
			for (const child of node.children) {
				if (is_node(child) && is_atomic(child)) validate(child);
			}
			validating.delete(node);
			validated.add(node);
		};
		for (let i = start; i < this.#new_custom.length; i++) validate(this.#new_custom[i]);
		this.#new_custom.length = start;
		for (const node of validated) {
			if (this.#validated.has(node)) continue;
			this.#validated.add(node);
			if (this.#transaction_depth > 0) this.#validated_additions.push(node);
		}
	}

	/**
	 * Attempts to classify a node as a user replacement, native Promise, or native
	 * AsyncIterable, filling the node in place. Returning false delegates to graph's
	 * built-in discovery.
	 *
	 * @param {CapturedGraph} graph
	 * @param {CapturedNode} node
	 * @param {unknown} value
	 * @returns {boolean}
	 */
	#classify(graph, node, value) {
		if (!this.#is_active()) throw this.#terminal_reason();
		if (this.#replacer) {
			const result = this.#replacer(value, js);
			if (!this.#is_active()) throw this.#terminal_reason();
			if (is_source(result)) {
				const values = source_values(result);
				const children = new Array(values.length);
				for (let i = 0; i < values.length; i++) {
					const captured = child(graph, values[i]);
					children[i] = captured;
					if (is_node(captured)) this.#make_opaque(captured);
				}
				node.kind = 'Custom';
				node.children = children;
				node.data = result;
				this.#new_custom.push(node);
				return true;
			}
			if (result === undefined || result === null || result === false) {
				// Explicitly the complete fallback set. Every other result is validated below.
			} else if (typeof result === 'object' && Object.hasOwn(result, 'type') && result.type === 'async-value') {
				const source = this.#validate_value_descriptor(result);
				this.#add_source(node, result, 'value', false, source);
				return true;
			} else if (typeof result === 'object' && Object.hasOwn(result, 'type') && result.type === 'async-sequence') {
				const source = this.#validate_sequence_descriptor(result);
				this.#add_source(node, result, 'sequence', false, source);
				return true;
			} else {
				throw new TypeError(`Invalid unevalStream replacer result: received ${describe_received(result)}. Return a js tagged template, a descriptor with its own type of "async-value" or "async-sequence", or undefined, null, or false to serialize normally. The replacer must be synchronous; Promise results are not supported.`);
			}
		}

		if (typeof value === 'object' && value !== null) {
			/** @type {{ active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void } | undefined} */
			let observer;
			if (is_native_promise(value)) try {
				/** @type {{ active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void }} */
				const current = observer = { active: true };
				/**
				 * Forwards a native Promise fulfillment while its provisional observer is active.
				 *
				 * @param {unknown} result
				 */
				const resolve = (result) => current.active && current.dispatch?.('resolve', result);
				/**
				 * Forwards a native Promise rejection while its provisional observer is active.
				 *
				 * @param {unknown} reason
				 */
				const reject = (reason) => current.active && current.dispatch?.('reject', reason);
				const observed = promise_then.call(
					value,
					resolve,
					reject
				);
				promise_then.call(observed, undefined, () => {});
			} catch {
				observer = undefined;
			}
			if (observer) {
				const descriptor = this.#native_descriptor(/** @type {Promise<unknown>} */ (value));
				try {
					const source = this.#add_source(node, descriptor, 'native', true, value);
					source.observer = observer;
					observer.dispatch = (type, result) => {
						if (!source.active) return;
						if (source.started) this.#event(source, type, result);
						else source.early = [type, result];
					};
					this.#native_pending++;
				} catch (error) {
					observer.active = false;
					throw error;
				}
				return true;
			}

			if (Symbol.asyncIterator in value) {
				this.#add_source(node, this.#native_sequence_descriptor(value), 'sequence', true, value);
				return true;
			}
		}
		return false;
	}

	/**
	 * Constructs an async descriptor target once, fills the node as `Async`, and stages
	 * its server source state.
	 *
	 * @param {CapturedNode} node
	 * @param {any} descriptor
	 * @param {'value' | 'sequence' | 'native'} type
	 * @param {boolean} [immediate] Whether this private adapter invokes its outcome exactly once immediately.
	 * @param {unknown} [context] Source value already read during descriptor validation.
	 * @returns {Source}
	 */
	#add_source(node, descriptor, type, immediate = false, context) {
		let capture_called = false;
		const pending = this.#pending;
		/** @param {JavaScriptSource} expression */
		const control = (expression) => {
			if (capture_called) throw new TypeError('devalue: capture may only be called once per async descriptor construct(); capture one js expression containing all private controls, such as js`[resolve,reject]`');
			if (!is_source(expression)) throw new TypeError(`Invalid async descriptor capture: capture() received ${describe_received(expression)}. Pass an expression built with the js tagged template, not a raw value or source string.`);
			capture_called = true;
			return capture_source(pending, expression, immediate);
		};
		const source = descriptor.construct(control);
		if (!this.#is_active()) throw this.#terminal_reason();
		if (!is_source(source)) throw new TypeError(`Invalid async descriptor construct result: construct() returned ${describe_received(source)}. It must synchronously return a js tagged template representing the client construction expression.`);
		// Reserve the control index and provisional source before recursive hole discovery.
		this.#pending = pending + 1;
		// `node` is reserved but unclassified; this call classifies it, so the cast records
		// the mutation that TypeScript cannot follow.
		const async_node = /** @type {AsyncNode} */ (node);
		/** @type {Source} */
		const state = { node: async_node, descriptor, context, type, immediate, committed: false, started: false, terminal: false, active: true };
		async_node.kind = 'Async';
		async_node.data = { source, pending, captured: false, state };
		this.#sources.push(state);
		const entries = descriptor_source_values(source);
		const children = new Array(entries.length);
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			let captured;
			try {
				captured = child(this.#graph, entry.value);
			} catch (error) {
				throw descriptor_interpolation_error(error, entry.value, entry.capture ? 'async descriptor capture()' : 'async descriptor construct()', entry.index, true, descriptor_error_detail(this.#graph, error));
			}
			children[i] = captured;
			if (is_node(captured)) this.#make_opaque(captured);
		}
		async_node.children = children;
		let contains_capture = false;
		visit_source_instructions(source, (instruction) => {
			if (instruction.type === 'capture' && instruction.pending === pending) contains_capture = true;
		});
		async_node.data.captured = capture_called && (descriptor.manages_pending || contains_capture);
		this.#new_custom.push(async_node);
		if (this.#signal?.aborted) throw this.#signal.reason;
		return state;
	}

	/**
	 * Discovers and eagerly materializes every ordinary value hole in a returned
	 * descriptor fragment. The caller commits only after adding the prerequisites
	 * and lowered operation to ordered output.
	 *
	 * @param {JavaScriptSource} source
	 * @param {string} context
	 * @param {number} retained_at
	 */
	#lower_descriptor_source(source, context, retained_at) {
		const entries = descriptor_source_values(source);
		if (entries.length === 0) return { prerequisites: [], source };
		if (entries.every((entry) => is_primitive(entry.value))) {
			const lowered = map_descriptor_source(source, (value, index) => {
				if (typeof value === 'symbol') throw descriptor_interpolation_error(undefined, value, context, index);
				return stringify_primitive(/** @type {null | undefined | boolean | number | string | bigint} */ (value));
			});
			return { prerequisites: [], source: lowered };
		}
		const checkpoint = this.#begin_transaction();
		try {
			/** @type {Map<object, CapturedNode>} */
			const nodes = new Map();
			for (const entry of entries) {
				try {
					const node = discover(this.#graph, entry.value);
					if (node) nodes.set(/** @type {object} */ (entry.value), node);
				} catch (error) {
					throw descriptor_interpolation_error(error, entry.value, context, entry.index, true, descriptor_error_detail(this.#graph, error));
				}
			}
			this.#validate_new_custom(checkpoint.new_custom);
			if (!this.#is_active()) throw this.#terminal_reason();
			this.#active += this.#sources.length - checkpoint.sources;

			/** One eager binding per ordinary object identity in this operation. @type {Map<CapturedNode, JavaScriptSource>} */
			const bindings = new Map();
			/** @type {Emission[]} */
			const prerequisites = [];
			// Arbitrary descriptor payloads are materialized immediately before these
			// prerequisites, so their retained identities already exist at this event boundary.
			for (const entry of entries) {
				if (is_primitive(entry.value)) continue;
				const node = nodes.get(/** @type {object} */ (entry.value));
				if (!node || bindings.has(node)) continue;
				const retained = this.#reference_at(node, retained_at);
				/** @type {Emission} */
				let expression;
				if (retained) {
					expression = reference_source(node, retained.path);
				} else {
					const region = this.#emit_region(node.value, true, retained_at, retained_at);
					this.#resolve_references(region, retained_at);
					const index = this.#anchor++;
					const path = { kind: /** @type {const} */ ('anchor'), index, segments: [] };
					this.#assign_references(node.value, path, new Map(), retained_at);
					expression = join_sources([`${this.#session_name}.a[${index}]=`, region]);
				}
				const local = this.#next_name();
				prerequisites.push(join_sources([`const ${local}=`, expression]));
				bindings.set(node, raw_source(local));
			}

			const lowered = map_descriptor_source(source, (value, index) => {
				if (is_primitive(value)) {
					if (typeof value === 'symbol') throw descriptor_interpolation_error(undefined, value, context, index);
					return stringify_primitive(value);
				}
				const node = nodes.get(/** @type {object} */ (value));
				const binding = node && bindings.get(node);
				if (!binding) throw this.#error('Cannot stringify value: a descriptor template hole was not captured before lowering (internal emitter error)', value);
				return binding;
			});
			return { checkpoint, prerequisites, source: lowered };
		} catch (error) {
			this.#roll_back_transaction(checkpoint, error);
			throw error;
		}
	}

	/**
	 * @param {Promise<unknown>} promise
	 * @returns {AsyncValueDescriptor & { manages_pending: true }}
	 */
	#native_descriptor(promise) {
		let pending = -1;
		/**
		 * @param {ClientReference} reference
		 * @param {0 | 1} which `0` resolves, `1` rejects.
		 * @param {JavaScriptSource} value
		 */
		const settle = (reference, which, value) => {
			const remaining = this.#native_pending--;
			if (this.#runtimes_emitted.r || remaining >= 3) {
				return js`${runtime_source('r')}(${pending},${which},${value})`;
			}
			return js`${reference.control}[${which}](${value});delete ${reference.control}`;
		};
		return {
			type: 'async-value',
			source: promise,
			manages_pending: true,
			construct: (capture) => {
				capture(js`[a,b]`);
				pending = this.#pending;
				return promise_source(pending);
			},
			resolve: (reference, value) => settle(reference, 0, value),
			reject: (reference, reason) => settle(reference, 1, reason)
		};
	}

	/**
	 * @param {object} source
	 * @returns {AsyncSequenceDescriptor}
	 */
	#native_sequence_descriptor(source) {
		return {
			type: 'async-sequence',
			source: /** @type {AsyncIterable<unknown, unknown, unknown>} */ (source),
			construct: (capture) => js`${runtime_source('f')}(g=>{${capture(js`g`)}})`,
			next: ({ control }, value) => js`${control}(0,${value})`,
			complete: ({ control }, value) => js`${control}(1,${value})`,
			error: ({ control }, reason) => js`${control}(2,${reason})`
		};
	}

	/**
	 * Validates the synchronous shape of a one-shot async descriptor without observing its source.
	 *
	 * @param {any} descriptor
	 */
	#validate_value_descriptor(descriptor) {
		const source = descriptor.source;
		if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
			throw new TypeError(`Invalid async-value source: received ${describe_received(source)}. The source must be a Promise or a Promise-like object or function with a callable then method.`);
		}
		for (const key of ['construct', 'resolve', 'reject']) {
			const method = descriptor[key];
			if (typeof method !== 'function') throw new TypeError(`Invalid async-value ${key}: received ${describe_received(method)}. The descriptor must provide a ${key}() function.`);
		}
		const cancel = descriptor.cancel;
		if (cancel !== undefined && typeof cancel !== 'function') {
			throw new TypeError(`Invalid async-value cancel: received ${describe_received(cancel)}. Omit cancel or provide a cleanup function.`);
		}
		return source;
	}

	/**
	 * Validates the synchronous shape of an async sequence descriptor without acquiring an iterator.
	 *
	 * @param {any} descriptor
	 */
	#validate_sequence_descriptor(descriptor) {
		const source = descriptor.source;
		if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
			throw new TypeError(`Invalid async-sequence source: received ${describe_received(source)}. The source must be an async iterable with a callable Symbol.asyncIterator method.`);
		}
		for (const key of ['construct', 'next', 'complete', 'error']) {
			const method = descriptor[key];
			if (typeof method !== 'function') throw new TypeError(`Invalid async-sequence ${key}: received ${describe_received(method)}. The descriptor must provide a ${key}() function.`);
		}
		const cancel = descriptor.cancel;
		if (cancel !== undefined && typeof cancel !== 'function') {
			throw new TypeError(`Invalid async-sequence cancel: received ${describe_received(cancel)}. Omit cancel or provide a cleanup function.`);
		}
		return source;
	}

	/** Starts every committed source unless the constructor's AbortSignal listener has cancelled the session. */
	#start_sources() {
		if (this.#signal?.aborted) {
			void this.#cancel(this.#signal.reason, true);
			return;
		}
		this.#start_unstarted();
	}

	/** Starts every source appended since the previous call. */
	#start_unstarted() {
		const sources = this.#sources;
		const end = sources.length;
		for (let i = this.#started; i < end && this.#is_active(); i++) this.#start(sources[i]);
		this.#started = end;
	}

	/**
	 * Starts observation or iteration for one committed source exactly once.
	 *
	 * @param {Source} source
	 */
	#start(source) {
		if (source.started || !this.#is_active()) return;
		source.started = true;
		if (source.type === 'sequence') {
			this.#start_sequence(source);
			return;
		}
		if (source.type === 'native') {
			if (source.early) this.#event(source, source.early[0], source.early[1]);
			return;
		}
		try {
			const then = source.descriptor.source.then;
			if (!this.#is_active()) return;
			if (typeof then !== 'function') throw new TypeError('then is not callable');
			new Promise((resolve, reject) => {
				try {
					then.call(source.descriptor.source, resolve, reject);
				} catch (error) {
					reject(error);
				}
			}).then(
				(value) => this.#event(source, 'resolve', value),
				(reason) => this.#event(source, 'reject', reason)
			);
		} catch (error) {
			this.#event(source, 'reject', error);
		}
	}

	/**
	 * Acquires and validates an async iterator, then begins its first bounded pull.
	 *
	 * @param {Source} source
	 */
	#start_sequence(source) {
		source.acquiring = true;
		try {
			const method = source.descriptor.source[Symbol.asyncIterator];
			if (!this.#is_active()) return this.#finish_acquisition(source);
			if (typeof method !== 'function') throw new TypeError('async iterator is not callable');
			const iterator = method.call(source.descriptor.source);
			if ((typeof iterator !== 'object' || iterator === null) && typeof iterator !== 'function') {
				throw new TypeError('async iterator is not an object');
			}
			source.iterator = iterator;
			if (!this.#is_active()) return this.#finish_acquisition(source);
			const next = iterator.next;
			if (!this.#is_active()) return this.#finish_acquisition(source);
			if (typeof next !== 'function') throw new TypeError('async iterator next is not callable');
			source.next = next;
			source.acquiring = false;
			this.#pull(source);
		} catch (error) {
			source.acquiring = false;
			if (this.#is_active()) this.#event(source, 'error', error);
			else {
				this.#close_sequence(source);
				this.#cancel_source(source);
			}
		}
	}

	/**
	 * Completes reentrant iterator acquisition after cancellation in return-before-cancel order.
	 * @param {Source} source
	 */
	#finish_acquisition(source) {
		source.acquiring = false;
		this.#close_sequence(source);
		this.#cancel_source(source);
	}

	/**
	 * Performs at most one outstanding sequence pull and converts its result into a raw event.
	 *
	 * @param {Source} source
	 */
	#pull(source) {
		// `next` is set by #start_sequence before the first pull, and later pulls are only
		// triggered by 'next' events, which require an earlier successful pull.
		const next = source.next;
		if (!next || source.terminal || source.pulling || !this.#is_active()) return;
		source.pulling = true;
		const finish = () => {
			source.pulling = false;
		};
		let result;
		try {
			result = next.call(source.iterator);
		} catch (error) {
			finish();
			this.#event(source, 'error', error);
			return;
		}
		Promise.resolve(result).then(
			(result) => {
				finish();
				if (source.terminal || !this.#is_active()) return;
				try {
					if ((typeof result !== 'object' || result === null) && typeof result !== 'function') {
						throw new TypeError('async iterator result is not an object');
					}
					const done = result.done;
					const value = result.value;
					this.#event(source, done ? 'complete' : 'next', value);
				} catch (error) {
					this.#event(source, 'error', error);
				}
			},
			(error) => {
				finish();
				this.#event(source, 'error', error);
			}
		);
	}

	/**
	 * Walks an observed async outcome and queues it in monotonic observation order.
	 *
	 * @param {Source} source
	 * @param {Event['type']} type
	 * @param {unknown} value
	 */
	#event(source, type, value) {
		if (source.terminal || !this.#is_active()) return;
		if (type !== 'next') {
			source.terminal = true;
		}
		const event = { source, type, value, invalid: false };
		const source_count = this.#sources.length;
		try {
			this.#capture(value);
			this.#active += this.#sources.length - source_count;
		} catch (error) {
			if (!this.#is_active()) return;
			this.#report(error, value);
			if (!this.#is_active()) return;
			event.type = source.type === 'sequence' ? 'error' : 'reject';
			event.value = undefined;
			event.invalid = true;
		}
		this.#batch.push(event);
		if (!this.#flushing) {
			this.#flushing = true;
			this.#flush_handle = setTimeout(() => this.#flush(), 0);
		}
		// Iterators contribute at most one item to each batch. The next pull starts when
		// this batch is consumed, preventing an immediately-ready iterator from starving
		// other sources or growing the head without bound.
	}

	/**
	 * Marks a batch's events as emitted and resumes sequence pulling. A sequence only pulls
	 * once its previous `next` event is consumed, so each sequence has at most one
	 * unconsumed `next` event and every such event resumes exactly one pull.
	 *
	 * @param {Event[]} events
	 */
	#consume(events) {
		for (const event of events) {
			if (event.type === 'next') this.#pull(event.source);
		}
	}

	/** Makes the current ordered events eligible for delivery and wakes the tail. */
	#flush() {
		this.#flushing = false;
		this.#flush_handle = undefined;
		if (!this.#is_active() || this.#batch.length === 0) return;
		this.#batch_ready = true;
		this.#notify();
	}

	/**
	 * Takes the ready batch. Until this happens, later events may still join it.
	 *
	 * @returns {Event[]}
	 */
	#take_batch() {
		const events = this.#batch;
		this.#batch = [];
		this.#batch_ready = false;
		return events;
	}

	/**
	 * Renders a batch, closes any sequences that failed within it, starts sources discovered by
	 * it, and resumes pulling. Generation failures are fatal and cancel the session.
	 *
	 * @param {Event[]} events
	 * @param {boolean} block whether to wrap the operations as a standalone tail block
	 * @returns {Promise<Emission>}
	 */
	async #deliver(events, block) {
		try {
			const emitted = this.#emit_batch(events, block);
			if (!this.#is_active()) return await this.#throw_failure(undefined);
			for (const source of emitted.close) this.#close_failed_sequence(source);
			this.#start_unstarted();
			this.#consume(events);
			if (!this.#is_active()) return await this.#throw_failure(undefined);
			const source = block ? this.#render_final(emitted.source) : emitted.source;
			if (block && this.#active === 0 && this.#batch.length === 0) this.#complete();
			return source;
		} catch (error) {
			return await this.#throw_failure(error);
		}
	}

	/**
	 * Emits one walked graph region, optionally retaining references for future regions.
	 *
	 * @param {unknown} value
	 * @param {boolean} persistent
	 * @param {number} [available] Paths usable while constructing this region.
	 * @param {number} [retained_at] Boundary after which paths created by this region exist.
	 * @returns {Emission}
	 */
	#emit_region(value, persistent, available = this.#availability, retained_at = available) {
		// A primitive region has neither graph planning nor unresolved source dependencies.
		if (is_primitive(value)) {
			if (typeof value === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', value);
			return stringify_primitive(value);
		}
		const identities = this.#graph.identities;
		const region_id = ++this.#region_id;
		/** @type {CapturedNode[]} */
		const order = [];
		/** @param {CapturedNode} node */
		const visit = (node) => {
			if (this.#reference_at(node, available) || node.region_id === region_id) return;
			node.region_id = region_id;
			node.uses = 0;
			node.hoisted = false;
			node.early = false;
			node.latest = -1;
			node.name = '';
			node.rendering = false;
			// Post-order: children are declared before parents so declarations can embed
			// them as literals; only back-edges (cycles) need post-declaration patches.
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) visit(child);
			}
			node.position = order.push(node) - 1;
		};
		const root_node = is_primitive(value) ? undefined : identities.get(/** @type {object} */ (value));
		if (root_node) visit(root_node);

		// In-region use counts; a node used once can be inlined at its single use site.
		// Persistent Set/Map sidecars re-reference each retained element, so those
		// elements must be hoisted names rather than duplicated inline literals.
		if (root_node?.region_id === region_id) root_node.uses++;
		for (const node of order) {
			const weight = persistent && (node.kind === 'Set' || node.kind === 'Map') ? 2 : 1;
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child) && child.region_id === region_id) child.uses += weight;
			}
		}

		/** @param {CapturedNode} node */
		const is_sparse = (node) => node.kind === 'Array' && node.keys.length !== node.data;
		let hoisted_count = 0;
		for (const node of order) {
			if (node.uses > 1 || node.opaque > 0 || node.kind === 'NullObject' || is_sparse(node)) {
				node.hoisted = true;
				hoisted_count++;
			}
		}

		// Containers that must be declared (empty) ahead of every literal declaration
		// because an atomic node's constructor needs their name before their post-order slot.
		/**
		 * Reports whether a child's expansion reaches a name declared at or after `limit`.
		 *
		 * @param {CapturedNode} node
		 * @param {number} limit
		 * @param {Set<CapturedNode>} seen
		 * @returns {boolean}
		 */
		const references_later = (node, limit, seen) => {
			if (node.region_id !== region_id) return false;
			if (node.hoisted) return node.early ? false : node.position >= limit;
			if (seen.has(node)) return false;
			seen.add(node);
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child) && references_later(child, limit, seen)) return true;
			}
			return false;
		};
		// Atomic nodes (customs, views) embed child expressions in their declaration and
		// cannot defer them to fills. A direct container child whose expansion reaches a name
		// declared at or after the atomic is hoisted (its back-edges become fills); a direct
		// child that is itself a later-declared hoisted container is declared empty up front;
		// a direct atomic child is secured recursively (atomics cannot defer anything).
		/** @param {CapturedNode} node */
		const secure_atomic = (node) => {
			const limit = node.position;
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (!is_node(child) || child.region_id !== region_id) continue;
				if (child.hoisted) {
					if (!child.early && child.position >= limit) child.early = true;
					continue;
				}
				if (!references_later(child, limit, new Set())) continue;
				if (is_atomic(child)) secure_atomic(child);
				child.hoisted = true;
				hoisted_count++;
			}
		};
		for (const node of order) {
			if (node.hoisted && is_atomic(node)) secure_atomic(node);
		}

		// `hoisted` and `early` are final now, so "does this child's expansion reach a
		// name declared at or after position `limit`?" reduces to one memoized number per
		// node: the latest declaration position its inline expansion can reach. Children
		// precede parents in post-order, and any back-edge target is necessarily hoisted
		// (a cycle entry always has two or more uses), so one bottom-up pass suffices.
		/**
		 * @param {Child} child
		 * @returns {number}
		 */
		const latest_of = (child) => {
			if (!is_node(child) || child.region_id !== region_id) return -1;
			if (child.hoisted) return child.early ? -1 : child.position;
			return child.latest;
		};
		if (hoisted_count > 0) {
			for (const node of order) {
				if (node.hoisted) continue;
				let reach = -1;
				const children = node.children;
				for (let i = 0; i < children.length; i++) {
					const value = latest_of(children[i]);
					if (value > reach) reach = value;
				}
				node.latest = reach;
			}
		}

		for (const node of order) if (node.hoisted) node.name = this.#next_name();

		/** Population that must wait for a later declaration (a genuine back-edge). @type {Emission[]} */
		const deferred_fill = [];
		/** @type {Emission[]} */
		const sidecars = [];
		/** Best paths fully traversed while retaining stable descendants at this boundary. @type {Map<CapturedNode, number>} */
		const retained_seen = new Map();
		/** @type {Emission[]} */
		const slots = [];
		/**
		 * Renders a raw value interpolated by a custom replacer template.
		 *
		 * @param {unknown} thing
		 * @returns {Emission}
		 */
		const expression = (thing) => {
			if (is_primitive(thing)) {
				if (typeof thing === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', thing);
				return stringify_primitive(thing);
			}
			const node = identities.get(/** @type {object} */ (thing));
			if (!node) throw this.#error('Cannot stringify value: a custom template hole was not discovered in the captured graph; do not change template holes after the replacer returns', thing);
			return expression_node(node);
		};
		/**
		 * @param {CapturedNode} node
		 * @returns {Emission}
		 */
		const expression_node = (node) => {
			const retained = this.#reference_at(node, available);
			if (retained && node.region_id !== region_id) {
				return reference_source(node, retained.path);
			}
			if (node.region_id === region_id && node.name) return node.name;
			// `rendering` guards against unexpected re-entry while expanding inline.
			if (node.rendering) throw this.#error('Cannot stringify value: inline construction re-entered the same node without a declared reference (internal emitter error)', node.value);
			node.rendering = true;
			try {
				return inline(node);
			} finally {
				node.rendering = false;
			}
		};
		/** @param {Child} child */
		const expression_child = (child) => {
			if (is_node(child)) return expression_node(child);
			if (typeof child === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', child);
			return stringify_primitive(child);
		};

		/** @param {Child[]} children */
		const set_literal = (children) => children.length
			? join_sources(['new Set([', join_sources(children.map(expression_child), ','), '])'])
			: 'new Set';
		/** @param {Child[]} children */
		const map_literal = (children) => {
			if (children.length === 0) return 'new Map';
			/** @type {Emission[]} */
			const entries = [];
			for (let i = 0; i < children.length; i += 2) {
				entries.push(join_sources(['[', expression_child(children[i]), ',', expression_child(children[i + 1]), ']']));
			}
			return join_sources(['new Map([', join_sources(entries, ','), '])']);
		};

		/**
		 * Emits the full construction of a single-use node at its use site.
		 *
		 * @param {CapturedNode} node
		 * @returns {Emission}
		 */
		const inline = (node) => {
			const children = node.children;
			switch (node.kind) {
				case 'Array':
					return join_sources(['[', join_sources(children.map(expression_child), ','), ']']);
				case 'Object': {
					const keys = node.keys;
					/** @type {Emission[]} */
					const properties = [];
					for (let i = 0; i < keys.length; i++) {
						properties.push(join_sources([`${literal_key(keys[i])}:`, expression_child(children[i])]));
					}
					return join_sources(['{', join_sources(properties, ','), '}']);
				}
				case 'Set':
					return set_literal(children);
				case 'Map':
					return map_literal(children);
				case 'Async':
					return node.data.state.immediate
						? expression_source(map_descriptor_source(node.data.source, expression))
						: complete_expression_source(map_descriptor_source(node.data.source, expression));
				case 'Custom':
					return complete_expression_source(map_source(node.data, expression));
				default:
					return scalar(node, expression_child);
			}
		};

		/** Statements in construction order, before sidecars and persistent slots. @type {Emission[]} */
		const construction = [];
		/** Adjacent declarations waiting to be emitted as one compact `let`. @type {Emission[]} */
		let declarations = [];
		const flush_declarations = () => {
			if (declarations.length === 0) return;
			construction.push(join_sources(['let ', join_sources(declarations, ',')]));
			declarations = [];
		};
		/** Emits the ready ordered prefix now and keeps the suffix for back-edge patching. @param {{ source: Emission, ready: boolean }[]} entries */
		const populate = (entries) => {
			let deferred = false;
			for (const entry of entries) {
				if (!entry.ready) deferred = true;
				if (deferred) deferred_fill.push(entry.source);
				else {
					flush_declarations();
					construction.push(entry.source);
				}
			}
		};
		/**
		 * Creates ordered fills for an already allocated mutable container.
		 * Allocation and inline-prefix policy remain with each construction branch.
		 * @param {CapturedNode} node
		 * @param {string} name
		 * @param {(child: Child) => boolean} available
		 * @returns {{ source: Emission, ready: boolean }[]}
		 */
		const fill_entries = (node, name, available) => {
			const children = node.children;
			const keys = node.keys;
			if (node.kind === 'Array') return children.map((child, i) => ({
				source: join_sources([`${name}[${keys[i]}]=`, expression_child(child)]),
				ready: available(child)
			}));
			if (node.kind === 'Object' || node.kind === 'NullObject') return children.map((child, i) => ({
				source: join_sources([`${name}${prop(keys[i])}=`, expression_child(child)]),
				ready: available(child)
			}));
			if (node.kind === 'Set') return children.map((child) => ({
				source: join_sources([`${name}.add(`, expression_child(child), ')']),
				ready: available(child)
			}));
			/** @type {{ source: Emission, ready: boolean }[]} */
			const entries = [];
			for (let i = 0; i < children.length; i += 2) entries.push({
				source: join_sources([`${name}.set(`, expression_child(children[i]), ',', expression_child(children[i + 1]), ')']),
				ready: available(children[i]) && available(children[i + 1])
			});
			return entries;
		};
		// Shells needed across back-edges exist before any atomic initializer. Their
		// population still occurs at the shell's post-order position below.
		for (const node of order) {
			if (!node.name || !node.early) continue;
			switch (node.kind) {
				case 'Array':
					declarations.push(`${node.name}=Array(${node.data})`);
					break;
				case 'Object':
				case 'NullObject':
					declarations.push(`${node.name}=${node.kind === 'NullObject' ? 'Object.create(null)' : '{}'}`);
					break;
				case 'Set':
					declarations.push(`${node.name}=new Set`);
					break;
				case 'Map':
					declarations.push(`${node.name}=new Map`);
					break;
				default:
					throw this.#error(`Cannot stringify value: a ${node.kind} node was scheduled for empty construction, but only mutable containers support it (internal emitter error)`, node.value);
			}
		}
		for (const node of order) {
			const name = node.name;
			const children = node.children;
			const keys = node.keys;
			const limit = node.position;
			/** @param {Child} child */
			const available = (child) => latest_of(child) < limit;
			if (name && node.early) {
				populate(fill_entries(node, name, available));
			} else if (name) {
				// A child can be embedded in this declaration if its expansion never reaches
				// a name declared at or after this node; back-edges become fills instead.
				switch (node.kind) {
					case 'Array': {
						if (is_sparse(node)) {
							declarations.push(`${name}=Array(${node.data})`);
							populate(fill_entries(node, name, available));
							break;
						}
						/** @type {Emission[]} */
						const parts = [];
						for (let i = 0; i < children.length; i++) {
							const child = children[i];
							if (available(child)) parts.push(expression_child(child));
							else {
								parts.push('');
								deferred_fill.push(join_sources([`${name}[${keys[i]}]=`, expression_child(child)]));
							}
						}
						// A trailing elision needs one extra comma to preserve length.
						const trailing = parts.length && !available(children[children.length - 1]) ? ',' : '';
						declarations.push(join_sources([`${name}=[`, join_sources(parts, ','), `${trailing}]`]));
						break;
					}
					case 'Object': {
						/** @type {Emission[]} */
						const embedded = [];
						let filling = false;
						for (let i = 0; i < children.length; i++) {
							const child = children[i];
							if (!filling && available(child)) {
								embedded.push(join_sources([`${literal_key(keys[i])}:`, expression_child(child)]));
							} else {
								// Once one key must wait for a later declaration, every following key is
								// populated through ordered fills so no available value leapfrogs it.
								filling = true;
								deferred_fill.push(join_sources([`${name}${prop(keys[i])}=`, expression_child(child)]));
							}
						}
						declarations.push(join_sources([`${name}={`, join_sources(embedded, ','), '}']));
						break;
					}
					case 'NullObject': {
						declarations.push(`${name}=Object.create(null)`);
						populate(fill_entries(node, name, available));
						break;
					}
					case 'Set': {
						// Insertion order is observable, so embed only when every member is ready.
						if (children.every(available)) {
							declarations.push(join_sources([`${name}=`, set_literal(children)]));
						} else {
							declarations.push(`${name}=new Set`);
							populate(fill_entries(node, name, available));
						}
						break;
					}
					case 'Map': {
						if (children.every(available)) {
							declarations.push(join_sources([`${name}=`, map_literal(children)]));
						} else {
							declarations.push(`${name}=new Map`);
							populate(fill_entries(node, name, available));
						}
						break;
					}
					default:
						declarations.push(join_sources([`${name}=`, inline(node)]));
				}
			}
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) {
				// Store non-primitive elements in a flat sidecar because Set/Map containers do
				// not expose paths to them, then retain stable descendants below each element.
				/** @type {CapturedNode[]} */
				const elements = [];
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (is_node(child)) elements.push(child);
				}
				if (elements.length) {
					const index = this.#collection++;
					sidecars.push(join_sources([`${this.#session_name}.c[${index}]=[`, join_sources(elements.map(expression_node), ','), ']']));
					for (let i = 0; i < elements.length; i++) {
						this.#assign_references_node(elements[i], { kind: 'collection', index, segments: [`[${i}]`] }, retained_seen, retained_at);
					}
				}
			}
		}
		flush_declarations();

		const root = expression(value);
		if (persistent) {
			for (const node of order) {
				if (node.opaque === 0) continue;
				const index = this.#slot++;
				slots.push(`${this.#session_name}.s[${index}]=${node.name}`);
				/** @type {ClientPath} */
				const reference = { kind: 'slot', index, segments: [] };
				this.#reference_node(node, reference, retained_at);
				this.#assign_references(node.value, reference, retained_seen, retained_at);
			}
		}
		const statements = [
			...construction,
			...deferred_fill,
			...sidecars,
			...slots
		];
		return statements.length
			? join_sources(['(()=>{', join_sources([...statements, join_sources(['return ', root])], ';'), '})()'])
			: root;
	}

	/**
	 * Records a client reference when it improves the shortest known source expression for an identity.
	 * Older records remain linked so source generated for an earlier boundary cannot select a path
	 * that only comes into existence later.
	 *
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 * @param {number} available
	 */
	#reference_node(node, reference, available) {
		const previous = this.#references.get(node);
		if (!previous || reference_length(reference) < reference_length(previous.path)) {
			if (this.#transaction_depth > 0) this.#reference_mutations.push({ node, previous });
			this.#references.set(node, { path: reference, available, previous });
		}
	}

	/**
	 * Returns the shortest retained path that exists at an ordered client boundary.
	 * @param {CapturedNode} node
	 * @param {number} available
	 * @returns {RetainedReference | undefined}
	 */
	#reference_at(node, available) {
		let reference = this.#references.get(node);
		while (reference) {
			if (reference.available <= available) return reference;
			reference = reference.previous;
		}
	}

	/**
	 * Resolves a reference hole to a concrete client path: the path fixed when the hole
	 * was created, or else the node's shortest committed path. Every node that reaches
	 * a batch has been anchored by an earlier region, so a miss is an internal error.
	 *
	 * @param {import('./stream-source.js').ReferenceInstruction} hole
	 * @returns {ClientPath}
	 */
	#resolve_reference(hole, available = this.#availability) {
		const reference = hole.path ?? this.#reference_at(hole.node, available)?.path;
		if (!reference) throw this.#error('Cannot stringify value: a client identity has no retained anchor, slot, or collection path before operation generation (internal emitter error)', hole.node.value);
		return reference;
	}

	/** Resolves every reachable structured reference before final rendering. @param {Emission} source */
	#resolve_references(source, available = this.#availability) {
		visit_source_instructions(source, (instruction) => {
			if (instruction.type === 'reference') instruction.path = this.#resolve_reference(instruction, available);
		});
	}

	/**
	 * Walks stable graph edges and assigns the cheapest reachable client reference to each node.
	 *
	 * @param {unknown} value
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 * @param {number} available
	 */
	#assign_references(value, reference, seen, available) {
		if (is_primitive(value)) return;
		const node = this.#graph.identities.get(/** @type {object} */ (value));
		if (node) this.#assign_references_node(node, reference, seen, available);
	}

	/**
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 * @param {number} available
	 */
	#assign_references_node(node, reference, seen, available) {
		this.#reference_node(node, reference, available);
		const length = reference_length(reference);
		const previous = seen.get(node);
		if (previous !== undefined && previous <= length) return;
		seen.set(node, length);
		const children = node.children;
		if (node.kind === 'Array') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, `[${node.keys[i]}]`), seen, available);
			}
		} else if (node.kind === 'Object' || node.kind === 'NullObject') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, prop(node.keys[i])), seen, available);
			}
		} else if (is_view(node)) {
			this.#assign_references_node(node.children[0], append_reference(reference, '.buffer'), seen, available);
		}
	}

	/**
	 * Wraps the head region with client table and session initialization, folding any
	 * pre-head operations (initial batches, cleanup) into the same closure.
	 *
	 * @param {Emission} region
	 * @param {Emission} [operations]
	 * @returns {string}
	 */
	#wrap_head(region, operations) {
		const scope = this.#scope;
		const id = stringify_string(this.#id);
		const table_name = this.#table_name;
		const session_name = this.#session_name;
		// The dispatch helper is only defined when a tail exists; every tail block calls
		// it to receive the session/table pair, replacing a longer per-block lookup preamble.
		const dispatch = this.#emit_dispatch ? `;${session_name}.b=f=>f(${session_name},${table_name})` : '';
		const table = `let ${table_name}=${scope}||(${scope}={__proto__:null}),${session_name}=${table_name}[${id}]={a:[],s:[],c:[],p:[]}${dispatch};`;
		const definitions = definitions_source();
		const source = operations === undefined
			? join_sources(['(()=>{', table, definitions, `;return ${session_name}.a[0]=`, region, '})()'])
			: (() => {
				const root_name = this.#next_name();
				return join_sources(['(()=>{', table, definitions, `;let ${root_name}=${session_name}.a[0]=`, region, ';', operations, `;return ${root_name}})()`]);
			})();
		return this.#render_final(source);
	}

	/**
	 * Emits source that removes this session from the retained table.
	 *
	 * @returns {string}
	 */
	#cleanup_source() {
		const id = stringify_string(this.#id);
		return `delete ${this.#table_name}[${id}]`;
	}

	/**
	 * Generates ordered client operations for a batch taken by the consumer. Emission is
	 * transactional so a fatal failure publishes none of its provisional graph state.
	 *
	 * @param {Event[]} events
	 * @param {boolean} block
	 * @returns {{ source: Emission, close: Source[] }}
	 */
	#emit_batch(events, block = true) {
		const transaction = this.#begin_transaction();
		try {
			const block_session = this.#session_name;
			const block_table = this.#table_name;
			const prefix = block ? `;${this.#scope}[${stringify_string(this.#id)}].b((${block_session},${block_table})=>{` : '';
			const block_start = this.#availability;
			/** @type {Emission[]} */
			const operations = [];
			/** @type {Source[]} */
			const close = [];
			for (const event of events) {
			if (!this.#is_active()) throw this.#terminal_reason();
			const source = event.source;
			const node = source.node;
			const available = this.#availability;
			const retained_at = ++this.#availability;
			const target = reference_source(node, this.#reference_at(node, available)?.path);
			const control = node.data.captured ? raw_source(`${block_session}.p[${node.data.pending}]`) : undefined;
			const reference = {
				target,
				control
			};
			/** @type {JavaScriptSource | undefined} */
			let value_source;
			/** @type {Emission | undefined} */
			let anchor;
			/** @type {Emission | undefined} */
			let materialization;
			if (!event.invalid) {
				if (!is_primitive(event.value)) {
					const outcome_node = this.#graph.identities.get(/** @type {object} */ (event.value));
					const retained = outcome_node && this.#reference_at(outcome_node, available);
					/** @type {Emission} */
					let expression;
					if (retained) {
						expression = reference_source(outcome_node, retained.path);
					} else {
						// Persistent: async outcomes must retain Map/Set element and opaque custom
						// child identities for future regions, exactly like the head region.
						const region = this.#emit_region(event.value, true, available, retained_at);
						this.#resolve_references(region, available);
						const index = this.#anchor++;
						const path = { kind: /** @type {const} */ ('anchor'), index, segments: [] };
						this.#assign_references(event.value, path, new Map(), retained_at);
						const name = `${block_session}.a[${index}]`;
						// Anchor indices are allocated only for new roots, monotonically and densely.
						// Once the push helper pays for itself the client can derive the position.
						const use_helper = this.#runtimes_emitted.v || index > 5;
						const write = use_helper
							? join_sources([runtime_source('v'), '(', region, ')'])
							: join_sources([name, '=', region]);
						expression = write;
						if (source.immediate) {
							const folded = use_helper ? write : join_sources(['(', write, ')']);
							anchor = write;
							value_source = template_source(folded);
						}
					}
					if (!source.immediate) {
						const local = this.#next_name();
						materialization = join_sources([`const ${local}=`, expression]);
						value_source = raw_source(local);
					} else if (!value_source) {
						value_source = template_source(expression);
					}
				} else {
					const region = this.#emit_region(event.value, true, available, retained_at);
					this.#resolve_references(region, available);
					value_source = template_source(region);
				}
			} else {
				if (source.immediate) {
					value_source = generic_error;
				} else {
					const local = this.#next_name();
					materialization = `const ${local}=new Error("devalue: failed to serialize asynchronous value")`;
					value_source = raw_source(local);
				}
			}
			if (!value_source) throw this.#error('Cannot stringify value: an async outcome has no materialized client expression before operation generation (internal emitter error)', event.value);

			try {
				let operation;
				if (event.type === 'resolve') operation = source.descriptor.resolve(reference, value_source);
				else if (event.type === 'reject') operation = source.descriptor.reject(reference, value_source);
				else if (event.type === 'next') operation = source.descriptor.next(reference, value_source);
				else if (event.type === 'complete') operation = source.descriptor.complete(reference, value_source);
				else operation = source.descriptor.error(reference, value_source);
				if (!this.#is_active()) throw this.#terminal_reason();
				if (!is_source(operation)) throw new TypeError(`Invalid async descriptor operation: ${event.type}() returned ${describe_received(operation)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
				const lowered = this.#lower_descriptor_source(operation, `async descriptor ${event.type}()`, retained_at);
				if (materialization) operations.push(materialization);
				operations.push(...lowered.prerequisites, source.immediate ? lowered.source : complete_statement_source(lowered.source));
				if (lowered.checkpoint) this.#commit_transaction(lowered.checkpoint, false);
			} catch (error) {
				if (!this.#is_active()) throw error;
				if (event.type === 'resolve' || event.type === 'next' || event.type === 'complete') {
					this.#report(error, event.value);
					if (!this.#is_active()) throw this.#terminal_reason();
					// A privately folded adapter publishes its separate anchor write if its callback
					// unexpectedly fails. The failed operation containing the folded expression was
					// never added to output. Arbitrary operations retain their eager local instead.
					if (anchor) {
						operations.push(anchor);
					} else if (materialization) {
						operations.push(materialization);
					}
					let fallback_value = generic_error;
					if (!source.immediate) {
						const local = this.#next_name();
						operations.push(`const ${local}=new Error("devalue: failed to serialize asynchronous value")`);
						fallback_value = raw_source(local);
					}
					const fallback = source.type === 'sequence'
						? source.descriptor.error(reference, fallback_value)
						: source.descriptor.reject(reference, fallback_value);
					if (!this.#is_active()) throw this.#terminal_reason();
					if (!is_source(fallback)) throw new TypeError(`Invalid async descriptor operation: fallback ${source.type === 'sequence' ? 'error' : 'reject'}() returned ${describe_received(fallback)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
					const context = source.type === 'sequence' ? 'async descriptor fallback error()' : 'async descriptor fallback reject()';
					const lowered = this.#lower_descriptor_source(fallback, context, retained_at);
					operations.push(...lowered.prerequisites, source.immediate ? lowered.source : complete_statement_source(lowered.source));
					if (lowered.checkpoint) this.#commit_transaction(lowered.checkpoint, false);
					event.type = source.type === 'sequence' ? 'error' : 'reject';
				} else {
					throw error;
				}
			}
			if (event.type !== 'next' && node.data.captured && !source.descriptor.manages_pending) {
				operations.push(`delete ${block_session}.p[${node.data.pending}]`);
			}
			if (event.type !== 'next') {
				this.#active--;
				if (source.type === 'sequence' && event.type === 'error') close.push(source);
			}
			}
			const rendered = this.#render_operations(operations, block_start, block_session);
			if (block && this.#active === 0 && this.#batch.length === 0) {
				rendered.push(this.#cleanup_source());
			}
			const body = join_sources(rendered, ';');
			const structured = block
				? join_sources([prefix, definitions_source(), ';', body, '})'])
				: rendered.length ? join_sources([';', body]) : '';
			const result = { source: structured, close };
			this.#commit_transaction(transaction, true);
			return result;
		} catch (error) {
			this.#roll_back_transaction(transaction, error);
			throw error;
		}
	}

	/**
	 * Creates persistent client-slot aliases for repeated long paths when profitable in
	 * this batch, then retains those aliases as the nodes' shortest references.
	 *
	 * @param {Emission[]} operations
	 * @param {number} available Paths committed before this batch began.
	 * @param {string} session Generated client-session binding in this operation scope.
	 * @returns {Emission[]}
	 */
	#render_operations(operations, available, session) {
		/** @type {Map<CapturedNode, number>} */
		const uses = new Map();
		for (const operation of operations) {
			visit_source_instructions(operation, (value) => {
				if (value.type !== 'reference') return;
				uses.set(value.node, (uses.get(value.node) ?? 0) + 1);
			});
		}
		/** @type {{ node: CapturedNode, path: ClientPath, uses: number }[]} */
		const candidates = [];
		for (const [node, count] of uses) {
			const reference = this.#reference_at(node, available)?.path;
			if (!reference || reference.kind === 'slot') continue;
			if (count < 2) continue;
			candidates.push({ node, path: reference, uses: count });
		}
		candidates.sort((a, b) => reference_length(b.path) - reference_length(a.path));
		/** @type {Map<CapturedNode, ClientPath>} */
		const aliases = new Map();
		/** @type {string[]} */
		const prefix = [];
		for (const { node, path, uses } of candidates) {
			const reference = { kind: /** @type {const} */ ('slot'), index: this.#slot, segments: [] };
			const slot = render_reference(reference, session);
			const path_length = reference_length(path);
			if (reference_length(reference) + 1 + path_length + 1 + reference_length(reference) * uses >= path_length * uses) continue;
			this.#slot++;
			prefix.push(`${slot}=${render_reference(path, session)}`);
			aliases.set(node, reference);
			this.#reference_node(node, reference, available);
		}
		for (const operation of operations) {
			visit_source_instructions(operation, (instruction) => {
				if (instruction.type !== 'reference') return;
				instruction.path = aliases.get(instruction.node) ?? this.#resolve_reference(instruction, available);
			});
		}
		return /** @type {Emission[]} */ (prefix).concat(operations);
	}

	/**
	 * Creates the one-shot async iterator that renders ready batches as executable
	 * blocks and drives sequence backpressure as each batch is dequeued.
	 *
	 * @returns {UnevalStreamTail}
	 */
	#tail() {
		const session = this;
		const generator = this.#blocks();
		// Tracks whether the generator has completed, so that `return()` after completion is a
		// no-op like any other async generator instead of re-running cancellation.
		let done = false;
		/** @param {Promise<IteratorResult<string, void>>} result */
		const track = (result) =>
			result.then(
				(result) => {
					if (result.done) done = true;
					return result;
				},
				(error) => {
					done = true;
					throw error;
				}
			);
		/** @type {UnevalStreamTail} */
		const tail = {
			[Symbol.asyncIterator]() {
				return this;
			},
			next: () => track(generator.next()),
			return: async () => {
				if (done) return generator.return();
				done = true;
				// An async generator queues `return()` behind an in-flight `next()`, and `next()`
				// may be parked waiting on a source that never settles. Cancelling first wakes the
				// generator so the pending `next()` completes and the queued `return()` can run.
				const cancelling = session.#cancel();
				const result = await generator.return();
				await cancelling;
				session.#throw_terminal_reason();
				return result;
			}
		};
		return tail;
	}

	/**
	 * Yields each ready batch as an executable block, waiting for sources between
	 * batches. Ends once every source has emitted its terminal operation, or once the session
	 * is cancelled — after cleanup finishes, so consumers observe cleanup failures.
	 *
	 * @returns {AsyncGenerator<string, void, void>}
	 */
	async *#blocks() {
		while (true) {
			while (!this.#batch_ready && this.#active > 0 && this.#is_active()) await this.#sleep();
			if (!this.#is_active()) {
				if (this.#status.state === 'cancelled' || this.#status.state === 'failed') {
					await this.#status.cleanup;
					this.#throw_terminal_reason();
				}
				return;
			}
			if (this.#active === 0) {
				this.#complete();
				return;
			}
			yield /** @type {string} */ (await this.#deliver(this.#take_batch(), true));
		}
	}

	/** Suspends the tail generator until the next `#notify`. The generator is the only waiter. */
	#sleep() {
		return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => {
			this.#wake = resolve;
		});
	}

	/** Wakes the tail generator if it is waiting for delivery or a lifecycle change. */
	#notify() {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	/**
	 * Reports whether the session may still discover, observe, or generate work.
	 *
	 * @returns {boolean}
	 */
	#is_active() {
		return this.#status.state === 'preparing' || this.#status.state === 'streaming';
	}

	/** Returns the exact terminal reason, including a falsy reason. */
	#terminal_reason() {
		const status = this.#status;
		return status.state === 'cancelled' || status.state === 'failed' ? status.reason : undefined;
	}

	/** Throws the terminal reason when one is present, independently of its truthiness. */
	#throw_terminal_reason() {
		const status = this.#status;
		if ((status.state === 'cancelled' || status.state === 'failed') && status.has_reason) throw status.reason;
	}

	/**
	 * Idempotently records successful completion before releasing lifecycle ownership.
	 * Normal completion never invokes iterator or descriptor cancellation hooks.
	 */
	#complete() {
		if (!this.#is_active()) return;
		this.#status = { state: 'completed' };
		this.#release_lifecycle();
		for (const source of this.#sources) this.#deactivate(source);
		this.#notify();
	}

	/**
	 * Stops source callbacks and releases detachable native observer closures.
	 * @param {Source} source
	 */
	#deactivate(source) {
		source.active = false;
		if (source.observer) {
			source.observer.active = false;
			source.observer.dispatch = undefined;
		}
	}

	/** Detaches externally owned wakeups and discards batches that can no longer be emitted. */
	#release_lifecycle() {
		this.#signal?.removeEventListener('abort', this.#abort);
		if (this.#flush_handle !== undefined) clearTimeout(this.#flush_handle);
		this.#flush_handle = undefined;
		this.#flushing = false;
		this.#batch = [];
		this.#batch_ready = false;
	}

	/**
	 * Transitions to cancellation before synchronously initiating cleanup for every committed source.
	 *
	 * @param {unknown} [reason]
	 * @param {boolean} [has_reason]
	 * @returns {Promise<void>}
	 */
	#cancel(reason, has_reason = arguments.length !== 0) {
		if (!this.#is_active()) {
			const status = this.#status;
			if (status.state === 'cancelled' && has_reason && !status.has_reason) {
				status.has_reason = true;
				status.reason = reason;
			}
			return status.state === 'cancelled' || status.state === 'failed' ? status.cleanup : Promise.resolve();
		}
		return this.#terminate('cancelled', reason, has_reason);
	}

	/**
	 * Makes a generation failure authoritative, waits for cleanup, then throws the exact primary reason.
	 *
	 * @param {unknown} error
	 * @returns {Promise<never>}
	 */
	async #throw_failure(error) {
		const cleanup = this.#is_active()
			? this.#terminate('failed', error, true)
			: this.#status.state === 'cancelled' || this.#status.state === 'failed'
				? this.#status.cleanup
				: Promise.resolve();
		await cleanup;
		this.#throw_terminal_reason();
		throw error;
	}

	/**
	 * Enters a terminal state before callbacks run, starts every close/cancel operation without
	 * awaiting inside the discovery-order loop, and shares one cleanup completion under reentry.
	 *
	 * @param {'cancelled' | 'failed'} state
	 * @param {unknown} reason
	 * @param {boolean} has_reason
	 * @returns {Promise<void>}
	 */
	#terminate(state, reason, has_reason) {
		/** @type {(value?: void | PromiseLike<void>) => void} */
		let finish = () => {};
		const cleanup = new Promise((resolve) => { finish = resolve; });
		/** @type {TerminatingLifecycle} */
		const status = { state, has_reason, reason, cleanup };
		this.#status = status;
		this.#release_lifecycle();
		this.#notify();

		for (const source of this.#sources) {
			if (!source.committed) continue;
			this.#deactivate(source);
			if (source.acquiring) continue;
			this.#close_sequence(source);
			this.#cancel_source(source);
		}

		// Reentrant callbacks may finish iterator acquisition after the terminal transition.
		// Settle in the next microtask so those synchronously initiated operations join cleanup.
		void Promise.resolve()
			.then(() => this.#settle_cleanup(status))
			.catch((error) => {
				// Cleanup records are nonrejecting, but an unexpected bookkeeping failure must
				// neither strand termination nor replace an already authoritative reason.
				if (!status.has_reason) {
					status.has_reason = true;
					status.reason = error;
				} else {
					this.#report(error, undefined);
				}
				this.#notify();
			})
			.then(finish);
		return cleanup;
	}

	/**
	 * Selects cleanup failures deterministically after every initiated operation settles.
	 *
	 * @param {TerminatingLifecycle} status
	 */
	async #settle_cleanup(status) {
		/** @type {CleanupOperation[]} */
		const operations = [];
		for (const source of this.#sources) {
			if (!source.committed) continue;
			if (source.close_operation) operations.push(source.close_operation);
			if (source.cancel_operation) operations.push(source.cancel_operation);
		}
		const results = await Promise.all(operations.map((operation) => operation.result));
		let primary = -1;
		if (!status.has_reason) {
			primary = results.findIndex((result) => !result.ok);
			if (primary !== -1) {
				const result = results[primary];
				if (result.ok) throw new Error('devalue: cleanup result selection failed');
				status.has_reason = true;
				status.reason = result.error;
			}
		}
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (i !== primary && !result.ok) this.#report_cleanup(operations[i], result.error);
		}
		this.#notify();
	}

	/**
	 * Starts a sequence iterator's optional `return()` method at most once, without waiting for
	 * an outstanding pull. Getter, call, and asynchronous failures are immediately observed.
	 *
	 * @param {Source} source
	 * @returns {CleanupOperation | undefined}
	 */
	#close_sequence(source) {
		if (source.close_operation) return source.close_operation;
		if (!source.iterator) return;
		const operation = this.#create_cleanup(source);
		source.close_operation = operation;
		try {
			const method = source.iterator.return;
			if (typeof method !== 'function') {
				operation.settle({ ok: true });
				return operation;
			}
			this.#settle_invocation(operation, method.call(source.iterator));
		} catch (error) {
			operation.settle({ ok: false, error });
		}
		return operation;
	}

	/**
	 * Starts one descriptor cancellation hook at most once.
	 * @param {Source} source
	 * @returns {CleanupOperation | undefined}
	 */
	#cancel_source(source) {
		if (source.cancel_operation) return source.cancel_operation;
		const operation = this.#create_cleanup(source);
		source.cancel_operation = operation;
		try {
			const cancel = source.descriptor.cancel;
			if (typeof cancel !== 'function') {
				operation.settle({ ok: true });
				return operation;
			}
			this.#settle_invocation(operation, cancel.call(source.descriptor));
		} catch (error) {
			operation.settle({ ok: false, error });
		}
		return operation;
	}

	/**
	 * Creates an always-fulfilled source-owned cleanup result before invoking user code, making
	 * getter/callback reentry idempotent. Termination later collects records in source order.
	 * @param {Source} source
	 * @returns {CleanupOperation}
	 */
	#create_cleanup(source) {
		/** @type {(result: CleanupResult) => void} */
		let settle = () => {};
		const result = new Promise((resolve) => { settle = resolve; });
		/** @type {CleanupOperation} */
		const operation = { source, reported: false, result, settle };
		return operation;
	}

	/**
	 * Immediately observes an invoked cleanup result and settles its non-rejecting record.
	 * @param {CleanupOperation} operation
	 * @param {unknown} result
	 */
	#settle_invocation(operation, result) {
		Promise.resolve(result).then(
			() => operation.settle({ ok: true }),
			(error) => operation.settle({ ok: false, error })
		);
	}

	/**
	 * Closes a failed sequence diagnostically without delaying delivery of its generated error.
	 * @param {Source} source
	 */
	#close_failed_sequence(source) {
		const operation = this.#close_sequence(source);
		if (!operation) return;
		void operation.result.then((result) => {
			const status = this.#status;
			if (!result.ok && status.state !== 'cancelled' && status.state !== 'failed') this.#report_cleanup(operation, result.error);
		});
	}

	/**
	 * Reports a cleanup failure at most once, preserving the source iterable as diagnostic context.
	 * @param {CleanupOperation} operation
	 * @param {unknown} error
	 */
	#report_cleanup(operation, error) {
		if (operation.reported) return;
		operation.reported = true;
		this.#report(error, operation.source.context);
	}

	/**
	 * Forwards a recovered serialization failure to the diagnostic callback. The callback
	 * must never affect stream control flow, so its own exceptions are swallowed.
	 *
	 * @param {unknown} error
	 * @param {unknown} value
	 */
	#report(error, value) {
		try {
			this.#onerror?.(error, value);
		} catch {}
	}

	/**
	 * Creates a DevalueError associated with the initial streamed root.
	 *
	 * @param {string} message
	 * @param {unknown} value
	 * @returns {DevalueError}
	 */
	#error(message, value) {
		return new DevalueError(message, [], value, this.#root?.value);
	}
}

/**
 * Emits a constructor expression for a captured non-container built-in.
 *
 * @param {CapturedNode} node
 * @param {(child: Child) => Emission} expression
 * @returns {Emission}
 */
function scalar(node, expression) {
	switch (node.kind) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			return `Object(${stringify_primitive(node.data)})`;
		case 'Date':
			return `new Date(${node.data})`;
		case 'RegExp': {
			return node.data.flags
				? `new RegExp(${stringify_string(node.data.source)},${stringify_string(node.data.flags)})`
				: `new RegExp(${stringify_string(node.data.source)})`;
		}
		case 'URL':
		case 'URLSearchParams':
			return `new ${node.kind}(${stringify_string(node.data)})`;
		case 'ArrayBuffer':
			// Native TypedArray join; avoids materializing a JS number array first.
			return `new Uint8Array([${node.data.toString()}]).buffer`;
		case 'DataView': {
			return join_sources(['new DataView(', expression(node.children[0]), `,${node.data.byteOffset},${node.data.byteLength})`]);
		}
		case 'Temporal.Duration':
		case 'Temporal.Instant':
		case 'Temporal.PlainDate':
		case 'Temporal.PlainTime':
		case 'Temporal.PlainDateTime':
		case 'Temporal.PlainMonthDay':
		case 'Temporal.PlainYearMonth':
		case 'Temporal.ZonedDateTime':
			return `${node.kind}.from(${stringify_string(node.data)})`;
		default:
			if (is_view(node)) {
				return join_sources([`new ${node.kind}(`, expression(node.children[0]), `,${node.data.byteOffset},${node.data.length})`]);
			}
			throw new Error(`Unknown stream node ${node.kind}`);
	}
}

/**
 * Reports whether a node is an ArrayBuffer view.
 *
 * @param {CapturedNode} node
 * @returns {node is CapturedNode & { kind: ViewKind }}
 */
function is_view(node) {
	const kind = node.kind;
	return kind === 'DataView' || kind.endsWith('Array') && kind !== 'Array';
}

/**
 * Reports whether a node must be constructed after its represented children.
 *
 * @param {CapturedNode} node
 * @returns {boolean}
 */
function is_atomic(node) {
	return node.kind === 'Custom' || node.kind === 'Async' || is_view(node);
}

/**
 * Adds descriptor callback and local-hole context while preserving graph diagnostics.
 * @param {unknown} error
 * @param {unknown} value
 * @param {string} context
 * @param {number} index
 * @param {boolean} [has_cause]
 * @param {string} [detail]
 */
function descriptor_interpolation_error(error, value, context, index, has_cause = false, detail) {
	const suffix = typeof value === 'symbol' ? ' Symbol values cannot be serialized as data.'
		: detail === undefined ? '' : ` ${detail}`;
	const message = `Invalid JavaScript source interpolation in ${context}, template hole ${index + 1}: received ${describe_received(value)}.${suffix}`;
	const wrapped = has_cause ? new TypeError(message, { cause: error }) : new TypeError(message);
	if (has_cause) descriptor_error_causes.set(wrapped, error);
	return wrapped;
}

/**
 * Preserves detailed messages only for the deepest error owned by this active graph walk.
 * Private descriptor provenance can reveal that error without traversing public causes.
 * @param {CapturedGraph} graph
 * @param {unknown} error
 */
function descriptor_error_detail(graph, error) {
	return graph_error_message(graph, descriptor_graph_error(error));
}

/**
 * Returns the original privately wrapped graph failure without inspecting arbitrary user causes.
 * @param {unknown} error
 */
function descriptor_graph_error(error) {
	while (typeof error === 'object' && error !== null && descriptor_error_causes.has(error)) {
		error = descriptor_error_causes.get(error);
	}
	return error;
}

/** @param {object} value */
function is_native_promise(value) {
	// Fast rejection for the common case (plain objects/arrays): a native promise is
	// either same-realm `instanceof Promise` or carries the well-known tag on its
	// prototype chain, which the authoritative walk below requires anyway.
	if (!(value instanceof Promise) && !(Symbol.toStringTag in value)) return false;
	let prototype = Object.getPrototypeOf(value);
	while (prototype) {
		if (Object.prototype.toString.call(prototype) === '[object Promise]') return true;
		prototype = Object.getPrototypeOf(prototype);
	}
	return false;
}

/**
 * Emits the shortest safe property access segment for a string key.
 *
 * @param {string} key
 * @returns {string}
 */
function prop(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? `.${key}` : `[${stringify_string(key)}]`;
}

/**
 * Emits the shortest safe object-literal key for a string key.
 *
 * @param {string} key
 * @returns {string}
 */
function literal_key(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : stringify_string(key);
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Generates a short session key. Session ids only need to be unique within one
 * client table (a collision overwrites a concurrent session), so 48 bits keeps
 * the per-block lookup cost low while making accidental collisions negligible.
 */
function create_session_id() {
	const bytes = new Uint8Array(8);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (byte) => ID_ALPHABET[byte & 63]).join('');
}

/** Returns a completed tail iterator for graphs with no asynchronous work. */
function empty_tail() {
	return (async function* () {})();
}

/** Resolves in a fresh macrotask, after any flush already scheduled with `setTimeout(..., 0)`. */
function macrotask() {
	return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => setTimeout(resolve, 0));
}

/** @typedef {{ path: ClientPath, available: number, previous: RetainedReference | undefined }} RetainedReference */
/** @typedef {{ node: CapturedNode, previous: RetainedReference | undefined }} ReferenceMutation */
/** @typedef {{ nodes: number, sources: number, new_custom: number, validated: number, opaque: number, references: number, pending: number, native_pending: number, active: number, availability: number, anchor: number, slot: number, collection: number, name: number }} TransactionCheckpoint */
/** @typedef {{ state: 'preparing' | 'streaming' } | { state: 'completed' } | TerminatingLifecycle} Lifecycle */
/** @typedef {{ state: 'cancelled' | 'failed', has_reason: boolean, reason: unknown, cleanup: Promise<void> }} TerminatingLifecycle */
/** @typedef {{ ok: true } | { ok: false, error: unknown }} CleanupResult */
/** @typedef {{ source: Source, reported: boolean, result: Promise<CleanupResult>, settle: (result: CleanupResult) => void }} CleanupOperation */
/** @typedef {{ node: AsyncNode, descriptor: any, context: unknown, type: 'value' | 'sequence' | 'native', immediate: boolean, committed: boolean, started: boolean, terminal: boolean, active: boolean, iterator?: AsyncIterator<unknown>, acquiring?: boolean, next?: AsyncIterator<unknown>['next'], pulling?: boolean, observer?: { active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void }, early?: ['resolve' | 'reject', unknown], close_operation?: CleanupOperation, cancel_operation?: CleanupOperation }} Source */
/** @typedef {{ source: Source, type: 'resolve' | 'reject' | 'next' | 'complete' | 'error', value: unknown, invalid: boolean }} Event */
