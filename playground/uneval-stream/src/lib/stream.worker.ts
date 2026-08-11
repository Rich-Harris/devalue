/// <reference lib="webworker" />
import { unevalStream } from 'devalue';
import ts from 'typescript';
import { createSnapshotContext, MAX_ITEMS, snapshotGraph } from './snapshot';
import type { AsyncIterableTracker, SnapshotContext } from './snapshot';
import type { WorkerPayload } from './stream-types';

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async ({ data }: MessageEvent<{ runId: number; source: string }>) => {
	const { runId, source } = data;
	const start = performance.now();
	const post = (message: WorkerPayload) => scope.postMessage({ ...message, runId, elapsed: performance.now() - start });
	try {
		post({ type: 'status', status: 'compiling' });
		const output = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
			reportDiagnostics: true
		});
		const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
		if (errors.length) throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
		const module = { exports: {} as Record<string, unknown> };
		new Function('module', 'exports', `${output.outputText}\n//# sourceURL=example.ts`)(module, module.exports);
		const graph = module.exports.default;
		if (graph === undefined) throw new Error('example.ts must export a default graph');

		const stream = await unevalStream(graph, undefined, { id: `playground-${runId}` });
		post({ type: 'status', status: 'streaming' });
		post({ type: 'block', kind: 'head', index: 0, source: stream.head, bytes: new Blob([stream.head]).size });
		const root = new Function(`return (${stream.head})`)();
		const snapshotContext = createSnapshotContext();
		const discover = createTrackerDiscovery(snapshotContext);
		discover(root);
		await settleTrackers();
		post({ type: 'snapshot', snapshot: snapshotGraph(root, snapshotContext) });
		let index = 1;
		for await (const block of stream.tail) {
			post({ type: 'block', kind: 'tail', index, source: block, bytes: new Blob([block]).size });
			new Function(block)();
			await settleTrackers();
			post({ type: 'snapshot', snapshot: snapshotGraph(root, snapshotContext) });
			index++;
		}
		await settleTrackers();
		post({ type: 'snapshot', snapshot: snapshotGraph(root, snapshotContext) });
		post({ type: 'done' });
	} catch (error) {
		post({ type: 'error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
	}
};

function createTrackerDiscovery(context: SnapshotContext): (root: unknown) => void {
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value as object)) return;
		seen.add(value as object);
		if (value instanceof Promise) {
			const tracked = value as Promise<unknown> & { __unevalTracker?: { state: string; value?: unknown } };
			tracked.__unevalTracker = { state: 'pending' };
			value.then((result) => { tracked.__unevalTracker = { state: 'fulfilled', value: result }; visit(result); }, (reason) => { tracked.__unevalTracker = { state: 'rejected', value: reason }; });
			return;
		}
		if (Symbol.asyncIterator in (value as object)) {
			const iterable = value as AsyncIterable<unknown> & object;
			const tracker: AsyncIterableTracker = { items: [], itemCount: 0, state: 'streaming' };
			context.asyncIterables.set(iterable, tracker);
			void pump(iterable, tracker);
			return;
		}
		if (value instanceof Map) for (const [key, item] of value) { visit(key); visit(item); }
		else if (value instanceof Set) for (const item of value) visit(item);
		else for (const key of Reflect.ownKeys(value as object)) { try { visit(Reflect.get(value as object, key)); } catch { /* snapshot reports inaccessible values */ } }
	}
	async function pump(iterable: AsyncIterable<unknown>, tracker: AsyncIterableTracker): Promise<void> {
		try {
			const iterator = iterable[Symbol.asyncIterator]();
			if (!iterator || typeof iterator.next !== 'function') throw new TypeError('Async iterator did not provide next()');
			while (true) {
				const result = await iterator.next();
				if (!result || typeof result !== 'object' || typeof result.done !== 'boolean') throw new TypeError('Async iterator next() returned an invalid result');
				if (result.done) {
					tracker.returnValue = result.value;
					visit(result.value);
					tracker.state = 'complete';
					return;
				}
				tracker.itemCount++;
				if (tracker.items.length < MAX_ITEMS) tracker.items.push(result.value);
				visit(result.value);
			}
		} catch (error) {
			tracker.error = error;
			tracker.state = 'error';
			visit(error);
		}
	}
	return visit;
}

async function settleTrackers(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
