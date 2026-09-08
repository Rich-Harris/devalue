import typedarray from '../benchmarks/typed-array.js';
import uneval_stream from '../benchmarks/uneval-stream.js';

const results = [];
const benchmarks = [...typedarray, ...uneval_stream];

for (let i = 0; i < benchmarks.length; i += 1) {
	const benchmark = benchmarks[i];

	process.stderr.write(`Running ${i + 1}/${benchmarks.length} ${benchmark.label} `);
	results.push({ benchmark: benchmark.label, ...(await benchmark.fn()) });
	process.stderr.write('\x1b[2K\r');
}

process.send?.(results);
