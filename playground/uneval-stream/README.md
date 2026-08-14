# unevalStream protocol lab

Interactive Svelte 5 playground for observing `devalue`'s streamed executable graph protocol.

Pretty formats blocks for display only, while Raw shows the exact source received over the wire.

## Setup and commands

Install once from the repository root:

```sh
pnpm install
pnpm --dir playground/uneval-stream dev
pnpm --dir playground/uneval-stream check
pnpm --dir playground/uneval-stream build
```

## Architecture

- `+page.svelte` owns immutable worker-message snapshots and the block timeline.
- `CodeEditor.svelte` embeds CodeMirror 6 with TypeScript mode and Mod-Enter execution.
- `stream.worker.ts` transpiles TypeScript to CommonJS, evaluates the user module, calls workspace `unevalStream`, and evaluates head/tail source in order in the worker realm.
- `snapshot.ts` turns the reconstructed graph into a structured-cloneable identity/reference tree without JSON serialization.
- `ObjectTree.svelte` renders recursive expandable nodes and aliases.

For inspection only, the worker drains reconstructed client `AsyncIterable`s into a visualization sidecar. This does not alter raw protocol blocks or server-side pulling/backpressure. Yield storage is capped at the snapshot item limit while iterators continue draining to completion; truncation and terminal return/error values remain visible.

## User file contract

The editor is a single TypeScript CommonJS-transpiled module. It must provide a graph as its default export, and may provide an `unevalStream` replacer as a named `replacer` export:

```ts
export class Point {
	constructor(readonly x: number, readonly y: number) {}
}

export const replacer = (value: unknown, uneval: (v: unknown) => string) => {
	if (value instanceof Point) return `new Point(${uneval(value.x)},${uneval(value.y)})`;
};

const graph = { answer: Promise.resolve(new Point(3, 4)) };
export default graph;
```

All other named exports are promoted onto the worker's global scope before head/tail blocks are evaluated, so custom constructor source emitted by the replacer (e.g. `new Point(…)`) can revive. The worker is discarded after every run, so promoted globals never leak across runs.

Static/dynamic imports and dependencies are not exposed to the user module.

## Security and limitations

Execution is isolated from the page in a dedicated module Web Worker and Stop terminates it. This is an isolation boundary for UI responsiveness, **not a hardened sandbox**: code can use worker-global browser APIs, consume CPU/memory, and initiate network requests allowed by the browser/CSP. Infinite synchronous work requires termination. TypeScript uses `transpileModule`, so it strips types but does not perform full project type-checking. Snapshots enforce depth/item/byte-preview limits and represent functions, symbols, and inaccessible properties as markers.
