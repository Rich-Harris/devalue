import type { Plugin } from 'prettier';

let prettierPromise: Promise<{
	format: (source: string, options: Record<string, unknown>) => Promise<string>;
	babel: Plugin;
	estree: Plugin;
}> | undefined;

function loadPrettier() {
	return (prettierPromise ??= Promise.all([
		import('prettier/standalone'),
		import('prettier/plugins/babel'),
		import('prettier/plugins/estree')
	]).then(([prettier, babel, estree]) => ({
		format: prettier.format,
		babel: babel.default,
		estree: estree.default
	})));
}

export async function formatSource(source: string): Promise<string> {
	try {
		const prettier = await loadPrettier();
		return await prettier.format(source, {
			parser: 'babel',
			plugins: [prettier.babel, prettier.estree],
			useTabs: true,
			singleQuote: true,
			printWidth: 90
		});
	} catch {
		return source;
	}
}
