import type { SnapshotEntry, SnapshotNode } from './stream-types';

const MAX_DEPTH = 9;
export const MAX_ITEMS = 80;

export interface AsyncIterableTracker {
	items: unknown[];
	itemCount: number;
	state: 'streaming' | 'complete' | 'error';
	returnValue?: unknown;
	error?: unknown;
}

export interface SnapshotContext {
	identities: WeakMap<object, number>;
	asyncIterables: WeakMap<object, AsyncIterableTracker>;
	nextId: number;
}

export function createSnapshotContext(): SnapshotContext {
	return { identities: new WeakMap(), asyncIterables: new WeakMap(), nextId: 1 };
}

export function snapshotGraph(root: unknown, context = createSnapshotContext()): SnapshotNode {
	const visited = new Set<object>();

	function primitive(value: unknown): SnapshotNode | undefined {
		if (value === null) return { kind: 'null', value: 'null' };
		switch (typeof value) {
			case 'undefined': return { kind: 'undefined', value: 'undefined' };
			case 'string': return { kind: 'string', value };
			case 'boolean': return { kind: 'boolean', value: String(value) };
			case 'number': return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
			case 'bigint': return { kind: 'bigint', value: `${value}n` };
			case 'symbol': return { kind: 'symbol', value: String(value) };
			case 'function': return { kind: 'function', value: `[Function ${(value as Function).name || 'anonymous'}]` };
		}
	}

	function visit(value: unknown, depth: number): SnapshotNode {
		const leaf = primitive(value);
		if (leaf) return leaf;
		const object = value as object;
		let id = context.identities.get(object);
		if (id === undefined) {
			id = context.nextId++;
			context.identities.set(object, id);
		}
		if (visited.has(object)) return { kind: 'ref', ref: id };
		visited.add(object);
		if (depth >= MAX_DEPTH) return { kind: 'truncated', id, value: 'depth limit' };

		if (value instanceof Promise) {
			const tracker = (value as Promise<unknown> & { __unevalTracker?: { state: string; value?: unknown } }).__unevalTracker;
			return tracker
				? { kind: 'Promise', id, state: tracker.state as 'pending' | 'fulfilled' | 'rejected', children: tracker.state === 'pending' ? [] : [{ key: tracker.state === 'rejected' ? 'reason' : 'value', value: visit(tracker.value, depth + 1) }] }
				: { kind: 'Promise', id, state: 'pending' };
		}
		if (value instanceof Date) return { kind: 'Date', id, value: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
		if (value instanceof RegExp) return { kind: 'RegExp', id, value: String(value) };
		if (value instanceof URL) return { kind: 'URL', id, value: value.href };
		if (value instanceof URLSearchParams) return { kind: 'URLSearchParams', id, value: value.toString() };
		if (value instanceof ArrayBuffer) return { kind: 'ArrayBuffer', id, meta: `${value.byteLength} bytes`, value: bytes(new Uint8Array(value)) };
		if (ArrayBuffer.isView(value)) {
			const view = value as ArrayBufferView;
			return { kind: value.constructor.name, id, meta: `${view.byteLength} bytes`, value: bytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
		}
		if (value instanceof Map) {
			const children: SnapshotEntry[] = [];
			let index = 0;
			for (const [key, item] of value) {
				if (index >= MAX_ITEMS) break;
				children.push({ key: `entry ${index}`, value: { kind: 'entry', children: [{ key: 'key', value: visit(key, depth + 1) }, { key: 'value', value: visit(item, depth + 1) }] } });
				index++;
			}
			return { kind: 'Map', id, meta: `${value.size} entries`, children: truncate(children, value.size) };
		}
		if (value instanceof Set) {
			const children = Array.from(value).slice(0, MAX_ITEMS).map((item, index) => ({ key: String(index), value: visit(item, depth + 1) }));
			return { kind: 'Set', id, meta: `${value.size} values`, children: truncate(children, value.size) };
		}
		if (value instanceof Error) return { kind: value.name, id, value: value.message, children: value.cause === undefined ? [] : [{ key: 'cause', value: visit(value.cause, depth + 1) }] };
		if (Symbol.asyncIterator in object) {
			const tracker = context.asyncIterables.get(object);
			if (!tracker) return { kind: 'AsyncIterable', id, value: '[async sequence not inspected]' };
			const children = tracker.items.map((item, index) => ({ key: `yield ${index}`, value: visit(item, depth + 1) }));
			if (tracker.itemCount > tracker.items.length) children.push({ key: '…', value: { kind: 'truncated', value: `${tracker.itemCount - tracker.items.length} more yields` } });
			if (tracker.state === 'complete') children.push({ key: 'return', value: visit(tracker.returnValue, depth + 1) });
			else if (tracker.state === 'error') children.push({ key: 'error', value: visit(tracker.error, depth + 1) });
			return { kind: 'AsyncIterable', id, state: tracker.state, meta: `${tracker.itemCount} ${tracker.itemCount === 1 ? 'item' : 'items'}${tracker.itemCount > tracker.items.length ? ` · showing ${tracker.items.length}` : ''}`, children };
		}

		const keys = Reflect.ownKeys(object);
		const children: SnapshotEntry[] = [];
		for (const key of keys.slice(0, MAX_ITEMS)) {
			try { children.push({ key: typeof key === 'symbol' ? String(key) : key, value: visit(Reflect.get(object, key), depth + 1) }); }
			catch (error) { children.push({ key: String(key), value: { kind: 'Thrown', value: error instanceof Error ? error.message : String(error) } }); }
		}
		return { kind: Array.isArray(value) ? 'Array' : value?.constructor?.name || 'Object', id, meta: Array.isArray(value) ? `${value.length} items` : undefined, children: truncate(children, keys.length) };
	}

	return visit(root, 0);
}

function bytes(value: Uint8Array): string {
	const shown = Array.from(value.slice(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
	return value.length > 32 ? `${shown} …` : shown;
}

function truncate(children: SnapshotEntry[], size: number): SnapshotEntry[] {
	return size > MAX_ITEMS ? [...children, { key: '…', value: { kind: 'truncated', value: `${size - MAX_ITEMS} more` } }] : children;
}
