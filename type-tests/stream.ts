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
const reference: ClientReference = { target: source, control: source };

const value: AsyncValueDescriptor<number> = {
	type: 'async-value',
	id: 'typed-value',
	source: promise,
	construct: () => source,
	resolve: () => source,
	reject: () => source
};

const iterable: AsyncSequenceDescriptor<number, string> = {
	type: 'async-sequence',
	source: sequence,
	construct: () => source,
	next: () => source,
	complete: () => source,
	error: () => source
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
