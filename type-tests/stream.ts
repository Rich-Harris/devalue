import {
	unevalStream,
	type AsyncSequenceDescriptor,
	type AsyncValueDescriptor,
	type ClientReference,
	type UnevalStreamOptions,
	type UnevalStreamReplacer,
	type UnevalStreamResult,
	type UnevalStreamTail
} from 'devalue';

declare const promise: Promise<number>;
declare const sequence: AsyncIterable<number, string>;

const reference: ClientReference = { target: 'remote', control: 'controller' };

const value: AsyncValueDescriptor<number> = {
	type: 'async-value',
	source: promise,
	construct: () => 'new Remote()',
	resolve: ({ target }: ClientReference, source) => `${target}.resolve(${source})`,
	reject: ({ target }, source) => `${target}.reject(${source})`
};

const iterable: AsyncSequenceDescriptor<number, string> = {
	type: 'async-sequence',
	source: sequence,
	construct: () => 'new RemoteSequence()',
	next: ({ target }, source) => `${target}.next(${source})`,
	complete: ({ target }, source) => `${target}.complete(${source})`,
	error: ({ target }, source) => `${target}.error(${source})`
};

const replacer: UnevalStreamReplacer = () => value;
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
