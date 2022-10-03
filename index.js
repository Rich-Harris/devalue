export { uneval } from './src/uneval.js';
export { parse } from './src/parse.js';
export { stringify } from './src/stringify.js';

export function devalue() {
	throw new Error(
		'The `devalue` export has been removed. Use `uneval` instead'
	);
}
