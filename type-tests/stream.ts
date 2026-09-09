import {
	unevalStream,
	type AsyncSequenceDescriptor,
	type AsyncValueDescriptor,
	type ClientReference,
	type JavaScriptSource,
	type JavaScriptTag,
	type UnevalStreamOptions,
	type UnevalStreamReplacer,
	type UnevalStreamResult,
	type UnevalStreamTail
} from 'devalue';

declare const promise: Promise<number>;
declare const sequence: AsyncIterable<number, string>;

declare const source: JavaScriptSource;
declare const js: JavaScriptTag;
const config = { retries: 2 };
const reference: ClientReference = { target: source, control: source };

const value: AsyncValueDescriptor<number> = {
	type: 'async-value',
	source: promise,
	construct: (capture) => js`new RemoteValue(${config},${capture(js`[${config}]`)})`,
	resolve: ({ target }, result) => js`${target}.resolve(${result},${config})`,
	reject: ({ target }, reason) => js`${target}.reject(${reason},${config})`
};

const iterable: AsyncSequenceDescriptor<number, string> = {
	type: 'async-sequence',
	source: sequence,
	construct: () => js`new RemoteSequence(${config})`,
	next: ({ target }, item) => js`${target}.next(${item},${config})`,
	complete: ({ target }, result) => js`${target}.complete(${result},${config})`,
	error: ({ target }, reason) => js`${target}.error(${reason},${config})`
};

const replacer: UnevalStreamReplacer = (_value, js: JavaScriptTag) => js`new Remote(${value})`;
const options: UnevalStreamOptions = { id: 'typed' };
const result: UnevalStreamResult = await unevalStream(iterable, replacer, options);
const { head, tail, id }: { head: string; tail: UnevalStreamTail; id: string } = result;
await tail.return();
void reference;
void head;
void id;

// @ts-expect-error internal protocol type
import type { Session } from 'devalue';
// @ts-expect-error internal protocol type
import type { Region } from 'devalue';
// @ts-expect-error internal protocol type
import type { PathReference } from 'devalue';

void (null as unknown as Session);
void (null as unknown as Region);
void (null as unknown as PathReference);
