// Tests of magic-r-flowr.mjs: node --test tests/node
// A fake flowR (fake-flowr.mjs) stands in for the real one; with MAGIC_R_FLOWR
// set, the last tests also run against a real flowR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as m from '../../magic-r-flowr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-flowr.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'magic-r-test-'));
const opts = extra => ({ backend: 'node', flowr: fake, noCache: true, rscript: undefined, ...extra });
function withEnv(env, f) {
	const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
	Object.assign(process.env, env);
	try {
		return f();
	} finally {
		for(const [k, v] of Object.entries(old)) {
			if(v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	}
}
async function document(code, extra = {}) {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, 'doc.mr.R'), code);
	await m.documentCommand(opts(extra), [path.join(dir, 'doc.mr.R'), path.join(dir, 'doc.mr.cfg')]);
	return fs.readFileSync(path.join(dir, 'doc.mr.cfg'), 'utf8');
}

test('names magic-r can link', () => {
	for(const n of ['paste', 'paste0', 'as.numeric', '.libPaths', 'is_tibble', '%in%', '%>%', '%||%', '%%', 'x2']) {
		assert.ok(m.linkable(n), n);
	}
	for(const n of ['+', '[[', '[.data.frame', '$<-', '1x', '.1', '%a,b%', '%{%', '%<~%', 'a b', '']) {
		assert.ok(!m.linkable(n), n);
	}
});

test('TeX escapes', () => {
	assert.equal(m.tex('%in%'), '\\%in\\%');
	assert.equal(m.tex('a#b_c$d&e'), 'a\\#b_c\\$d\\&e');
	assert.equal(m.texMessage('a {b} \\c %d\nx\u00e4'), 'a b c d x');
});

test('a package entry groups names by topic', () => {
	const text = m.packageEntry('base', '4.5.3', [
		{ name: 'paste', docUrl: 'https://stat.ethz.ch/R-manual/R-devel/library/base/html/paste.html' },
		{ name: 'paste0', docUrl: 'https://stat.ethz.ch/R-manual/R-devel/library/base/html/paste.html' },
		{ name: '%in%', topic: 'match' },
		{ name: 'odd', docUrl: 'https://example.org/odd#x' },
		{ name: 'nodoc' },
		{ name: '[[', topic: 'Extract' },
		{ name: 'paste', topic: 'twice' }
	]);
	assert.equal(text, [
		'\\mrPackage[rman]{base}{4.5.3}{%', '\\N{paste,}%', '\\T{match}{\\%in\\%,}%', '\\T{paste}{paste0,}%',
		'\\U{https://example.org/odd\\#x}{odd,}%', '}'
	].join('\n'));
	assert.match(m.packageEntry('dplyr', '1', [{ name: 'filter', docUrl: 'https://rdrr.io/cran/dplyr/man/filter.html' }]), /^\\mrPackage\[cran\]\{dplyr\}/);
});

test('long lists wrap, and the URLs of a database are those of magic-r', () => {
	const names = Array.from({ length: 80 }, (_, i) => `name${i}`);
	const text = m.packageEntry('pkg', '1.0', [...names.map(name => ({ name, topic: name })), { name: '%op%', topic: 'ops' }]);
	assert.ok(text.split('\n').length > 4);
	assert.ok(text.split('\n').every(l => l.length < m.LINE_WIDTH + 20));
	const urls = m.databaseUrls(text);
	assert.equal(urls.get('https://rdrr.io/cran/pkg/man/name7.html')[0], 'pkg::name7');
	assert.deepEqual(urls.get('https://rdrr.io/cran/pkg/man/ops.html'), ['pkg::%op%']);
	assert.equal(urls.size, 81);
	assert.deepEqual(m.operators([text]), ['\\%op\\%']);
});

test('the help index decides topics', () => {
	const help = new Map([['%>%', 'pipe'], ['extract', 'aliases']]);
	const fns = [
		{ name: '%>%' },
		{ name: 'extract', docUrl: 'https://rdrr.io/cran/magrittr/man/extract.html' },
		{ name: 'f', docUrl: 'https://rdrr.io/cran/magrittr/man/f.html' },          // a guessed, dead link
		{ name: 'g', docUrl: 'https://rdrr.io/cran/magrittr/man/aliases.html' }     // a real topic
	];
	assert.deepEqual(m.withHelp(fns, help), [{ name: '%>%', topic: 'pipe' }, { name: 'extract', topic: 'aliases' }, fns[3]]);
	assert.equal(m.withHelp(fns, undefined), fns);
});

test('command lines and options', () => {
	assert.deepEqual(m.splitCommand(`docker run "a b" 'c' d\\e ""`), ['docker', 'run', 'a b', 'c', 'd\\e', '']);
	const { opts, rest } = m.parseArgs(['--backend', 'web', '--no-cache', 'in.R', '--timeout', '5', 'out.cfg', '--rscript', '-']);
	assert.deepEqual(rest, ['in.R', 'out.cfg']);
	assert.equal(opts.backend, 'web');
	assert.equal(opts.timeout, 5);
	assert.equal(opts.noCache, true);
	assert.equal(opts.rscript, undefined);
	assert.throws(() => m.parseArgs(['--flowr']), /needs a value/);
});

test('blocks of the code', () => {
	const blocks = m.parseCode('x\n## magic-r block 3\na\n\nb\n## magic-r block 7\nc').blocks;
	assert.deepEqual(blocks, [{ id: '0', lines: ['x'] }, { id: '3', lines: ['a', '', 'b'] }, { id: '7', lines: ['c'] }]);
});

test('the plain scan finds loads', () => {
	const { entries } = m.detectByScan(m.parseCode([
		'## magic-r block 1', 'library(dplyr); require("tidyr") # library(no)',
		'pacman::p_load(purrr, "glue")', 'x <- stats::sd(y) + base:::f', 'z$a::b # z$(a::b)'
	].join('\n')).blocks);
	assert.deepEqual(entries.map(e => [e.pkg, e.attach, e.at[1]]), [
		['dplyr', true, 1], ['tidyr', true, 1], ['purrr', true, 2], ['glue', true, 2], ['pacman', false, 2],
		['stats', false, 3], ['base', false, 3], ['a', false, 4]
	]);
});

test('prefixes split what a search would truncate', () => {
	assert.deepEqual(m.planPrefixes(['a', 'b'], 5), ['']);
	assert.deepEqual(m.planPrefixes(['aa', 'ab', 'ba', 'a'], 2).sort(), ['a\0', 'aa', 'ab', 'b']);
	assert.equal(m.globOf(''), '?*');
	assert.equal(m.globOf('a'), 'a*');
	assert.equal(m.globOf('%*'), '%?*');
	assert.equal(m.globOf('a\0'), 'a');
});

test('the answers of flowR', () => {
	assert.deepEqual(m.answers('{"a":1}\nnoise\nInvalid query\n{"b":2}\n{broken'), [{ a: 1 }, undefined, { b: 2 }, undefined]);
	assert.throws(() => m.libraryEntries({}), /no library entries/);
	const entries = m.libraryEntries({
		dependencies: { library: [
			{ nodeId: 3, functionName: 'library', value: 'dplyr', derivedRange: { raw: '=1.2.1' } },
			{ nodeId: 4, functionName: ['p_load', 'pacman', false], value: 'purrr' },
			{ nodeId: 5, functionName: '::', value: 'stats' },
			{ nodeId: 6, functionName: 'library', value: 'unknown package name' }
		] },
		'location-map': { map: { ids: { 3: [0, [2, 1, 2, 7]], 4: [0, [5, 1, 5, 9]] } } }
	});
	assert.deepEqual(entries.map(e => [e.pkg, e.attach, e.line, e.version]),
		[['dplyr', true, 2, '1.2.1'], ['purrr', true, 5, undefined], ['stats', false, undefined, undefined]]);
});

test('a document: packages, loads, and operators', async() => {
	const out = await document('## magic-r block 2\nx <- 1\nlibrary(dplyr)\n## magic-r block 5\nrequire(magrittr)\nnothing::f\n');
	assert.match(out, /^% magic-r: the packages of the document, found by node flowR 2\.15\.10\n\\mrFlowrStatus\{ok\}\{node flowR 2\.15\.10\}\n/);
	assert.match(out, /\\mrPackage\[cran\]\{dplyr\}\{1\.2\.1\}\{%\n/);
	assert.match(out, /\\T\{reexports\}\{\\%>\\%,\}%/);
	assert.match(out, /\\mrPackage\[cran\]\{magrittr\}\{2\.0\.5\}/);
	assert.match(out, /\\mrOperators\{\\%<>\\%,\\%>\\%\}/);
	assert.match(out, /\\mrUses\{dplyr\}\n\\mrUses\{magrittr\}\n\\mrLoad\{2\}\{2\}\{dplyr\}\n\\mrLoad\{5\}\{1\}\{magrittr\}\n\\mrFlowBlocks\{2,5\}\n$/);
	assert.doesNotMatch(out, /\\mrPackage[^\n]*nothing/);
});

test('truncated searches split until they are complete', async() => {
	const out = await withEnv({ FAKE_MAX: '2' }, () => document('## magic-r block 1\nlibrary(dplyr)\n'));
	for(const n of ['filter', 'mutate', 'across', 'arrange', 'n']) {
		assert.match(out, new RegExp(`(?<=[{,\\n])${n},`), n);
	}
});

test('a block that does not parse is skipped, the others count', async() => {
	const out = await document('## magic-r block 1\nlibrary(dplyr)\n## magic-r block 2\nf(((\n## magic-r block 3\nlibrary(magrittr)\n');
	assert.match(out, /\\mrFlowrSkipped\{2\}/);
	assert.match(out, /\\mrLoad\{1\}\{1\}\{dplyr\}/);
	assert.match(out, /\\mrLoad\{3\}\{1\}\{magrittr\}/);
});

test('failures become a status, never a missing file', async() => {
	for(const [mode, why] of [['crash', /0 of 1 answers from flowR: TypeError: boom/], ['notflowr', /node: not flowR/], ['old', /no library entries/]]) {
		const out = await withEnv({ FAKE_MODE: mode }, () => document('## magic-r block 1\nlibrary(dplyr)\n'));
		assert.match(out, /^\\mrFlowrStatus\{failed\}\{/, mode);
		assert.match(out, why, mode);
	}
	const none = await document('library(x)\n', { flowr: path.join(here, 'does-not-exist') });
	assert.match(none, /^\\mrFlowrStatus\{failed\}\{cannot run/);
	assert.match(await document('library(x)\n', { backend: 'nothing' }), /unknown backend nothing/);
});

test('packages are cached per flowR and package version', async() => {
	const cache = tmp();
	const first = await document('library(dplyr)\n', { noCache: false, cache });
	const file = path.join(cache, 'flowr-2.15.10-f2', 'dplyr@1.2.1.cfg');
	assert.ok(fs.existsSync(file));
	fs.writeFileSync(file, '\\mrPackage{dplyr}{1.2.1}{\\N{cached,}}\n');
	const second = await document('library(dplyr)\n', { noCache: false, cache });
	assert.match(second, /\\N\{cached,\}/);
	assert.notEqual(first, second);
});

test('the web backend reads the table of the signature browser', async() => {
	const names = ['%>%\t1::::', 'filter\t0:t:2,2:t:3', 'n\t0::0:context', 'hidden\t0:u', 'method\t0:m', '[[.x\t0'].join('\n');
	const packages = ['dplyr\t1.2.1\t0', 'magrittr\t2.0.5\t0', 'stats\t4.5.3\t1'].join('\n');
	const table = m.parseTable(`${names}\n\n${packages}`);
	assert.deepEqual(table.byName.get('dplyr'), { version: '1.2.1', fns: [{ name: 'filter', topic: 'filter' }, { name: 'n', topic: 'context' }] });
	assert.deepEqual(table.byName.get('magrittr').fns, [{ name: '%>%', topic: '%>%' }]);
	// served from a local page, cached
	const cache = tmp();
	const page = path.join(cache, 'page.html');
	const data = zlib.gzipSync(Buffer.from(`${names}\n\n${packages}`)).toString('base64');
	fs.writeFileSync(page, `<html><script type="text/plain" id="data">${data}</script></html>`);
	const web = new m.Web({ cache, page: 'file://' + page });
	web.load = async function() {
		const html = fs.readFileSync(page, 'utf8');
		this.table = m.parseTable(zlib.gunzipSync(Buffer.from(/id="data">([^<]*)</.exec(html)[1], 'base64')).toString());
		return this.table;
	};
	const text = await m.documentText(web, '## magic-r block 1\nlibrary(dplyr)\nx %>% stats::sd()\n', { noCache: true }, tmp());
	assert.match(text, /\\mrFlowrStatus\{ok\}\{web sigdb\}/);
	assert.match(text, /\\mrPackage\[cran\]\{dplyr\}\{1\.2\.1\}\{%\n\\N\{filter,\}%\n\\T\{context\}\{n,\}%/);
	assert.match(text, /\\mrUses\{stats\}/);
	assert.match(text, /\\mrLoad\{1\}\{1\}\{dplyr\}/);
});

test('backends: an explicit one, and auto without anything', () => {
	assert.deepEqual(m.backends({ backend: 'node', flowr: 'x y' }).map(b => [b.name, b.argv]), [['node', ['x', 'y']]]);
	const auto = withEnv({ PATH: '', MAGIC_R_FLOWR: '' }, () => m.backends({}));
	assert.deepEqual(auto.map(b => b.name), ['web']);
	const docker = new m.Repl('docker', dir => ['docker', 'run', dir], { mount: '/work' });
	assert.equal(docker.query([{ type: 'x' }], '/tmp/a', 'doc.R'), ':query* [{"type":"x"}] file:///work/doc.R');
	assert.deepEqual(docker.prefix('/tmp/a'), ['docker', 'run', '/tmp/a']);
});

test('generate writes a database for a list of packages', async() => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, 'list.txt'), '# comment\nbase dplyr\nmagrittr\n');
	await m.generateCommand(opts({ output: path.join(dir, 'out.cfg') }), [path.join(dir, 'list.txt')]);
	const text = fs.readFileSync(path.join(dir, 'out.cfg'), 'utf8');
	assert.deepEqual([...text.matchAll(/\\mrPackage\[(\w+)\]\{(\w+)\}/g)].map(x => x[1] + ':' + x[2]), ['rman:base', 'cran:dplyr', 'cran:magrittr']);
	assert.match(text, /\n\\mrOperators\{\\%<>\\%,\\%>\\%,\\%in\\%\}\n$/);
	fs.writeFileSync(path.join(dir, 'list.txt'), 'nosuchpackage\n');
	await assert.rejects(m.generateCommand(opts({ output: path.join(dir, 'out.cfg') }), [path.join(dir, 'list.txt')]), /no package nosuchpackage/);
});

const real = process.env.MAGIC_R_FLOWR;
test('a real flowR', { skip: !real && 'MAGIC_R_FLOWR is not set' }, async() => {
	const out = await document('## magic-r block 1\npkgs <- c("dplyr")\nfor (p in pkgs) library(p, character.only = TRUE)\nx <- magrittr::`%>%`\n', { flowr: real });
	assert.match(out, /\\mrFlowrStatus\{ok\}\{node flowR \d+\.\d+\.\d+\}/);
	assert.match(out, /\\mrLoad\{1\}\{2\}\{dplyr\}/);
	assert.match(out, /\\mrPackage\[cran\]\{dplyr\}/);
	assert.match(out, /\\mrUses\{magrittr\}/);
});

test('pruning drops the names of dead pages', () => {
	const text = m.packageEntry('pkg', '1.0', [
		{ name: 'alive', topic: 'alive' }, { name: 'gone', topic: 'gone' },
		{ name: 'a', topic: 'shared' }, { name: 'b', topic: 'shared' }, { name: '%op%', topic: 'dead' }
	]) + '\n\\mrOperators{\\%op\\%}\n';
	const pruned = m.prune(text, new Set(['https://rdrr.io/cran/pkg/man/gone.html', 'https://rdrr.io/cran/pkg/man/dead.html']));
	assert.deepEqual([...m.databaseUrls(pruned).values()].flat(), ['pkg::alive', 'pkg::a', 'pkg::b']);
	assert.match(pruned, /\\mrOperators\{\}\n$/);
	assert.equal(m.prune(text, new Set()), text);
});

// a dataflow answer of flowR for: f <- function(x) x / p <- "a" / library(p, character.only = TRUE) / f(p)
const flowAnswer = {
	dataflow: { graph: {
		vertexInformation: [
			[0, { tag: 'vdef' }], [1, { tag: 'vdef' }], [2, { tag: 'use' }], [3, { tag: 'fdef', params: { 1: true } }],
			[4, { tag: 'vdef' }], [5, { tag: 'use' }], [6, { tag: 'use' }], [7, { tag: 'fcall', name: 'library' }],
			[8, { tag: 'fcall', name: 'f' }], [9, { tag: 'use' }], [10, { tag: 'value' }]
		],
		edgeInformation: [
			[0, [[3, { types: 2 }]]], [2, [[1, { types: 1 }]]], [5, [[4, { types: 1 }]]], [6, [[10, { types: 1 }]]],
			[8, [[0, { types: 1 }], ['built-in:f', { types: 4 }]]], [9, [[4, { types: 1 }]]]
		]
	} },
	'location-map': { map: { ids: {
		0: [0, [1, 1, 1, 1]], 1: [0, [1, 15, 1, 15]], 2: [0, [1, 18, 1, 18]], 3: [0, [1, 6, 1, 18]],
		4: [0, [2, 1, 2, 1]], 5: [0, [3, 9, 3, 9]], 6: [0, [3, 12, 3, 25]], 7: [0, [3, 1, 3, 7]],
		8: [0, [4, 1, 4, 1]], 9: [0, [4, 3, 4, 3]], 10: [0, [3, 29, 3, 32]]
	} } },
	dependencies: { read: [{ nodeId: 7, value: 'x.csv' }], write: [{ nodeId: 8, value: 'stdout' }] }
};
const flowSource = ['f <- function(x) x', 'p <- "a"', 'library(p, character.only = TRUE)', 'f(p)'];
const flowUnit = { answer: flowAnswer, at: l => ['5', l], source: l => flowSource[l - 1], ids: ['5'] };

test('flowR decides definitions, uses, arguments, and names of packages', () => {
	assert.deepEqual(m.flowFacts(flowUnit), [
		'\\mrFlowDef{5@1@1}{fun}', '\\mrFlowDef{5@1@15}{param}', '\\mrFlowRef{5@1@18}{param}{5@1@15}',
		'\\mrFlowDef{5@2@1}{var}', '\\mrFlowRef{5@3@9}{var}{5@2@1}', '\\mrFlowArg{5@3@12}', '\\mrFlowExt{5@3@1}',
		'\\mrFlowRef{5@4@1}{fun}{5@1@1}', '\\mrFlowRef{5@4@3}{var}{5@2@1}'
	]);
	assert.deepEqual(m.dependencyLines(flowUnit), ['\\mrFlowLine{5@3}{read}', '\\mrFlowLine{5@4}{output}']);
	assert.deepEqual(m.flowFacts({ ...flowUnit, answer: {} }), []);
});

test('code, labels, and requests', () => {
	const { blocks, requests } = m.parseCode([
		'## magic-r block 1', '## magic-r label demo', 'x', '## magic-r request {"kind":"slice","name":"s"}', 'y',
		'## magic-r request {broken'
	].join('\n'));
	assert.deepEqual(blocks, [{ id: '1', label: 'demo', lines: ['x', 'y', '## magic-r request {broken'] }]);
	assert.deepEqual(requests, [{ kind: 'slice', name: 's' }]);
});

test('graphs are laid out in layers, requests answer', () => {
	const nodes = [{ id: 'a', label: ['a'], pos: 1 }, { id: 'b', label: ['b'], pos: 2 }, { id: 'c', label: ['c'], pos: 3 }];
	const placed = m.layout(nodes, [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }, { from: 'a', to: 'c' }]);
	assert.equal(new Set(placed.map(n => n.y)).size, 3); // the cycle is broken, a chain remains
	assert.ok(placed.every(n => Number.isFinite(n.x)));
	const graph = m.dataflowGraph('g', flowAnswer, flowSource);
	assert.match(graph, /^\\mrFlowrGraph\{g\}\{\\mrGraphNode\[[\d.]+\]\{v0\}/);
	assert.match(graph, /\\mrGraphPath\{reads\}\{\(mr-v2\.north\) -- \(mr-v1\.south\)\}/);
	assert.equal(m.texText('a{b}%'), 'a{\\char123}b{\\char125}{\\char37}');
	assert.deepEqual(m.sliceLines({ 'static-slice': { results: { '2@y': { slice: { result: [4, 9] } } } }, ...flowAnswer }), [2, 4]);
	assert.equal(m.pointer({ a: [{ b: 'x' }] }, '/a/0/b'), 'x');
	assert.equal(m.pointer({ a: [1, 2] }, '/a'), '1, 2');
	assert.equal(m.pointer({ a: 1 }, '/b'), '??');
	const dir = tmp();
	const repl = { query: (q, d, f) => JSON.stringify(q) + f, exec: cmds => cmds.map(c => c.includes('static-slice') ? { 'static-slice': { results: {} } } : flowAnswer) };
	const blocks = [{ id: '1', label: 'demo', lines: flowSource }];
	assert.deepEqual(m.requestTexts(repl, [
		{ kind: 'slice', name: 's', block: 'demo', criterion: '4@p' }, { kind: 'query', name: 'q', query: [{ type: 'x' }], path: '/dependencies/read/0/value' },
		{ kind: 'slice', name: 'bad name' }, { kind: 'slice', name: 'missing', block: 'nowhere' }
	], blocks, dir), ['\\mrFlowrSlice{s}{}', '\\mrFlowrResult{q}{x.csv}']);
});

test('versions of flowR can be required', async() => {
	assert.ok(m.satisfies('2.15.10', '2.15.10'));
	assert.ok(m.satisfies('2.15.10', '>=2.15'));
	assert.ok(!m.satisfies('2.15.10', '>2.15.10'));
	assert.ok(m.satisfies('2.15.10', '<3'));
	assert.ok(!m.satisfies(undefined, '>=1'));
	assert.throws(() => m.satisfies('1', 'newest'), /cannot read/);
	assert.match(await document('library(dplyr)\n', { requireVersion: '>=3' }), /failed\}\{node: flowR 2\.15\.10 does not satisfy >=3/);
	assert.match(await document('library(dplyr)\n', { requireVersion: '>=2.15' }), /\\mrFlowrStatus\{ok\}/);
});

test('the linter marks the columns of its findings, backtick names link at their words', () => {
	const answer = { linter: { results: {
		'unused-definitions': { results: [{ certainty: 'uncertain', loc: [1, 1, 1, 6] }] },
		'absolute-file-paths': { results: [{ certainty: 'certain', loc: [1, 20, 2, 3] }] },
		'dead-code': { results: [] }
	} } };
	assert.deepEqual(m.lintTexts('4', answer, ['unused <- read.csv("/tmp/x.csv")', 'abc']), [
		'\\mrFlowLint{4@1}{1}{6}{uncertain}', '\\mrFlowLint{4@1}{20}{32}{certain}', '\\mrFlowLint{4@2}{1}{3}{certain}',
		'\\mrFlowLintNote{4@1}{\\mrLintRule{unused-definitions}{Unused-Definitions}, \\mrLintRule{absolute-file-paths}{Absolute-File-Paths}}',
		'\\mrFlowLintPlay{4@1}{lint:unused-definitions,lint:absolute-file-paths}{1}', '\\mrFlowLintPlay{4@2}{lint:absolute-file-paths}{1}'
	]);
	const unit = {
		answer: {
			dataflow: { graph: { vertexInformation: [[0, { tag: 'vdef' }], [1, { tag: 'use' }]], edgeInformation: [[1, [[0, { types: 1 }]]]] } },
			'location-map': { map: { ids: { 0: [0, [1, 1, 1, 8]], 1: [0, [2, 1, 2, 8]] } } }
		},
		at: l => ['2', l], source: l => ['`my var` <- 1', '`my var`'][l - 1]
	};
	assert.deepEqual(m.flowFacts(unit), [
		'\\mrFlowDef{2@1@2}{var}', '\\mrFlowRef{2@1@5}{var}{2@1@2}', '\\mrFlowRef{2@2@2}{var}{2@1@2}', '\\mrFlowRef{2@2@5}{var}{2@1@2}'
	]);
});

test('a call over several lines marks all of them, a string or comment does not close it', () => {
	const src = ['plot(x,', '  main = "a (b",  # )', '  col = "blue")', 'y'];
	assert.equal(m.callEnd(l => src[l - 1], 1, 4), 3);
	assert.equal(m.callEnd(l => src[l - 1], 4, 1), 4);
	const unit = {
		answer: { dependencies: { visualize: [{ nodeId: 1 }] }, 'location-map': { map: { ids: { 1: [0, [1, 1, 1, 4]] } } } },
		at: l => ['3', l], source: l => src[l - 1]
	};
	assert.deepEqual(m.dependencyLines(unit), ['\\mrFlowLine{3@1}{visualize}', '\\mrFlowLine{3@2}{visualize}', '\\mrFlowLine{3@3}{visualize}']);
});

test('arrows start only at the names of the criteria, in their colors', () => {
	assert.deepEqual(m.arrowTexts('5', flowAnswer, flowSource, ['4@p']), [
		'\\mrFlowArrow{5}{4}{3}{2}{1}{1}{0}{0}{0}', '\\mrFlowArrowCriterion{5}{4}{3}{1}'
	]);
	assert.deepEqual(m.arrowTexts('5', flowAnswer, flowSource, ['4@f', ' 4:3']), [
		'\\mrFlowArrow{5}{4}{1}{1}{1}{1}{1}{0}{1}', '\\mrFlowArrow{5}{4}{3}{2}{1}{2}{0}{0}{0}',
		'\\mrFlowArrowCriterion{5}{4}{1}{1}', '\\mrFlowArrowCriterion{5}{4}{3}{2}'
	]);
	assert.deepEqual(m.place('3@[1]p', flowSource), [3, 9]);
	// a use in the line of its definition stays below it, apart from the arrows that leave the line
	assert.deepEqual(m.arrowTracks([{ lu: 3, cu: 32, ld: 1, cd: 1 }, { lu: 3, cu: 32, ld: 3, cd: 23 }])
		.map(a => [a.ut, a.dt, a.lane]), [[1, 0, 0], [0, 0, 0]]);
});

test('criteria can name the nth occurrence of a name in a line', () => {
	const lines = ['total <- 0', 'for (v in c(1, 4, 9)) total <- total + v'];
	assert.equal(m.criterion('2@[2]v', lines), '2:40');
	assert.equal(m.criterion(' 2@[2]total', lines), '2:32');
	assert.equal(m.criterion('2@[3]v', lines), '2@v');
	assert.equal(m.criterion(' 5@x ', lines), '5@x');
});

// a small random number generator, so that the random graphs are the same in every run
const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/** checks a laid out graph: nodes apart, edges orthogonal, ends on their nodes, lanes beside nodes */
function checkGraph(placed, text) {
	const at = new Map(placed.map(n => [n.id, n]));
	for(const a of placed) {
		for(const b of placed) {
			if(a !== b && a.y === b.y) {
				assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-6, `${a.id} and ${b.id} overlap`);
			}
		}
	}
	for(const [, spec] of text.matchAll(/\\mrGraphPath\{\w+\}\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
		const pts = spec.split(' -- ').map(p => p.replace(/node\[[^\]]*\]\{.*\}\} /, '').trim()).map(p => {
			const q = /^\(([-\d.]+),([-\d.]+)\)$/.exec(p);
			if(q) {
				return { x: +q[1], y: +q[2] };
			}
			const a = /^\((?:\[xshift=([-\d.]+)cm\])?mr-([^.]+)\.(\w+)\)$/.exec(p);
			assert.ok(a, `an end at a node: ${p}`);
			const n = at.get(a[2]), dx = +(a[1] ?? 0);
			assert.ok(Math.abs(dx) <= n.w / 2 + 1e-6, `${p} ends beside its node`);
			return { x: n.x + dx, node: n, side: a[3] };
		});
		for(let k = 0; k + 1 < pts.length; k++) {
			const [p, q] = [pts[k], pts[k + 1]];
			if(p.side === 'east' || q.side === 'east') {
				continue;
			}
			// with a node at one end the segment is vertical, between two points it is axis-parallel
			if(p.node || q.node) {
				assert.ok(Math.abs(p.x - q.x) < 0.006, `a leaning segment in ${spec}`);
			} else {
				assert.ok(Math.abs(p.x - q.x) < 0.006 || Math.abs(p.y - q.y) < 0.006, `a leaning segment in ${spec}`);
				if(Math.abs(p.x - q.x) < 0.006) {
					const [lo, hi] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
					for(const n of placed) {
						assert.ok(!(Math.abs(n.x - p.x) < n.w / 2 - 0.01 && n.y > lo && n.y < hi), `a lane through ${n.id} in ${spec}`);
					}
				}
			}
		}
	}
}

test('random dataflow graphs: nodes apart, edges orthogonal and on their nodes, lanes beside nodes', () => {
	const kinds = ['vdef', 'use', 'value', 'fcall'];
	for(let seed = 1; seed <= 60; seed++) {
		const r = random(seed), n = 3 + Math.floor(r() * 18);
		const nodes = Array.from({ length: n }, (_, i) => ({
			id: `v${i}`, kind: kinds[Math.floor(r() * 4)], label: ['x'.repeat(1 + Math.floor(r() * 9))], note: i, pos: i
		}));
		const edges = [];
		for(let i = 1; i < n; i++) {
			for(let k = 0; k < 1 + Math.floor(r() * 3); k++) {
				edges.push({ from: `v${i}`, to: `v${Math.floor(r() * i)}`, kind: r() < 0.7 ? 'reads' : 'argument' });
			}
		}
		const placed = m.layout(nodes, edges);
		checkGraph(placed, m.graphText('g', placed, edges));
	}
});

test('the row distance of a graph is the one asked for where no edge runs sideways', () => {
	const nodes = [{ id: 'a', label: ['a'], pos: 1 }, { id: 'b', label: ['b'], pos: 2 }];
	const ys = vgap => m.layout(nodes, [{ from: 'b', to: 'a' }], { vgap }).map(n => n.y);
	const [a1, b1] = ys(0.2), [a2, b2] = ys(0.5);
	assert.ok(Math.abs((a2 - b2) - (a1 - b1) - 0.3) < 1e-9);
});

test('arrows: one per definition read, none for other names, tracks apart in many listings', () => {
	// two definitions read by one use, the same use requested twice, a criterion that is no name
	assert.deepEqual(m.arrowTexts('5', flowAnswer, flowSource, ['4@p', '4@p', '9@nothing', '$3']).filter(t => t.includes('Criterion')).length, 2);
	assert.deepEqual(m.arrowTexts('5', {}, flowSource, ['4@p']), []);
	for(let seed = 1; seed <= 40; seed++) {
		const r = random(seed);
		const arrows = Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
			const lu = 1 + Math.floor(r() * 8), ld = 1 + Math.floor(r() * 8);
			return { lu, cu: 1 + Math.floor(r() * 30), ld, cd: 1 + Math.floor(r() * 30) };
		});
		const placed = m.arrowTracks(arrows.map(a => ({ ...a })));
		// segments below one line that overlap are on different tracks, lanes that overlap differ
		const segs = placed.flatMap(a => a.lu === a.ld ? [[a.lu, Math.min(a.cu, a.cd), Math.max(a.cu, a.cd), a.ut]]
			: [[a.lu, 0, a.cu, a.ut], [a.ld, 0, a.cd, a.dt]]);
		for(const s of segs) {
			for(const t of segs) {
				if(s !== t && s[0] === t[0] && s[1] <= t[2] && t[1] <= s[2]) {
					assert.notEqual(s[3], t[3]);
				}
			}
		}
		const lanes = placed.filter(a => a.lu !== a.ld);
		for(const a of lanes) {
			for(const b of lanes) {
				if(a !== b && Math.min(a.lu, a.ld) <= Math.max(b.lu, b.ld) && Math.min(b.lu, b.ld) <= Math.max(a.lu, a.ld)) {
					assert.notEqual(a.lane, b.lane);
				}
			}
		}
	}
});

test('criteria point at places', () => {
	const lines = ['x <- 1', 'count <- count + 1 # count', 'y <- x.count + count'];
	assert.deepEqual(m.place('2@count', lines), [2, 1]);
	assert.deepEqual(m.place('2@[2]count', lines), [2, 10]);
	assert.deepEqual(m.place('3@count', lines), [3, 16]); // not the count of x.count
	assert.deepEqual(m.place(' 1:6 ', lines), [1, 6]);
	assert.equal(m.place('$4', lines), undefined);
	assert.equal(m.place('7@x', lines), undefined);
	assert.equal(m.criterion('2@[2]count', lines), '2:10');
	assert.equal(m.criterion('2@[9]count', lines), '2@count');
});

test('links into flowR\'s playground carry the code, marks, and a cursor', () => {
	const lines = ['x <- "ä"', 'count <- count + 1'];
	const hash = m.playgroundHash(lines, ['2@count', 'lint:absolute-file-paths'], '2:10');
	const params = new URLSearchParams(hash);
	assert.equal(Buffer.from(params.get('c').slice(1), 'base64url').toString('utf8'), lines.join('\n'));
	assert.equal(params.get('h'), '2@count,lint:absolute-file-paths');
	assert.equal(params.get('p'), '2:10');
	assert.match(hash, /^[A-Za-z0-9\-._~!$'()*,;:@/?=&%]+$/);
	const code = ['## magic-r block 3', ...lines,
		'## magic-r request {"kind":"playground","name":"pg-3","block":"3","marks":["2@[2]count", "$7"]}'].join('\n');
	assert.deepEqual(m.playgroundTexts(code), [`\\mrFlowrPlayground{pg-3}{${m.playgroundHash(lines, ['2:10'])}}`]);
	assert.deepEqual(m.playgroundTexts(code.replace('"block":"3"', '"block":"9"')), []);
});

test('the playground gets the code with its indentation from the file of its listing', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-r-play-'));
	const cwd = process.cwd();
	try {
		process.chdir(dir);
		fs.writeFileSync('doc.mr-play-3.R', 'for (v in x)\n  total <- total + v\n\n');
		const code = ['## magic-r block 3', 'for (v in x)', 'total <- total + v',
			'## magic-r request {"kind":"playground","name":"pg-3","block":"3","file":"doc.mr-play-3.R","marks":["2@[2]total"]}'].join('\n');
		const [text] = m.playgroundTexts(code);
		const hash = new URLSearchParams(/\{pg-3\}\{(.*)\}$/.exec(text)[1]);
		assert.equal(Buffer.from(hash.get('c').slice(1), 'base64url').toString(), 'for (v in x)\n  total <- total + v');
		assert.equal(hash.get('h'), '2:12');
	} finally {
		process.chdir(cwd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('interactive arrows: every variable a group of its own, the criteria first', () => {
	const texts = m.arrowTexts('5', flowAnswer, flowSource, ['4@p'], true);
	// p (the criterion) is group 1, x (a parameter read in f) another one
	assert.ok(texts.includes('\\mrFlowArrowCriterion{5}{4}{3}{1}'));
	assert.ok(texts.some(t => /^\\mrFlowArrow\{5\}\{4\}\{3\}\{2\}\{1\}\{1\}/.test(t)));
	assert.ok(texts.some(t => /^\\mrFlowArrow\{5\}\{3\}\{9\}\{2\}\{1\}\{1\}/.test(t)));
	const groups = new Set(texts.filter(t => t.startsWith('\\mrFlowArrow{')).map(t => t.split('}{')[5]));
	assert.ok(groups.size >= 2);
});

test('the call graph: the top level, the functions of the code, and those of R', () => {
	const answer = JSON.parse(fs.readFileSync(path.join(here, 'call-graph.json'), 'utf8'));
	const lines = ['f <- function(x) g(x) + 1', 'g <- function(y) y * 2', 'h <- function() f(1) + g(2)', 'print(h())'];
	const text = m.callGraph('cg', answer, lines);
	const label = id => new RegExp(`\\\\mrGraphNode\\[[\\d.]+\\]\\{${id}\\}\\{[-\\d.]+\\}\\{[-\\d.]+\\}\\{(\\w+)\\}\\{([^}]*)\\}`).exec(text);
	assert.deepEqual(['main', 'f10', 'f19', 'f32'].map(id => label(id)?.slice(1)),
		[['cgmain', 'top level'], ['cgfun', 'f'], ['cgfun', 'g'], ['cgfun', 'h']]);
	const edge = (a, b) => new RegExp(`mr-${a}\\.[^}]*mr-${b}\\.`).test(text);
	assert.ok(edge('main', 'f32') && edge('f32', 'f10') && edge('f32', 'f19') && edge('f10', 'f19'));
	assert.ok(!edge('main', 'f10') && !edge('main', 'f19'));
});

test('mermaid links and answers of other flowR', () => {
	assert.deepEqual(m.answers('https://mermaid.live/view#base64:abc\n   ╰ [Call Graph](https://mermaid.live/view#base64:def)\n{"a":1}'),
		[{ url: 'https://mermaid.live/view#base64:abc' }, { url: 'https://mermaid.live/view#base64:def' }, { a: 1 }]);
	assert.throws(() => m.instanceRepl('podman:flowr'), /docker:<image> or node:<command>/);
	assert.throws(() => m.instanceRepl('node:/no/such/flowr'), /cannot run|not flowR/);
});

test('the call graph of one function: only what it calls', () => {
	const answer = JSON.parse(fs.readFileSync(path.join(here, 'call-graph.json'), 'utf8'));
	const lines = ['f <- function(x) g(x) + 1', 'g <- function(y) y * 2', 'h <- function() f(1) + g(2)', 'print(h())'];
	const text = m.callGraph('cg', answer, lines, { function: 'f' });
	const ids = [...text.matchAll(/\\mrGraphNode\[[\d.]+\]\{(\w+)\}/g)].map(x => x[1]);
	assert.ok(ids.includes('f10') && ids.includes('f19'));
	assert.ok(!ids.includes('main') && !ids.includes('f32'));
});

test('a graph of several listings frames each file, side by side', () => {
	const files = [{ name: 'a', from: 1, to: 2 }, { name: 'b', from: 3, to: 4 }];
	const text = m.dataflowGraph('g', flowAnswer, flowSource, { files });
	assert.match(text, /\\mrGraphGroup\{a\}\{\(mr-v\d+\)/);
	assert.match(text, /\\mrGraphGroup\{b\}\{\(mr-v\d+\)/);
	// the centers of the vertices of a file
	const x = id => +new RegExp(`\\\\mrGraphNode\\[[\\d.]+\\]\\{${id}\\}\\{([-\\d.]+)\\}`).exec(text)[1];
	const xs = name => new RegExp(`\\\\mrGraphGroup\\{${name}\\}\\{([^}]*)\\}`).exec(text)[1].match(/v\d+/g).map(x);
	assert.ok(Math.max(...xs('a')) < Math.min(...xs('b')));
});
