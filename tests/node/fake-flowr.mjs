#!/usr/bin/env node
// A stand-in for flowR's command line: answers --version and ':query*' commands
// like flowR does. FAKE_MAX caps wildcard searches, FAKE_MODE breaks it.
import fs from 'node:fs';

const DB = {
	base:     { version: '4.5.3', fns: { paste: 'paste', paste0: 'paste', c: undefined, '%in%': 'match', match: 'match', f: 'f', T: 'logical' } },
	dplyr:    { version: '1.2.1', fns: { filter: 'filter', mutate: 'mutate', '%>%': 'reexports', across: 'across', arrange: 'arrange', n: 'context' } },
	magrittr: { version: '2.0.5', fns: { '%>%': undefined, extract: 'aliases', '%<>%': 'compound' } }
};
const max = Number(process.env.FAKE_MAX ?? 500);
const mode = process.env.FAKE_MODE ?? '';
const args = process.argv.slice(2);
if(mode === 'notflowr') {
	console.log('something else 1.0');
	process.exit(0);
}
if(args.includes('--version')) {
	console.log('flowR:  2.15.10 (fake)\nengine: tree-sitter');
	process.exit(0);
}
const cmds = args[args.indexOf('-e') + 1].split(';');
if(mode === 'crash') {
	console.error('TypeError: boom');
	process.exit(1);
}
for(const cmd of cmds) {
	const m = /^:query\* (.*) file:\/\/(.*)$/.exec(cmd);
	if(!m || mode === 'old') {
		console.log('Invalid query');
		continue;
	}
	const [query] = JSON.parse(m[1]);
	const code = fs.readFileSync(m[2], 'utf8');
	if(query.type === 'dependencies') {
		const library = [], ids = {};
		if(!code.includes('(((')) {        // flowR answers nothing for code that does not parse
			code.split('\n').forEach((line, i) => {
				for(const l of line.matchAll(/\b(library|require)\((\w[\w.]*)\)/g)) {
					const id = library.length;
					ids[id] = [0, [i + 1, l.index + 1, i + 1, l.index + l[0].length]];
					library.push({ nodeId: id, functionName: l[1], value: l[2], versionConstraints: [],
						...DB[l[2]] ? { derivedRange: { raw: `=${DB[l[2]].version}` }, namespaceInfo: { exportedSymbols: Object.keys(DB[l[2]].fns) } } : {} });
				}
			});
		}
		console.log(JSON.stringify({ dependencies: { library }, 'location-map': { map: { files: { 0: m[2] }, ids } } }));
	} else if(query.type === 'signature') {
		const pkg = DB[query.package];
		const re = new RegExp('^' + query.function.replace(/[.+^${}()|[\]\\%]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
		const all = pkg ? Object.entries(pkg.fns).filter(([n]) => re.test(n)) : [];
		const matches = all.slice(0, max).map(([name, topic]) => ({ package: query.package, name, exported: name !== 'f' || query.package !== 'base' ? true : true, version: pkg.version,
			...topic ? { docUrl: query.package === 'base' ? `https://stat.ethz.ch/R-manual/R-devel/library/base/html/${topic}.html` : `https://rdrr.io/cran/${query.package}/man/${topic}.html` } : {} }));
		console.log(JSON.stringify({ signature: pkg ? { matches, truncated: all.length > max } : { message: `does not know ${query.package}` } }));
	}
}
