const sander = require('sander');
const glob = require('glob');

for (const file of glob.sync('src/**/*.js')) {
	sander.unlinkSync(file);
}

sander.rimrafSync('types');
for (const file of glob.sync('src/**/*.d.ts')) {
	sander.renameSync(file).to(file.replace(/^src/, 'types'));
}