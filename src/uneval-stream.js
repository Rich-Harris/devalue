/**
 * @import {
 *   AsyncSequenceDescriptor,
 *   AsyncValueDescriptor,
 *   UnevalStreamOptions,
 *   UnevalStreamReplacer,
 *   UnevalStreamResult,
 *   UnevalStreamTail
 * } from './types.js'
 */

import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_primitive,
	stringify_string,
	valid_array_indices
} from './utils.js';

/** @typedef {{ node: number } | { value: unknown }} ValueRef */
/** @typedef {{ root: string, segments: string[] }} Reference */
/**
 * @typedef {object} GraphNode
 * @property {number} id
 * @property {any} value
 * @property {string} kind
 * @property {any} data
 * @property {ValueRef[]} edges
 * @property {number} epoch
 * @property {number} position
 * @property {number} uses
 * @property {boolean} hoisted
 * @property {boolean} early
 * @property {number} latest
 * @property {string} name
 * @property {boolean} rendering
 * @property {Reference} [reference]
 * @property {boolean} [opaque]
 */

const promise_then = Promise.prototype.then;
const generic_error = 'new Error("devalue: failed to serialize asynchronous value")';
const TOKEN_PATTERN = /"\d+"/g;
const ARRAY_INDEX = 0;
const OBJECT_KEY = 1;
const MAP_KEY = 2;

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

	// Capture a snapshot of the complete synchronous graph and register any promises
	// or async iterables found within it. Nothing has been emitted or observed yet.
	try {
		session.capture(value, true);
		session.commit();
		session.validate_new_custom();
	} catch (error) {
		await session.cancel(error);
		throw session.failure ?? error;
	}
	if (session.cancelled) {
		await session.cancel(session.failure);
		throw session.failure;
	}

	if (session.sources.size === 0) {
		return { head: session.emit_region(value, false).source, tail: empty_tail(), id };
	}

	// Start observing async sources, then wait until the next ("macro")task. Outcomes
	// that become available before then can be included in the head instead of a
	// separate tail block.
	session.start_sources();
	await session.initial_window();

	if (session.failure) throw session.failure;

	try {
		// Emit the captured root and record how its objects can be reached on the client.
		// Later outcome regions use these references to preserve identity across chunks.
		const head_region = session.emit_region(value, true);
		session.assign_references(value, { root: 's.a[0]', segments: [] }, new Map());
		let operations = '';
		// Fold available batches into the head until the (soft) budget is spent; an
		// over-budget batch is split by emit_batch, which requeues the remainder for the tail.
		while (session.batch_index < session.batches.length && operations.length < session.budget) {
			const batch = session.batches[session.batch_index++];
			operations += session.emit_batch(batch, false);
			for (const event of batch.events) {
				if (!event.source.needs_close) continue;
				event.source.needs_close = false;
				try {
					await session.close_sequence(event.source);
				} catch (error) {
					await session.cancel(error);
					throw session.failure ?? error;
				}
			}
			session.consume(batch);
		}
		session.start_unstarted();

		if (session.active === 0 && session.batch_index === session.batches.length && session.ready.length === 0) {
			return { head: session.wrap_head(head_region, operations + session.cleanup_source()), tail: empty_tail(), id };
		}

		// Anything still pending is delivered as executable tail blocks. Each block
		// updates the client-side objects created by the head.
		session.emit_dispatch = true;
		return { head: session.wrap_head(head_region, operations), tail: session.tail(), id };
	} catch (error) {
		await session.cancel(error);
		throw session.failure ?? error;
	}
}

/** Coordinates lightweight initial capture, durable outcome regions, client references, and tail delivery. */
class Session {
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
		/** Trusted assignable source expression that locates the client session table. */
		this.scope = scope;
		/** Unescaped key that identifies this stream inside the private table. */
		this.id = id;
		/** User callback that classifies custom synchronous and asynchronous values. */
		this.replacer = replacer;
		/** Signal that cancels server-side observation and sequence pulling. */
		this.signal = signal;
		/** Diagnostic callback for asynchronous outcomes that fail to serialize. */
		this.onerror = options.onerror;
		/** Approximate maximum bytes of generated source per tail block. */
		this.budget = options.budget ?? 32768;
		/** Initial value retained to provide context in serialization errors. */
		this.root_value = root;
		/** Canonical nodes in discovery order; a node's id is its index here. @type {GraphNode[]} */
		this.node_list = [];
		/**
		 * Walked server identities mapped to protocol plans and client references.
		 * @type {Map<object, GraphNode>}
		 */
		this.nodes = new Map();
		/** Raw segments on the path currently being discovered. @type {unknown[]} */
		this.path_keys = [];
		/** Formatting kind for each current path segment. @type {number[]} */
		this.path_kinds = [];
		/** Identity keys added by open transactions, retained for rollback. @type {object[]} */
		this.added = [];
		/**
		 * Async descriptor states discovered anywhere in the streamed graph.
		 * @type {Set<Source>}
		 */
		this.sources = new Set();
		/**
		 * Observed events waiting for the current scheduled flush window to close.
		 * @type {Event[]}
		 */
		this.ready = [];
		/**
		 * Finalized event batches whose boundaries no longer depend on tail consumption.
		 * @type {Batch[]}
		 */
		this.batches = [];
		/** Index of the next finalized batch that `tail.next()` will consume. */
		this.batch_index = 0;
		/**
		 * Resolvers for tail reads waiting for a batch, completion, failure, or cancellation.
		 * @type {Array<() => void>}
		 */
		this.waiters = [];
		/** Monotonic observation order assigned to events before they are batched. */
		this.sequence = 0;
		/** Number of async sources whose terminal client operation has not yet been generated. */
		this.active = 0;
		/** Whether a zero-delay callback is currently scheduled to finalize ready events. */
		this.flushing = false;
		/** Whether committed async sources have begun observation or iteration. */
		this.started = false;
		/** Whether server-side observation and queued delivery have been cancelled. */
		this.cancelled = false;
		/**
		 * In-flight cleanup shared by repeated cancellation requests.
		 * @type {Promise<void> | undefined}
		 */
		this.cancelling = undefined;
		/**
		 * Fatal generation error, cancellation reason, or first cleanup failure.
		 * @type {unknown}
		 */
		this.failure = undefined;
		/** Next client anchor index; index zero is reserved for the reconstructed head root. */
		this.anchor = 1;
		/** Next client `pending` index used to store a descriptor's private control. */
		this.pending = 0;
		/** Next client `slots` index used when no stable path can retain an identity. */
		this.slot = 0;
		/** Next client `collections` index used for a retained Map or Set sidecar. */
		this.collection = 0;
		/** Next collision-proof placeholder id shared by every replacement phase. */
		this.token = 0;
		/** @type {Map<string, keyof typeof RUNTIMES>} */
		this.runtime_tokens = new Map();
		/** @type {Map<string, number>} */
		this.promise_tokens = new Map();
		/**
		 * Stable AbortSignal listener that forwards the signal reason into session cancellation.
		 * @type {() => void}
		 */
		this.abort = () => void this.cancel(signal?.reason);
		signal?.addEventListener('abort', this.abort, { once: true });
		/**
		 * Planned node for the initial graph root, also used as DevalueError context.
		 * @type {GraphNode | undefined}
		 */
		this.root = undefined;
		/** @type {Array<() => void>} */
		this.undo = [];
		this.transaction_depth = 0;
		/** @type {Source[]} */
		this.unstarted = [];
		/**
		 * Session helpers already defined in emitted output, keyed by runtime name.
		 * @type {Record<string, boolean>}
		 */
		this.runtimes_emitted = {};
		/** Count of native promise sources whose terminal operation has not been emitted. */
		this.native_pending = 0;
		/**
		 * Custom nodes captured since the last atomic-cycle validation.
		 * @type {GraphNode[]}
		 */
		this.new_custom = [];
		/**
		 * Custom nodes already proven acyclic.
		 * @type {Set<GraphNode>}
		 */
		this.validated = new Set();
		/**
		 * Whether the head must define the block dispatch helper (`s.b`). Set exactly
		 * when a non-empty tail will be returned, so the helper always pays for itself.
		 */
		this.emit_dispatch = false;
		/** Monotonic tag for per-region node scratch state (see emit_region). */
		this.region_epoch = 0;
	}

	/**
	 * Returns a placeholder for a session helper (`s.f`, `s.w`, `s.r`, `s.v`). The placeholder is
	 * replaced — and the helper's definition shipped, at most once per session — when a
	 * finished block is assembled, so definitions always precede uses in evaluation order
	 * regardless of hoisting or discovery order.
	 *
	 * @param {keyof typeof RUNTIMES} key
	 * @returns {string}
	 */
	runtime_token(key) {
		const token = this.placeholder();
		this.runtime_tokens.set(token, key);
		return token;
	}

	/**
	 * Returns a placeholder for a native pending-promise construct. At block assembly it
	 * is replaced with a call to the shared `s.w` helper.
	 *
	 * @param {number} pending
	 * @returns {string}
	 */
	promise_token(pending) {
		const token = this.placeholder();
		this.promise_tokens.set(token, pending);
		return token;
	}

	/**
	 * Replaces runtime and promise placeholders in finished block source, returning the
	 * helper definitions that must be evaluated before it. Definitions are emitted at most
	 * once per session.
	 *
	 * @param {string} source
	 * @returns {{ defs: string[], source: string }}
	 */
	resolve_runtime_declarations(source) {
		/** @type {string[]} */
		const defs = [];
		if (this.runtime_tokens.size === 0 && this.promise_tokens.size === 0) return { defs, source };
		/** @param {keyof typeof RUNTIMES} key */
		const define = (key) => {
			if (this.runtimes_emitted[key]) return;
			this.set(this.runtimes_emitted, key, true);
			defs.push(`s.${key}=${RUNTIMES[key]}`);
		};
		const resolved = source.replace(TOKEN_PATTERN, (token) => {
			const pending = this.promise_tokens.get(token);
			if (pending !== undefined) {
				define('w');
				return `s.w(${pending})`;
			}
			const key = this.runtime_tokens.get(token);
			if (!key) return token;
			define(key);
			return `s.${key}`;
		});
		return { defs, source: resolved };
	}

	begin_transaction() {
		this.transaction_depth++;
		return { undo: this.undo.length, nodes: this.node_list.length, added: this.added.length };
	}

	/** @param {{ undo: number, nodes: number, added: number }} marker */
	commit_transaction(marker) {
		this.transaction_depth--;
		if (this.transaction_depth === 0) {
			this.undo.length = marker.undo;
			this.added.length = marker.added;
		}
	}

	/** @param {{ undo: number, nodes: number, added: number }} marker */
	rollback_transaction(marker) {
		for (let i = this.undo.length - 1; i >= marker.undo; i--) this.undo[i]();
		this.undo.length = marker.undo;
		for (let i = this.added.length - 1; i >= marker.added; i--) this.nodes.delete(this.added[i]);
		this.added.length = marker.added;
		this.node_list.length = marker.nodes;
		this.transaction_depth--;
	}

	/**
	 * @param {any} target
	 * @param {string} key
	 * @param {any} value
	 */
	set(target, key, value) {
		const had = Object.hasOwn(target, key);
		const previous = target[key];
		if (this.transaction_depth) this.undo.push(() => had ? target[key] = previous : delete target[key]);
		target[key] = value;
	}

	/**
	 * Transactionally walks a value's devalue-visible graph and discovers async sources.
	 *
	 * @param {unknown} value
	 * @param {boolean} root
	 * @returns {GraphNode | undefined}
	 */
	capture(value, root = false) {
		const marker = this.begin_transaction();
		try {
			const node = discover(this, value);
			if (root) this.set(this, 'root', node);
			this.commit_transaction(marker);
			return node;
		} catch (error) {
			this.rollback_transaction(marker);
			throw error;
		}
	}

	/**
	 * Rejects direct cycles among atomic custom constructors, validating only custom
	 * nodes discovered since the previous validation. Edges are immutable once captured,
	 * so a new cycle always passes through a newly captured node.
	 */
	validate_new_custom() {
		if (this.new_custom.length === 0) return;
		const pending = this.new_custom;
		this.new_custom = [];
		/** @type {Set<GraphNode>} */
		const validating = new Set();
		/** @param {GraphNode} node */
		const validate = (node) => {
			if (this.validated.has(node)) return;
			if (validating.has(node)) throw this.error('Cannot stringify an atomic custom cycle', node.value);
			validating.add(node);
			for (const child of node.data.tokens.values()) {
				if (child.kind === 'Custom') validate(child);
			}
			validating.delete(node);
			this.validated.add(node);
		};
		for (const node of pending) validate(node);
	}

	/**
	 * Classifies a node as a user replacement, native Promise, native AsyncIterable, or built-in.
	 *
	 * @param {unknown} value
	 * @param {GraphNode} node
	 * @returns {boolean}
	 */
	classify(value, node) {
		if (this.replacer) {
			const tokens = new Map();
			const result = this.replacer(value, (child) => {
				if (is_primitive(child)) {
					this.capture(child);
					return stringify_primitive(child);
				}
				const token = this.placeholder();
				tokens.set(token, child);
				return token;
			});
			if (typeof result === 'string') {
				const edges = [];
				for (const [token, child] of tokens) {
					if (!result.includes(token)) {
						tokens.delete(token);
						continue;
					}
					const captured = this.capture(child);
					tokens.set(token, captured);
					edges.push(captured ? { node: captured.id } : { value: child });
					this.mark_opaque_child(child);
				}
				// `node` was created inside the current capture transaction, so rollback
				// discards it wholesale; its own properties need no journaling.
				node.kind = 'Custom';
				node.data = { source: result, tokens };
				node.edges = edges;
				this.new_custom.push(node);
				if (this.transaction_depth) {
					this.undo.push(() => {
						const index = this.new_custom.lastIndexOf(node);
						if (index !== -1) this.new_custom.splice(index, 1);
					});
				}
				return true;
			}
			if (result !== undefined && result !== null && result !== false) {
				if (typeof result !== 'object' || !Object.hasOwn(result, 'type')) {
					throw new TypeError('Invalid unevalStream replacer result');
				}
				if (result.type === 'async-value') {
					this.validate_value_descriptor(result);
					this.add_source(node, result, 'value');
					return true;
				}
				if (result.type === 'async-sequence') {
					this.validate_sequence_descriptor(result);
					this.add_source(node, result, 'sequence');
					return true;
				}
				throw new TypeError('Invalid unevalStream replacer result');
			}
		}

		if (typeof value === 'object' && value !== null) {
			/** @type {{ active: boolean } | undefined} */
			let observer;
			if (is_native_promise(value)) try {
				const current = observer = { active: true };
				/**
				 * Forwards a native Promise fulfillment while its provisional observer is active.
				 *
				 * @param {unknown} result
				 */
				const resolve = (result) => current.active && this.native_event(value, 'resolve', result);
				/**
				 * Forwards a native Promise rejection while its provisional observer is active.
				 *
				 * @param {unknown} reason
				 */
				const reject = (reason) => current.active && this.native_event(value, 'reject', reason);
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
				const descriptor = native_descriptor(/** @type {Promise<unknown>} */ (value), this);
				let source;
				try {
					source = this.add_source(node, descriptor, 'native');
					this.set(source, 'observer', observer);
					this.set(this, 'native_pending', this.native_pending + 1);
				} catch (error) {
					observer.active = false;
					throw error;
				}
				return true;
			}

			if (Symbol.asyncIterator in value) {
				this.add_source(node, native_sequence_descriptor(value, this), 'sequence');
				return true;
			}
		}
		return false;
	}

	/**
	 * Marks a custom replacer's child as requiring a private client slot instead of a target path.
	 *
	 * @param {unknown} value
	 */
	mark_opaque_child(value) {
		if (is_primitive(value)) return;
		const node = this.nodes.get(/** @type {object} */ (value));
		if (node) this.set(node, 'opaque', true);
	}

	/**
	 * Constructs an async descriptor target once and stages its server source state.
	 *
	 * @param {GraphNode} node
	 * @param {any} descriptor
	 * @param {'value' | 'sequence' | 'native'} type
	 * @returns {Source}
	 */
	add_source(node, descriptor, type) {
		let captured = false;
		const control = () => {
			if (captured) throw new TypeError('devalue: capture may only be called once');
			captured = true;
			return `s.p[${this.pending}]=$1`;
		};
		const source = descriptor.construct((/** @type {string} */ expression) =>
			control().replace('$1', () => needs_parentheses(expression) ? `(${expression})` : expression)
		);
		if (typeof source !== 'string') throw new TypeError('Invalid async descriptor construct result');
		node.kind = 'Async';
		const pending = this.pending;
		this.set(this, 'pending', pending + 1);
		/** @type {Source} */
		const state = { node, descriptor, type, started: false, terminal: false, cleaned: false, active: true, flushed_pending: 0 };
		node.data = { source, pending, captured, state };
		this.sources.add(state);
		this.unstarted.push(state);
		if (this.transaction_depth) this.undo.push(() => {
			state.active = false;
			if (state.observer) state.observer.active = false;
			this.unstarted.splice(this.unstarted.lastIndexOf(state), 1);
			if (!this.cancelled) this.sources.delete(state);
		});
		if (this.signal?.aborted) throw this.signal.reason;
		return state;
	}

	/**
	 * Routes a native Promise outcome to its source, retaining outcomes observed before startup.
	 *
	 * @param {unknown} value
	 * @param {'resolve' | 'reject'} type
	 * @param {unknown} result
	 */
	native_event(value, type, result) {
		const node = this.nodes.get(/** @type {object} */ (value));
		if (!node) return;
		const source = node.kind === 'Async' ? node.data.state : undefined;
		if (!source?.active) return;
		if (source?.started) this.event(source, type, result);
		else if (source) source.early = [type, result];
	}

	/**
	 * Validates the synchronous shape of a one-shot async descriptor without observing its source.
	 *
	 * @param {any} descriptor
	 */
	validate_value_descriptor(descriptor) {
		if ((typeof descriptor.source !== 'object' || descriptor.source === null) && typeof descriptor.source !== 'function') {
			throw new TypeError('Invalid async-value source');
		}
		for (const key of ['construct', 'resolve', 'reject']) {
			if (typeof descriptor[key] !== 'function') throw new TypeError(`Invalid async-value ${key}`);
		}
		if (descriptor.cancel !== undefined && typeof descriptor.cancel !== 'function') {
			throw new TypeError('Invalid async-value cancel');
		}
	}

	/**
	 * Validates the synchronous shape of an async sequence descriptor without acquiring an iterator.
	 *
	 * @param {any} descriptor
	 */
	validate_sequence_descriptor(descriptor) {
		if ((typeof descriptor.source !== 'object' || descriptor.source === null) && typeof descriptor.source !== 'function') {
			throw new TypeError('Invalid async-sequence source');
		}
		for (const key of ['construct', 'next', 'complete', 'error']) {
			if (typeof descriptor[key] !== 'function') throw new TypeError(`Invalid async-sequence ${key}`);
		}
		if (descriptor.cancel !== undefined && typeof descriptor.cancel !== 'function') {
			throw new TypeError('Invalid async-sequence cancel');
		}
	}

	/**
	 * Commits initial capture and initializes the count of client values awaiting termination.
	 *
	 */
	commit() {
		this.active = this.sources.size;
	}

	/** Starts every committed source and attaches session cancellation to the AbortSignal. */
	start_sources() {
		this.started = true;
		if (this.signal?.aborted) {
			void this.cancel(this.signal.reason);
			return;
		}
		this.start_unstarted();
	}

	start_unstarted() {
		const sources = this.unstarted;
		this.unstarted = [];
		for (const source of sources) this.start(source);
	}

	/**
	 * Starts observation or iteration for one committed source exactly once.
	 *
	 * @param {Source} source
	 */
	start(source) {
		if (source.started || this.cancelled) return;
		source.started = true;
		if (source.type === 'sequence') {
			this.start_sequence(source);
			return;
		}
		if (source.type === 'native') {
			if (source.early) this.event(source, source.early[0], source.early[1]);
			return;
		}
		try {
			const then = source.descriptor.source.then;
			if (typeof then !== 'function') throw new TypeError('then is not callable');
			new Promise((resolve, reject) => {
				try {
					then.call(source.descriptor.source, resolve, reject);
				} catch (error) {
					reject(error);
				}
			}).then(
				(value) => this.event(source, 'resolve', value),
				(reason) => this.event(source, 'reject', reason)
			);
		} catch (error) {
			this.event(source, 'reject', error);
		}
	}

	/**
	 * Acquires and validates an async iterator, then begins its first bounded pull.
	 *
	 * @param {Source} source
	 */
	start_sequence(source) {
		try {
			const method = source.descriptor.source[Symbol.asyncIterator];
			if (typeof method !== 'function') throw new TypeError('async iterator is not callable');
			const iterator = method.call(source.descriptor.source);
			if ((typeof iterator !== 'object' || iterator === null) && typeof iterator !== 'function') {
				throw new TypeError('async iterator is not an object');
			}
			const next = iterator.next;
			if (typeof next !== 'function') throw new TypeError('async iterator next is not callable');
			source.iterator = iterator;
			source.next = next;
			this.pull(source);
		} catch (error) {
			this.event(source, 'error', error);
		}
	}

	/**
	 * Performs at most one outstanding sequence pull and converts its result into a raw event.
	 *
	 * @param {Source} source
	 */
	pull(source) {
		if (source.terminal || source.pulling || this.cancelled) return;
		source.pulling = true;
		source.pulled = new Promise((resolve) => {
			source.pulled_resolve = resolve;
		});
		const finish = () => {
			source.pulling = false;
			source.pulled_resolve?.();
			source.pulled_resolve = undefined;
		};
		const next = source.next;
		if (!next) {
			finish();
			this.event(source, 'error', new TypeError('async iterator next is not callable'));
			return;
		}
		let result;
		try {
			result = next.call(source.iterator);
		} catch (error) {
			finish();
			this.event(source, 'error', error);
			return;
		}
		Promise.resolve(result).then(
			(result) => {
				finish();
				if (source.terminal || this.cancelled) return;
				try {
					if ((typeof result !== 'object' || result === null) && typeof result !== 'function') {
						throw new TypeError('async iterator result is not an object');
					}
					const done = result.done;
					const value = result.value;
					this.event(source, done ? 'complete' : 'next', value);
				} catch (error) {
					this.event(source, 'error', error);
				}
			},
			(error) => {
				finish();
				this.event(source, 'error', error);
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
	event(source, type, value) {
		if (source.terminal || this.cancelled) return;
		if (type !== 'next') {
			source.terminal = true;
		}
		const event = { source, type, value, sequence: this.sequence++, invalid: false };
		const source_count = this.sources.size;
		try {
			this.capture(value);
			this.validate_new_custom();
			this.active += this.sources.size - source_count;
		} catch (error) {
			this.report(error, value);
			event.type = source.type === 'sequence' ? 'error' : 'reject';
			event.value = undefined;
			event.invalid = true;
		}
		this.ready.push(event);
		if (!this.flushing) {
			this.flushing = true;
			setTimeout(() => this.flush(), 0);
		}
		// Iterators contribute at most one item to each batch. The next pull starts when
		// this batch is consumed, preventing an immediately-ready iterator from starving
		// other sources or growing the head without bound.
	}

	/**
	 * Marks a batch's events as consumed by the client and resumes sequence pulling for
	 * sources with no other unconsumed events.
	 *
	 * @param {Batch} batch
	 */
	consume(batch) {
		for (const event of batch.events) event.source.flushed_pending--;
		for (const event of batch.events) {
			if (event.type === 'next' && event.source.flushed_pending === 0) this.pull(event.source);
		}
	}

	/** Finalizes the current ready events as one ordered batch and wakes waiting tail reads. */
	flush() {
		this.flushing = false;
		if (this.cancelled || this.ready.length === 0) return;
		const events = this.ready;
		this.ready = [];
		events.sort((a, b) => a.sequence - b.sequence);
		for (const event of events) event.source.flushed_pending++;
		this.batches.push({ events });
		this.notify();
	}

	/** Waits for the same scheduled flush window used by tail batches before freezing the head. */
	initial_window() {
		return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => {
			const settle = () => setTimeout(() => this.flushing ? settle() : resolve(), 0);
			settle();
		});
	}

	/**
	 * Emits one walked graph region, optionally retaining references for future regions.
	 *
	 * @param {unknown} value
	 * @param {boolean} persistent
	 * @param {Set<GraphNode>} [references]
	 * @returns {{ source: string, tokens: Map<string, { node: GraphNode, reference: Reference }> }}
	 */
	emit_region(value, persistent, references) {
		/** Canonical node list; edges carry indices into it, avoiding identity-map lookups. */
		const nodes_list = this.node_list;
		/** Resolves a recorded edge to its node, or undefined for a primitive edge. @param {{ node: number } | { value: unknown }} reference */
		const node_of = (reference) => 'node' in reference ? /** @type {GraphNode} */ (nodes_list[reference.node]) : undefined;

		// Region-local analysis state lives in scratch fields on the nodes themselves,
		// tagged with a fresh epoch, instead of per-region Maps/Sets keyed by node.
		// `node.epoch === epoch` means "included in this region".
		const epoch = ++this.region_epoch;
		/** @type {GraphNode[]} */
		const order = [];
		/** @param {GraphNode | undefined} node */
		const visit = (node) => {
			if (!node || node.reference || node.epoch === epoch) return;
			node.epoch = epoch;
			node.uses = 0;
			node.hoisted = false;
			node.early = false;
			node.latest = -1;
			node.name = '';
			node.rendering = false;
			// Post-order: children are declared before parents so declarations can embed
			// them as literals; only back-edges (cycles) need post-declaration patches.
			for (const edge of node.edges) visit(node_of(edge));
			node.position = order.push(node) - 1;
		};
		if (!is_primitive(value)) visit(this.nodes.get(/** @type {object} */ (value)));

		/**
		 * Invokes a callback for each represented child node (undefined for primitive
		 * children) with its in-region occurrence count.
		 *
		 * @param {GraphNode} node
		 * @param {(child: GraphNode | undefined, occurrences: number) => void} callback
		 */
		const each_child = (node, callback) => {
			switch (node.kind) {
				case 'Array':
				case 'Object':
				case 'NullObject':
					for (const entry of node.data.entries) callback(node_of(entry[1]), 1);
					break;
				case 'Set':
					for (const member of node.data.values) callback(node_of(member), 1);
					break;
				case 'Map':
					for (const entry of node.data.entries) {
						callback(node_of(entry[0]), 1);
						callback(node_of(entry[1]), 1);
					}
					break;
				case 'Custom':
					for (const [token, child] of node.data.tokens) {
						callback(child, count_occurrences(node.data.source, token));
					}
					break;
				default:
					if (is_view(node.kind)) callback(node_of(node.data.buffer), 1);
			}
		};

		// In-region use counts; a node used once can be inlined at its single use site.
		/**
		 * @param {GraphNode | undefined} node
		 * @param {number} occurrences
		 */
		const bump = (node, occurrences = 1) => {
			if (node && node.epoch === epoch) node.uses += occurrences;
		};
		if (!is_primitive(value)) bump(this.nodes.get(/** @type {object} */ (value)));
		for (const node of order) {
			each_child(node, bump);
			// Persistent Set/Map sidecars re-reference each retained element, so those
			// elements must be hoisted names rather than duplicated inline literals.
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) each_child(node, bump);
		}

		/** @param {GraphNode} node */
		const is_sparse = (node) => node.kind === 'Array' && node.data.entries.length !== node.data.length;
		let hoisted_count = 0;
		for (const node of order) {
			if (node.uses > 1 || node.opaque || node.kind === 'NullObject' || is_sparse(node)) {
				node.hoisted = true;
				hoisted_count++;
			}
		}

		// Containers that must be declared (empty) ahead of every literal declaration
		// because an atomic node's constructor needs their name before their post-order slot.
		/**
		 * Reports whether a child's expansion reaches a name declared at or after `limit`.
		 *
		 * @param {GraphNode | undefined} node
		 * @param {number} limit
		 * @param {Set<GraphNode>} seen
		 * @returns {boolean}
		 */
		const references_later = (node, limit, seen) => {
			if (!node || node.epoch !== epoch) return false;
			if (node.hoisted) return node.early ? false : node.position >= limit;
			if (seen.has(node)) return false;
			seen.add(node);
			let found = false;
			each_child(node, (child) => {
				if (!found && references_later(child, limit, seen)) found = true;
			});
			return found;
		};
		// Atomic nodes (customs, views) embed child expressions in their declaration and
		// cannot defer them to fills. A direct container child whose expansion reaches a name
		// declared at or after the atomic is hoisted (its back-edges become fills); a direct
		// child that is itself a later-declared hoisted container is declared empty up front;
		// a direct atomic child is secured recursively (atomics cannot defer anything).
		/** @param {GraphNode} node */
		const secure_atomic = (node) => {
			const limit = node.position;
			each_child(node, (child_node) => {
				if (!child_node || child_node.epoch !== epoch) return;
				if (child_node.hoisted) {
					if (!child_node.early && child_node.position >= limit) {
						child_node.early = true;
					}
					return;
				}
				if (!references_later(child_node, limit, new Set())) return;
				if (is_atomic(child_node.kind)) secure_atomic(child_node);
				child_node.hoisted = true;
				hoisted_count++;
			});
		};
		for (const node of order) {
			if (is_atomic(node.kind) && node.hoisted) secure_atomic(node);
		}

		// `hoisted` and `early` are final now, so "does this child's expansion reach a
		// name declared at or after position `limit`?" reduces to one memoized number per
		// node: the latest declaration position its inline expansion can reach. Children
		// precede parents in post-order, and any back-edge target is necessarily hoisted
		// (a cycle entry always has two or more uses), so one bottom-up pass suffices.
		/**
		 * @param {GraphNode | undefined} node
		 * @returns {number}
		 */
		const latest_of = (node) => {
			if (!node || node.epoch !== epoch) return -1;
			if (node.hoisted) return node.early ? -1 : node.position;
			return node.latest;
		};
		/**
		 * @param {{ node: number } | { value: unknown }} reference
		 * @returns {number}
		 */
		const latest_of_ref = (reference) => 'value' in reference ? -1 : latest_of(/** @type {GraphNode} */ (nodes_list[reference.node]));
		if (hoisted_count > 0) {
			for (const node of order) {
				if (node.hoisted) continue;
				let reach = -1;
				each_child(node, (child) => {
					const value = latest_of(child);
					if (value > reach) reach = value;
				});
				node.latest = reach;
			}
		}

		let name_count = 0;
		for (const node of order) if (node.hoisted) node.name = `v${name_count++}`;

		/** @type {string[]} */
		const fill = [];
		/** @type {string[]} */
		const sidecars = [];
		/** @type {string[]} */
		const slots = [];
		const tokens = new Map();
		/**
		 * @param {unknown} thing
		 * @returns {string}
		 */
		const expression = (thing) => {
			if (is_primitive(thing)) return stringify_primitive(thing);
			const node = this.nodes.get(/** @type {object} */ (thing));
			if (!node) throw this.error('Cannot stringify value', thing);
			return expression_node(node);
		};
		/**
		 * @param {GraphNode} node
		 * @returns {string}
		 */
		const expression_node = (node) => {
			if (node.reference && node.epoch !== epoch) {
				references?.add(node);
				if (references) {
					const token = this.placeholder();
					tokens.set(token, { node, reference: node.reference });
					return token;
				}
				return render_reference(node.reference);
			}
			if (node.epoch === epoch && node.name) return node.name;
			// `rendering` guards against unexpected re-entry while expanding inline.
			if (node.rendering) throw this.error('Cannot stringify value', node.value);
			node.rendering = true;
			try {
				return inline(node);
			} finally {
				node.rendering = false;
			}
		};
		/** @param {{ node: number } | { value: unknown }} reference */
		const expression_ref = (reference) =>
			'value' in reference ? stringify_primitive(reference.value) : expression_node(/** @type {GraphNode} */ (nodes_list[reference.node]));

		/**
		 * Emits the full construction of a single-use node at its use site.
		 *
		 * @param {GraphNode} node
		 * @returns {string}
		 */
		const inline = (node) => {
			switch (node.kind) {
				case 'Array':
					return `[${node.data.entries.map((/** @type {[string, any]} */ entry) => expression_ref(entry[1])).join(',')}]`;
				case 'Object':
					return `{${node.data.entries.map((/** @type {[string, any]} */ entry) => `${literal_key(entry[0])}:${expression_ref(entry[1])}`).join(',')}}`;
				case 'Set': {
					const members = node.data.values;
					return members.length ? `new Set([${members.map(expression_ref).join(',')}])` : 'new Set';
				}
				case 'Map': {
					const entries = node.data.entries;
					return entries.length
						? `new Map([${entries.map((/** @type {[any, any]} */ entry) => `[${expression_ref(entry[0])},${expression_ref(entry[1])}]`).join(',')}])`
						: 'new Map';
				}
				case 'Async':
					return node.data.source;
				case 'Custom': {
					if (node.data.tokens.size === 0) return node.data.source;
					return node.data.source.replace(TOKEN_PATTERN, (/** @type {string} */ match) => {
						const child = node.data.tokens.get(match);
						return child ? expression_node(child) : match;
					});
				}
				default:
					return scalar(node, expression_ref);
			}
		};

		/** @type {string[]} */
		const early_declarations = [];
		/** @type {string[]} */
		const declarations = [];
		for (const node of order) {
			const name = node.name;
			if (name && node.early) {
				// Declared empty ahead of every literal so atomic constructors can reference it.
				switch (node.kind) {
					case 'Array':
						early_declarations.push(`${name}=Array(${node.data.length})`);
						for (const [key, child] of node.data.entries) fill.push(`${name}[${key}]=${expression_ref(child)}`);
						break;
					case 'Object':
					case 'NullObject':
						early_declarations.push(`${name}=${node.kind === 'NullObject' ? 'Object.create(null)' : '{}'}`);
						for (const [key, child] of node.data.entries) fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						break;
					case 'Set':
						early_declarations.push(`${name}=new Set`);
						for (const child of node.data.values) fill.push(`${name}.add(${expression_ref(child)})`);
						break;
					case 'Map':
						early_declarations.push(`${name}=new Map`);
						for (const [key, child] of node.data.entries) fill.push(`${name}.set(${expression_ref(key)},${expression_ref(child)})`);
						break;
					default:
						throw this.error('Cannot stringify value', node.value);
				}
			} else if (name) {
				// A child can be embedded in this declaration if its expansion never reaches
				// a name declared at or after this node; back-edges become fills instead.
				const limit = node.position;
				/** @param {{ node: number } | { value: unknown }} child */
				const available = (child) => latest_of_ref(child) < limit;
				switch (node.kind) {
					case 'Array': {
						if (is_sparse(node)) {
							declarations.push(`${name}=Array(${node.data.length})`);
							for (const [key, child] of node.data.entries) fill.push(`${name}[${key}]=${expression_ref(child)}`);
							break;
						}
						const parts = [];
						for (const [key, child] of node.data.entries) {
							if (available(child)) parts.push(expression_ref(child));
							else {
								parts.push('');
								fill.push(`${name}[${key}]=${expression_ref(child)}`);
							}
						}
						// A trailing elision needs one extra comma to preserve length.
						declarations.push(`${name}=[${parts.join(',')}${parts.length && parts[parts.length - 1] === '' ? ',' : ''}]`);
						break;
					}
					case 'Object': {
						const embedded = [];
						for (const [key, child] of node.data.entries) {
							if (available(child)) embedded.push(`${literal_key(key)}:${expression_ref(child)}`);
							else fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						}
						declarations.push(`${name}={${embedded.join(',')}}`);
						break;
					}
					case 'NullObject': {
						declarations.push(`${name}=Object.create(null)`);
						for (const [key, child] of node.data.entries) fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						break;
					}
					case 'Set': {
						// Insertion order is observable, so embed only when every member is ready.
						const members = node.data.values;
						if (members.every(available)) {
							declarations.push(`${name}=${members.length ? `new Set([${members.map(expression_ref).join(',')}])` : 'new Set'}`);
						} else {
							declarations.push(`${name}=new Set`);
							for (const child of members) fill.push(`${name}.add(${expression_ref(child)})`);
						}
						break;
					}
					case 'Map': {
						const entries = node.data.entries;
						if (entries.every((/** @type {[any, any]} */ [key, child]) => available(key) && available(child))) {
							declarations.push(`${name}=${entries.length ? `new Map([${entries.map((/** @type {[any, any]} */ [key, child]) => `[${expression_ref(key)},${expression_ref(child)}]`).join(',')}])` : 'new Map'}`);
						} else {
							declarations.push(`${name}=new Map`);
							for (const [key, child] of entries) fill.push(`${name}.set(${expression_ref(key)},${expression_ref(child)})`);
						}
						break;
					}
					default:
						declarations.push(`${name}=${inline(node)}`);
				}
			}
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) {
				// Retain only non-primitive elements in a flat sidecar so future regions can
				// reference identities that Set/Map containers do not expose through paths.
				/** @type {Array<{ node: number }>} */
				const elements = (node.kind === 'Set' ? node.data.values : node.data.entries.flat())
					.filter((/** @type {{ node: number } | { value: unknown }} */ child) => 'node' in child);
				if (elements.length) {
					const index = this.collection;
					this.set(this, 'collection', index + 1);
					sidecars.push(`s.c[${index}]=[${elements.map(expression_ref).join(',')}]`);
					for (let i = 0; i < elements.length; i++) {
						const child = elements[i];
						this.reference_node(/** @type {GraphNode} */ (nodes_list[child.node]), { root: `s.c[${index}]`, segments: [`[${i}]`] });
					}
				}
			}
		}

		const root = expression(value);
		if (persistent) {
			for (const node of order) {
				if (!node.opaque) continue;
				const index = this.slot;
				this.set(this, 'slot', index + 1);
				slots.push(`s.s[${index}]=${node.name}`);
				this.set(node, 'reference', { root: `s.s[${index}]`, segments: [] });
				this.assign_references(node.value, node.reference, new Map());
			}
		}
		const all_declarations = early_declarations.concat(declarations);
		const statements = [
			...(all_declarations.length ? [`let ${all_declarations.join(',')}`] : []),
			...fill,
			...sidecars,
			...slots
		];
		const body = [...statements, `return ${root}`].join(';');
		return {
			source: statements.length ? `(()=>{${body}})()` : root,
			tokens
		};
	}

	/**
	 * Records a client reference when it is the shortest known source expression for an identity.
	 *
	 * @param {unknown} value
	 * @param {Reference} reference
	 */
	reference(value, reference) {
		if (!is_primitive(value)) {
			const node = this.nodes.get(/** @type {object} */ (value));
			if (node) this.reference_node(node, reference);
		}
	}

	/**
	 * @param {GraphNode} node
	 * @param {Reference} reference
	 */
	reference_node(node, reference) {
		if (!node.reference || reference_length(reference) < reference_length(node.reference)) {
			this.set(node, 'reference', reference);
		}
	}

	/**
	 * Walks stable graph edges and assigns the cheapest reachable client reference to each node.
	 *
	 * @param {unknown} value
	 * @param {Reference} reference
	 * @param {Map<GraphNode, number>} seen
	 */
	assign_references(value, reference, seen) {
		if (is_primitive(value)) return;
		const node = this.nodes.get(/** @type {object} */ (value));
		if (node) this.assign_references_node(node, reference, seen);
	}

	/**
	 * @param {GraphNode} node
	 * @param {Reference} reference
	 * @param {Map<GraphNode, number>} seen
	 */
	assign_references_node(node, reference, seen) {
		this.reference_node(node, reference);
		const length = reference_length(reference);
		const previous = seen.get(node);
		if (previous !== undefined && previous <= length) return;
		seen.set(node, length);
		const nodes_list = this.node_list;
		if (node.kind === 'Array') {
			for (const [key, child] of node.data.entries) {
				if ('node' in child) this.assign_references_node(nodes_list[child.node], append_reference(reference, `[${key}]`), seen);
			}
		} else if (node.kind === 'Object' || node.kind === 'NullObject') {
			for (const [key, child] of node.data.entries) {
				if ('node' in child) this.assign_references_node(nodes_list[child.node], append_reference(reference, prop(key)), seen);
			}
		} else if (is_view(node.kind)) {
			const buffer = node.data.buffer;
			if ('node' in buffer) this.assign_references_node(nodes_list[buffer.node], append_reference(reference, '.buffer'), seen);
		}
	}

	/**
	 * Wraps the head region with client table and session initialization, folding any
	 * pre-head operations (initial batches, cleanup) into the same closure.
	 *
	 * @param {{ source: string }} region
	 * @param {string} [operations]
	 * @returns {string}
	 */
	wrap_head(region, operations = '') {
		const scope = this.scope;
		const id = stringify_string(this.id);
		// The dispatch helper is only defined when a tail exists; every tail block calls
		// it to receive `s`/`n`, replacing a longer per-block lookup preamble.
		const dispatch = this.emit_dispatch ? ';s.b=f=>f(s,n)' : '';
		const table = `let n=${scope}||(${scope}={__proto__:null}),s=n[${id}]={a:[],s:[],c:[],p:[]}${dispatch}`;
		// Resolve in evaluation order: the root region runs before folded operations.
		const resolved_region = this.resolve_runtime_declarations(region.source);
		const resolved_operations = this.resolve_runtime_declarations(operations);
		const defs = resolved_region.defs.concat(resolved_operations.defs);
		const prelude = defs.length ? `;${defs.join(';')}` : '';
		operations = resolved_operations.source;
		if (!operations) return `(()=>{${table}${prelude};return s.a[0]=${resolved_region.source}})()`;
		if (!operations.endsWith(';')) operations += ';';
		return `(()=>{${table}${prelude};let r=s.a[0]=${resolved_region.source};${operations}return r})()`;
	}

	/**
	 * Emits source that removes this session from the retained table.
	 *
	 * @returns {string}
	 */
	cleanup_source() {
		const id = stringify_string(this.id);
		return `delete n[${id}]`;
	}

	/**
	 * Transactionally generates ordered client operations for a finalized event batch.
	 *
	 * @param {Batch} batch
	 * @param {boolean} block
	 * @returns {string}
	 */
	emit_batch(batch, block = true) {
		const prefix = block ? `;${this.scope}[${stringify_string(this.id)}].b((s,n)=>{` : '';
		const marker = this.begin_transaction();
		const operations = [];
		/** @type {Set<GraphNode>} */
		const references = new Set();
		let cost = 0;
		try {
		for (const [index, event] of batch.events.entries()) {
			// Split an over-budget batch: emit what fits, requeue the rest as the next batch.
			// A single oversized operation still ships whole, so blocks may exceed the budget.
			if (index > 0 && cost >= this.budget) {
				this.batches.splice(this.batch_index, 0, { events: batch.events.slice(index) });
				batch.events = batch.events.slice(0, index);
				break;
			}
			const source = event.source;
			const node = source.node;
			const operations_before = operations.length;
			references.add(node);
			const target_token = this.placeholder();
			const control_token = node.data.captured ? this.placeholder() : undefined;
			const reference = {
				target: target_token,
				control: control_token
			};
			let value_source;
			/** @type {{ name: string, write: string, folded: string, tokens: Map<string, any> } | undefined} */
			let anchor;
			if (!event.invalid) {
				// Persistent: async outcomes must retain Map/Set element and opaque custom
				// child identities for future regions, exactly like the head region.
				const region = this.emit_region(event.value, true, references);
				value_source = region.source;
				if (!is_primitive(event.value)) {
					const index = this.anchor;
					this.set(this, 'anchor', index + 1);
					this.assign_references(event.value, { root: `s.a[${index}]`, segments: [] }, new Map());
					const name = `s.a[${index}]`;
					// Implicit anchoring: anchor indices are allocated monotonically and every
					// allocated index is written exactly once in allocation order, so once the
					// push helper pays for itself the client can derive the index positionally
					// (`s.a.push`) instead of receiving it as an explicit assignment. Explicit
					// writes before the switch keep `s.a` dense, so mixing both forms is safe.
					const use_helper = this.runtimes_emitted.v || index > 5;
					const write = use_helper
						? `${this.runtime_token('v')}(${region.source})`
						: `${name}=${region.source}`;
					// Defer the anchor write: when the operation uses the value exactly
					// once, the write is folded into that use site. A helper call is a
					// primary expression; only the assignment form needs parentheses.
					anchor = { name, write, folded: use_helper ? write : `(${write})`, tokens: region.tokens };
					value_source = this.placeholder();
				}
			} else {
				value_source = generic_error;
			}

			try {
				let operation;
				if (event.type === 'resolve') operation = source.descriptor.resolve(reference, value_source);
				else if (event.type === 'reject') operation = source.descriptor.reject(reference, value_source);
				else if (event.type === 'next') operation = source.descriptor.next(reference, value_source);
				else if (event.type === 'complete') operation = source.descriptor.complete(reference, value_source);
				else operation = source.descriptor.error(reference, value_source);
				if (typeof operation !== 'string') throw new TypeError('Invalid async descriptor operation');
				const tokens = operation_tokens(node, target_token, control_token);
				if (anchor) {
					if (count_occurrences(operation, value_source) === 1) {
						operation = operation.replace(value_source, () => anchor.folded);
					} else {
						operations.push({ source: anchor.write, tokens: anchor.tokens });
						operation = operation.split(value_source).join(anchor.name);
					}
					for (const [token, value] of anchor.tokens) tokens.set(token, value);
				}
				operations.push({ source: operation, tokens });
			} catch (error) {
				if (event.type === 'resolve' || event.type === 'next' || event.type === 'complete') {
					this.report(error, event.value);
					// The outcome's identities were assigned anchor references, so the anchor
					// must still ship even though the operation falls back to a generic error.
					if (anchor) operations.push({ source: anchor.write, tokens: anchor.tokens });
					const fallback = source.type === 'sequence'
						? source.descriptor.error(reference, generic_error)
						: source.descriptor.reject(reference, generic_error);
					if (typeof fallback !== 'string') throw new TypeError('Invalid async descriptor operation');
					operations.push({ source: fallback, tokens: operation_tokens(node, target_token, control_token) });
					this.set(event, 'type', source.type === 'sequence' ? 'error' : 'reject');
				} else {
					throw error;
				}
			}
			if (event.type !== 'next' && node.data.captured && !source.descriptor.manages_pending) {
				operations.push({ source: `delete s.p[${node.data.pending}]`, tokens: new Map() });
			}
			if (event.type !== 'next') {
				this.set(this, 'active', this.active - 1);
				if (source.type === 'sequence' && event.type === 'error') this.set(source, 'needs_close', true);
			}
			for (let i = operations_before; i < operations.length; i++) cost += operations[i].source.length + 1;
		}
		const rendered = this.render_operations(operations, references);
		if (block && this.active === 0 && this.ready.length === 0 && this.batch_index === this.batches.length) {
			rendered.push(this.cleanup_source());
		}
		let body = rendered.join(';');
		if (block) {
			// Standalone blocks are final output; resolve helper placeholders here so every
			// definition is evaluated in the same block as (and before) its first use.
			// Head-folded operations are resolved later by wrap_head instead.
			const resolved = this.resolve_runtime_declarations(body);
			body = resolved.defs.length ? `${resolved.defs.join(';')};${resolved.source}` : resolved.source;
		}
		const result = prefix + body + (block ? '})' : rendered.length ? ';' : '');
		this.commit_transaction(marker);
		return result;
		} catch (error) {
			this.rollback_transaction(marker);
			throw error;
		}
	}

	/**
	 * Promotes repeatedly used long paths into client slots when doing so shortens this batch.
	 *
	 * @param {Array<{ source: string, tokens: Map<string, { node?: GraphNode, reference?: Reference, source?: string }> }>} operations
	 * @param {Set<GraphNode>} references
	 */
	render_operations(operations, references) {
		const uses = new Map();
		const imported_references = new Map();
		const pattern = TOKEN_PATTERN;
		for (const operation of operations) {
			if (operation.tokens.size === 0) continue;
			for (const match of operation.source.matchAll(pattern)) {
				const token = operation.tokens.get(match[0]);
				if (!token?.node) continue;
				uses.set(token.node, (uses.get(token.node) ?? 0) + 1);
				if (token.reference && !imported_references.has(token.node)) {
					imported_references.set(token.node, token.reference);
				}
			}
		}
		const candidates = [];
		for (const node of references) {
			if (!node.reference || node.reference.root.startsWith('s.s[')) continue;
			const path = render_reference(imported_references.get(node) ?? node.reference);
			const count = uses.get(node) ?? 0;
			if (count < 2) continue;
			candidates.push({ node, path, uses: count });
		}
		candidates.sort((a, b) => b.path.length - a.path.length);
		const aliases = new Map();
		const prefix = [];
		for (const { node, path, uses } of candidates) {
			const slot = `s.s[${this.slot}]`;
			if (`${slot}=${path};`.length + slot.length * uses >= path.length * uses) continue;
			this.set(this, 'slot', this.slot + 1);
			prefix.push(`${slot}=${path}`);
			aliases.set(node, slot);
			this.set(node, 'reference', { root: slot, segments: [] });
		}
		return prefix.concat(operations.map((operation) => {
			if (operation.tokens.size === 0) return operation.source;
			// Single pass replaces every mapped placeholder instead of one split/join per token.
			return operation.source.replace(pattern, (match) => {
				const value = operation.tokens.get(match);
				if (!value) return match;
				return /** @type {string} */ (value.node
					? aliases.get(value.node) ?? render_reference(value.reference ?? value.node.reference)
					: value.source);
			});
		}));
	}

	/**
	 * Returns a quoted numeric source token. A real string containing the same quote
	 * characters escapes them when serialized, so it cannot contain this exact source.
	 *
	 * @returns {string}
	 */
	placeholder() {
		return `"${this.token++}"`;
	}

	/**
	 * Creates the one-shot async iterator that generates batches and drives sequence backpressure.
	 *
	 * @returns {UnevalStreamTail}
	 */
	tail() {
		const session = this;
		let pending = false;
		/** @type {Promise<IteratorResult<string, void>> | undefined} */
		let advancing;
		let done = false;
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				if (pending) {
					return Promise.reject(new TypeError('devalue: concurrent tail.next() is not supported'));
				}
				return advancing = advance();
			},
			async return() {
				if (done) return { done: true, value: undefined };
				done = true;
				const cancelling = session.cancel();
				if (advancing) {
					try {
						await advancing;
					} catch {}
				}
				await cancelling;
				if (session.failure) throw session.failure;
				return { done: true, value: undefined };
			}
		};

		/** @returns {Promise<IteratorResult<string, void>>} */
		async function advance() {
				if (done) {
					if (session.failure) throw session.failure;
					return { done: true, value: undefined };
				}
				pending = true;
				try {
		while (session.batch_index === session.batches.length && session.active > 0 && !session.failure && !session.cancelled) {
						await new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => session.waiters.push(resolve));
					}
					if (session.failure) throw session.failure;
					if (session.cancelled) {
						await session.cancelling;
						done = true;
						if (session.failure) throw session.failure;
						return { done: true, value: undefined };
					}
					const batch = session.batches[session.batch_index++];
					if (!batch) {
						done = true;
						return { done: true, value: undefined };
					}
					let block;
					try {
						block = session.emit_batch(batch);
					} catch (error) {
						await session.cancel(error);
						throw session.failure ?? error;
					}
					if (session.batch_index > 1024 && session.batch_index * 2 >= session.batches.length) {
						session.batches = session.batches.slice(session.batch_index);
						session.batch_index = 0;
					}
					let close_failure;
					for (const event of batch.events) {
						if (!event.source.needs_close) continue;
						event.source.needs_close = false;
						try {
							await session.close_sequence(event.source);
						} catch (error) {
							close_failure ??= error;
						}
					}
					session.start_unstarted();
					session.consume(batch);
					if (close_failure) session.fail(close_failure);
					return { done: false, value: block };
				} finally {
					pending = false;
				}
		}
	}

	/** Wakes every tail read currently waiting for delivery or lifecycle state to change. */
	notify() {
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Idempotently starts server-side cleanup and returns the shared cleanup operation.
	 *
	 * @param {unknown} [reason]
	 * @returns {Promise<void>}
	 */
	async cancel(reason) {
		if (this.cancelling) return this.cancelling;
		this.cancelled = true;
		this.notify();
		this.cancelling = this.cleanup(reason);
		return this.cancelling;
	}

	/**
	 * Stops all sources, runs every cleanup hook, and records the first resulting failure.
	 *
	 * @param {unknown} reason
	 */
	async cleanup(reason) {
		this.signal?.removeEventListener('abort', this.abort);
		let failure;
		for (const source of this.sources) {
			if (source.cleaned) continue;
			source.cleaned = true;
			source.active = false;
			if (source.observer) source.observer.active = false;
			try {
				await this.close_sequence(source);
			} catch (error) {
				failure ??= error;
			}
			try {
				await source.descriptor.cancel?.();
			} catch (error) {
				failure ??= error;
			}
		}
		this.ready = [];
		this.batches = [];
		this.batch_index = 0;
		this.failure ??= failure ?? reason;
		this.notify();
	}

	/**
	 * Calls a sequence iterator's optional `return()` method at most once.
	 *
	 * @param {Source} source
	 */
	async close_sequence(source) {
		if (source.iterator_closed || !source.iterator) return;
		source.iterator_closed = true;
		const method = source.iterator.return;
		if (typeof method !== 'function') {
			if (source.pulled) await source.pulled;
			return;
		}
		const returned = Promise.resolve().then(() => method.call(source.iterator));
		if (source.pulled) await Promise.all([source.pulled, returned]);
		else await returned;
	}

	/**
	 * Forwards a recovered serialization failure to the diagnostic callback. The callback
	 * must never affect stream control flow, so its own exceptions are swallowed.
	 *
	 * @param {unknown} error
	 * @param {unknown} value
	 */
	report(error, value) {
		try {
			this.onerror?.(error, value);
		} catch {}
	}

	/**
	 * Records an unrecoverable protocol failure and asynchronously cancels the session.
	 *
	 * @param {unknown} error
	 */
	fail(error) {
		this.failure = error;
		void this.cancel(error);
	}

	/**
	 * Creates a DevalueError associated with the initial streamed root.
	 *
	 * @param {string} message
	 * @param {unknown} value
	 * @returns {DevalueError}
	 */
	error(message, value) {
		return new DevalueError(message, [], value, this.root_value);
	}
}

/**
 * Discovers a value into a session's canonical node list.
 * @param {Session} session
 * @param {unknown} value
 * @returns {GraphNode | undefined}
 */
function discover(session, value) {
	if (is_primitive(value)) {
		if (typeof value === 'symbol') throw discovery_error(session, 'Cannot stringify a Symbol primitive', value);
		return undefined;
	}

	const identity = /** @type {object} */ (value);
	const existing = session.nodes.get(identity);
	if (existing) return existing;

	/** @type {GraphNode} */
	const node = {
		id: session.node_list.length,
		value,
		kind: '',
		data: undefined,
		edges: [],
		epoch: 0,
		position: 0,
		uses: 0,
		hoisted: false,
		early: false,
		latest: -1,
		name: '',
		rendering: false
	};
	session.node_list.push(node);
	session.nodes.set(identity, node);
	session.added.push(identity);

	if (session.classify(value, node)) return node;
	if (typeof value === 'function') throw discovery_error(session, 'Cannot stringify a function', value);
	const type = get_type(value);
	node.kind = type;

	switch (type) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			node.data = { value: value.valueOf() };
			break;
		case 'Date':
			node.data = { time: /** @type {Date} */ (value).getTime() };
			break;
		case 'RegExp': {
			const regexp = /** @type {RegExp} */ (value);
			node.data = { source: regexp.source, flags: regexp.flags };
			break;
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
			node.data = { source: String(value) };
			break;
		case 'ArrayBuffer':
			node.data = { bytes: new Uint8Array(/** @type {ArrayBuffer} */ (value)) };
			break;
		case 'Array': {
			const array = /** @type {unknown[]} */ (value);
			/** @type {Array<[keyof unknown[], ValueRef]>} */
			const entries = [];
			for (const key of valid_array_indices(array)) {
				session.path_keys.push(key);
				session.path_kinds.push(ARRAY_INDEX);
				const child = edge(session, array[key]);
				session.path_keys.pop();
				session.path_kinds.pop();
				entries.push([key, child]);
				node.edges.push(child);
			}
			node.data = { length: array.length, entries };
			break;
		}
		case 'Set': {
			const values = Array.from(/** @type {Set<unknown>} */ (value), (child) => edge(session, child));
			node.data = { values };
			node.edges = values;
			break;
		}
		case 'Map': {
			const entries = [];
			for (const [key, child] of /** @type {Map<unknown, unknown>} */ (value)) {
				session.path_keys.push(key);
				session.path_kinds.push(MAP_KEY);
				entries.push([edge(session, key), edge(session, child)]);
				session.path_keys.pop();
				session.path_kinds.pop();
			}
			node.data = { entries };
			node.edges = entries.flat();
			break;
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
			const buffer = edge(session, view.buffer);
			node.data = { buffer, byteOffset: view.byteOffset, byteLength: view.byteLength, length: view.length };
			node.edges = [buffer];
			break;
		}
		default: {
			const object = /** @type {Record<string | symbol, unknown>} */ (value);
			if (!is_plain_object(object)) throw discovery_error(session, 'Cannot stringify arbitrary non-POJOs', value);
			if (enumerable_symbols(object).length) {
				throw discovery_error(session, 'Cannot stringify POJOs with symbolic keys', value);
			}
			/** @type {Array<[string, ValueRef]>} */
			const entries = [];
			for (const key of Object.keys(object)) {
				if (key === '__proto__') {
					throw discovery_error(session, 'Cannot stringify objects with __proto__ keys', value);
				}
				session.path_keys.push(key);
				session.path_kinds.push(OBJECT_KEY);
				const child = edge(session, object[key]);
				session.path_keys.pop();
				session.path_kinds.pop();
				entries.push([key, child]);
				node.edges.push(child);
			}
			node.kind = Object.getPrototypeOf(object) === null ? 'NullObject' : 'Object';
			node.data = { entries };
		}
	}

	return node;
}

/** @param {Session} session @param {unknown} value @returns {ValueRef} */
function edge(session, value) {
	const node = discover(session, value);
	return node ? { node: node.id } : { value };
}

/** @param {Session} session @param {string} message @param {unknown} value */
function discovery_error(session, message, value) {
	const keys = session.path_keys.map((key, index) => {
		const kind = session.path_kinds[index];
		if (kind === ARRAY_INDEX) return `[${key}]`;
		if (kind === OBJECT_KEY) return stringify_key(/** @type {string} */ (key));
		return `.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`;
	});
	return new DevalueError(message, keys, value, session.root_value);
}

/**
 * Emits a constructor expression for a captured non-container built-in.
 *
 * @param {GraphNode} node
 * @param {(value: unknown) => string} expression
 * @returns {string}
 */
function scalar(node, expression) {
	switch (node.kind) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			return `Object(${stringify_primitive(node.data.value)})`;
		case 'Date':
			return `new Date(${node.data.time})`;
		case 'RegExp': {
			return node.data.flags
				? `new RegExp(${stringify_string(node.data.source)},${stringify_string(node.data.flags)})`
				: `new RegExp(${stringify_string(node.data.source)})`;
		}
		case 'URL':
		case 'URLSearchParams':
			return `new ${node.kind}(${stringify_string(node.data.source)})`;
		case 'ArrayBuffer':
			// Native TypedArray join; avoids materializing a JS number array first.
			return `new Uint8Array([${node.data.bytes.toString()}]).buffer`;
		case 'DataView': {
			return `new DataView(${expression(node.data.buffer)},${node.data.byteOffset},${node.data.byteLength})`;
		}
		case 'Temporal.Duration':
		case 'Temporal.Instant':
		case 'Temporal.PlainDate':
		case 'Temporal.PlainTime':
		case 'Temporal.PlainDateTime':
		case 'Temporal.PlainMonthDay':
		case 'Temporal.PlainYearMonth':
		case 'Temporal.ZonedDateTime':
			return `${node.kind}.from(${stringify_string(node.data.source)})`;
		default:
			if (is_view(node.kind)) {
				return `new ${node.kind}(${expression(node.data.buffer)},${node.data.byteOffset},${node.data.length})`;
			}
			throw new Error(`Unknown stream node ${node.kind}`);
	}
}

/**
 * Reports whether a walked node kind is an ArrayBuffer view.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function is_view(kind) {
	return kind === 'DataView' || kind.endsWith('Array') && kind !== 'Array';
}

/**
 * Reports whether a node must be constructed after its represented children.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function is_atomic(kind) {
	return kind === 'Custom' || is_view(kind);
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
 * Builds the placeholder token map for one async descriptor operation.
 *
 * @param {GraphNode} node
 * @param {string} target_token
 * @param {string | undefined} control_token
 * @returns {Map<string, { node?: GraphNode, reference?: Reference, source?: string }>}
 */
function operation_tokens(node, target_token, control_token) {
	/** @type {Map<string, { node?: GraphNode, reference?: Reference, source?: string }>} */
	const tokens = new Map();
	tokens.set(target_token, { node, reference: node.reference });
	if (control_token) tokens.set(control_token, { source: `s.p[${node.data.pending}]` });
	return tokens;
}

/** Bare identifiers and bracketed identifier lists, e.g. `g` or `[a,b]`. */
const SAFE_CAPTURE_EXPRESSION = /^(?:[A-Za-z_$][\w$]*|\[[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*\])$/;

/**
 * Reports whether a captured expression must be parenthesized before being assigned.
 * Parentheses never change the meaning of a well-formed expression, so anything that is
 * not provably safe (the only under-wrapping hazard is a top-level comma, but classifying
 * arbitrary JavaScript requires a parser) is wrapped.
 *
 * @param {string} expression
 * @returns {boolean}
 */
function needs_parentheses(expression) {
	return !SAFE_CAPTURE_EXPRESSION.test(expression);
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

/**
 * Returns a structured client reference with one additional path segment.
 *
 * @param {Reference} reference
 * @param {string} segment
 * @returns {Reference}
 */
function append_reference(reference, segment) {
	return { root: reference.root, segments: [...reference.segments, segment] };
}

/**
 * Renders a structured client reference as executable source.
 *
 * @param {Reference} reference
 * @returns {string}
 */
function render_reference(reference) {
	return reference.root + reference.segments.join('');
}

/**
 * Computes the rendered length of a structured client reference without allocating it.
 *
 * @param {Reference} reference
 * @returns {number}
 */
function reference_length(reference) {
	let length = reference.root.length;
	for (const segment of reference.segments) length += segment.length;
	return length;
}

/**
 * Counts non-overlapping appearances of a reference expression in generated source.
 *
 * @param {string} source
 * @param {string} value
 * @returns {number}
 */
function count_occurrences(source, value) {
	let count = 0;
	let index = 0;
	while ((index = source.indexOf(value, index)) !== -1) {
		count++;
		index += value.length;
	}
	return count;
}

/**
 * Adapts a native Promise to the private one-shot descriptor protocol.
 *
 * @param {Promise<unknown>} promise
 * @param {Session} session
 * @returns {AsyncValueDescriptor & { manages_pending: true }}
 */
function native_descriptor(promise, session) {
	/** Pending slot index, fixed when `construct` runs during `add_source`. */
	let pending = -1;
	/**
	 * Emits a settlement at generation time, using the shared `s.r` helper once it is
	 * (or becomes) profitable and the direct pending-slot protocol otherwise.
	 *
	 * @param {{ control?: string }} reference
	 * @param {0 | 1} which
	 * @param {string} value
	 */
	const settle = ({ control }, which, value) => {
		const remaining = session.native_pending;
		session.set(session, 'native_pending', remaining - 1);
		if (session.runtimes_emitted.r || remaining >= 3) {
			return `${session.runtime_token('r')}(${pending},${which},${value})`;
		}
		return `${control}[${which}](${value});delete ${control}`;
	};
	return {
		type: 'async-value',
		source: promise,
		// Every native settlement deletes its own pending slot, so the generic
		// post-operation `delete s.p[n]` must not be emitted for this descriptor.
		manages_pending: true,
		construct: (capture) => {
			// The client stores `[resolve, reject]` in the pending slot whichever form the
			// placeholder resolves to; capture is invoked purely to mark the slot as taken.
			capture('[a,b]');
			pending = session.pending;
			return session.promise_token(pending);
		},
		resolve: (reference, value) => settle(reference, 0, value),
		reject: (reference, reason) => settle(reference, 1, reason)
	};
}

/**
 * The shared client queue runtime backing every reconstructed native AsyncIterable.
 * A session ships this text once; later sequences reference `s.f` directly.
 */
const SEQUENCE_RUNTIME = '(c)=>{let q=[],w=[],d=0,e,r=(d,v)=>({done:!!d,value:v}),a,f=()=>{while(w.length&&(q.length||d)){a=w.shift();q.length?a[0](r(0,q.shift())):d<2?a[0](r(1,e)):a[1](e)}},g=(o,v)=>d||(o?(d=o,e=v):q.push(v),f());c(g);return{[Symbol.asyncIterator](){return this},async next(){if(q.length)return r(0,q.shift());if(d>1)throw e;return d?r(1,e):new Promise((a,b)=>w.push([a,b]))},async return(v){d||(d=1,e=v,q.length=0,f());return r(1,v)},async throw(v){d||(d=2,e=v,q.length=0,f());throw v}}}';

/**
 * Session helper definitions, shipped at most once per session, always in the same block
 * as (and ahead of) their first use. Each helper must pay for itself: `w` only ships once
 * two native promises exist, `r` once three settlements are in play, `v` once six anchors
 * have been allocated, and `f` with the first sequence (whose reconstruction is
 * impossible without it).
 */
const RUNTIMES = {
	/** Shared buffered-iterator runtime for reconstructed native AsyncIterables. */
	f: SEQUENCE_RUNTIME,
	/** Creates a pending promise whose settlement functions are parked in `s.p`. */
	w: 'i=>new Promise((a,b)=>{s.p[i]=[a,b]})',
	/** Settles a parked pending promise (`j` selects resolve/reject) and frees its slot. */
	r: '(i,j,v)=>(s.p[i][j](v),delete s.p[i])',
	/** Anchors a value at the next positional index (mirrors the server's counter). */
	v: 'v=>(s.a.push(v),v)'
};

/**
 * Adapts an AsyncIterable to a buffered client AsyncIterableIterator descriptor.
 *
 * @param {object} source
 * @param {Session} session
 * @returns {AsyncSequenceDescriptor}
 */
function native_sequence_descriptor(source, session) {
	return {
		type: 'async-sequence',
		source: /** @type {AsyncIterable<unknown, unknown, unknown>} */ (source),
		construct: (capture) => `${session.runtime_token('f')}(g=>{${capture('g')}})`,
		next: ({ control }, value) => `${control}(0,${value})`,
		complete: ({ control }, value) => `${control}(1,${value})`,
		error: ({ control }, reason) => `${control}(2,${reason})`
	};
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
	/** @type {UnevalStreamTail} */
	const tail = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			return { done: true, value: undefined };
		},
		async return() {
			return { done: true, value: undefined };
		}
	};
	return tail;
}

/** @typedef {{ node: GraphNode, descriptor: any, type: 'value' | 'sequence' | 'native', started: boolean, terminal: boolean, cleaned: boolean, active: boolean, flushed_pending: number, iterator?: any, iterator_closed?: boolean, next?: Function, pulling?: boolean, pulled?: Promise<void>, pulled_resolve?: () => void, observer?: { active: boolean }, early?: ['resolve' | 'reject', unknown], needs_close?: boolean }} Source */
/** @typedef {{ source: Source, type: 'resolve' | 'reject' | 'next' | 'complete' | 'error', value: unknown, sequence: number, invalid: boolean }} Event */
/** @typedef {{ events: Event[] }} Batch */
