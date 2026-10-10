#!/usr/bin/env node
// magic-r-flowr.mjs: the bridge between magic-r and flowR (https://github.com/flowr-analysis/flowr).
//
//   node magic-r-flowr.mjs document [options] <code.R> <out.cfg>
//   node magic-r-flowr.mjs generate [options] [-o magic-r-links.cfg] [packages.txt]
//   node magic-r-flowr.mjs verify [--prune] [cfg]
//
// document: finds the packages the R code of a document loads or uses (magic-r writes one
//   block per listing, each after a line '## magic-r block <id>') and writes their links and
//   the block and line of every load to a file magic-r reads. With a backend that has a
//   dataflow graph, it adds where each name is defined, the lines that read or write files,
//   and the answers of the requests of the document ('## magic-r request {...}': graphs,
//   slices, queries). The file always exists afterwards and starts with \mrFlowrStatus{...}.
// generate: the shipped link database, for the packages of a list (one name per line).
// verify: requests every documentation page of a database and reports the ones that fail;
//   --prune removes their names from the database instead.
//
// flowR runs through the first backend that works (--backend picks one):
//   node    the flowR command line: --flowr <command>, $MAGIC_R_FLOWR, or 'flowr' on the PATH
//   docker  the image eagleoutice/flowr (--image), if docker has it
//   r       the R package flowr, through Rscript
//   web     the signature table of https://flowr-analysis.github.io/flowr/wiki/sigdb/, with
//           loads found by a plain scan of the code
// Other options: --rscript <command> (R's help index improves topics, '-' to skip),
//   --cache <dir> (default $MAGIC_R_CACHE, else the user cache), --no-cache, --timeout <s>,
//   --require-version <v> (a backend must have flowR v: '2.15.10', '>=2.15', '<3'),
//   --engine lax|tree-sitter|r-shell|default (how the node and docker backends parse: lax, the
//   default, is tree-sitter with its lax parser, which reads code with syntax errors).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const BLOCK_MARK = /^## magic-r block (\S+)\s*$/;
export const SENTINEL = 'magicr.sentinel';
export const BASE_PACKAGES = ['base', 'compiler', 'datasets', 'graphics', 'grDevices', 'grid', 'methods',
	'parallel', 'splines', 'stats', 'stats4', 'tcltk', 'tools', 'utils'];
export const SCHEMES = {
	rman: /^https:\/\/stat\.ethz\.ch\/R-manual\/R-devel\/library\/([^/]+)\/html\/([^/]+)\.html$/,
	cran: /^https:\/\/rdrr\.io\/cran\/([^/]+)\/man\/([^/]+)\.html$/
};
export const SIGDB_PAGE = 'https://flowr-analysis.github.io/flowr/wiki/sigdb/';
const MAX_MATCHES = 499; // flowR caps a wildcard search at 500 hits
const ALPHABET = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i));
const ATTACHING = new Set(['library', 'require', 'p_load', 'p_load_gh', 'attach', 'use']);

export function linkable(name) {
	return /^(?:[A-Za-z]|\.[A-Za-z._])[A-Za-z0-9._]*$/.test(name) || /^%[!-~]*%$/.test(name) && !/[{}\\,%~^]/.test(name.slice(1, -1));
}
/** what would break the TeX source, or the literates of listings ('$', '&') */
export function tex(s) {
	return s.replace(/[%#$&]/g, c => '\\' + c);
}
export function texMessage(s) {
	return String(s).replace(/[^ -~]/g, ' ').replace(/[\\{}%#&$^~_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
/** the width of the lines of a database, long lines read faster and keep the file short */
export const LINE_WIDTH = 240;
const CACHE_FORMAT = 'f2';
function wrap(names) {
	const lines = [];
	let line = '';
	for(const n of names) {
		line += tex(n) + ',';
		if(line.length > LINE_WIDTH) {
			lines.push(line + '%');
			line = '';
		}
	}
	if(line) {
		lines.push(line + '%');
	}
	return lines.join('\n');
}
/** an entry of a package: on one line if it fits */
function entryText(head, names) {
	const body = wrap(names.sort());
	return body.includes('\n') ? `${head}{%\n${body}\n}%` : `${head}{${body.slice(0, -1)}}%`;
}
const byKey = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;

/**
 * The database entry of a package: \N lists the names documented under their own name, \T{topic}
 * the ones of another topic, \U{url} the ones of any other page.
 * @param {{name: string, docUrl?: string, topic?: string}[]} fns
 */
export function packageEntry(pkg, version, fns) {
	const scheme = BASE_PACKAGES.includes(pkg) ? 'rman' : 'cran';
	const topics = new Map(), urls = new Map(), same = [], seen = new Set();
	const add = (m, k, n) => m.set(k, [...m.get(k) ?? [], n]);
	for(const fn of fns) {
		if(!linkable(fn.name) || seen.has(fn.name)) {
			continue;
		}
		let topic = fn.topic, url;
		if(!topic && fn.docUrl) {
			const m = fn.docUrl.match(SCHEMES[scheme]);
			if(m && m[1] === pkg) {
				topic = decodeURIComponent(m[2]);
			} else if(/^https?:\/\/[!-~]+$/.test(fn.docUrl) && !/[{}\\]/.test(fn.docUrl)) {
				url = fn.docUrl;
			}
		}
		// an operator is never documented under its own name ('%in%' is 'match')
		if(!topic && !url || topic === fn.name && fn.name.startsWith('%')) {
			continue;
		}
		seen.add(fn.name);
		if(url) {
			add(urls, url, fn.name);
		} else if(topic === fn.name) {
			same.push(fn.name);
		} else {
			add(topics, topic, fn.name);
		}
	}
	const out = [`\\mrPackage[${scheme}]{${pkg}}{${version}}{%`];
	if(same.length) {
		out.push(entryText('\\N', same));
	}
	for(const [topic, names] of [...topics].sort(byKey)) {
		out.push(entryText(`\\T{${tex(topic)}}`, names));
	}
	for(const [url, names] of [...urls].sort(byKey)) {
		out.push(entryText(`\\U{${tex(url)}}`, names));
	}
	out.push('}');
	return out.join('\n');
}

/** the '%op%' names of database entries, as they are written there */
export function operators(texts) {
	return [...new Set(texts.flatMap(t => t.match(/(?<=[,{\n])\\%[^,\n]*?\\%(?=,)/g) ?? []))].sort();
}

export function splitCommand(cmd) {
	const words = [];
	let cur = '', quote = null, any = false;
	for(const c of cmd.trim()) {
		if(quote) {
			if(c === quote) {
				quote = null;
			} else {
				cur += c;
			}
		} else if(c === '"' || c === '\'') {
			quote = c;
			any = true;
		} else if(/\s/.test(c)) {
			if(cur || any) {
				words.push(cur);
			}
			cur = '';
			any = false;
		} else {
			cur += c;
		}
	}
	if(cur || any) {
		words.push(cur);
	}
	return words;
}

export function onPath(name) {
	const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
	for(const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		for(const ext of exts) {
			const file = path.join(dir, name + ext);
			try {
				if(fs.statSync(file).isFile()) {
					fs.accessSync(file, fs.constants.X_OK);
					return file;
				}
			} catch{ /* not here */ }
		}
	}
	return undefined;
}

export function run(argv, { cwd, timeout, input } = {}) {
	// a .js file runs with this node, so a flowR checkout works without a wrapper
	const [cmd, ...args] = /\.[cm]?js$/.test(argv[0]) ? [process.execPath, ...argv] : argv;
	const res = spawnSync(cmd, args, {
		cwd, input, encoding: 'utf8', timeout: (timeout ?? 120) * 1000, maxBuffer: 1 << 30, windowsHide: true,
		shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
	});
	if(res.error) {
		throw new Error(`cannot run ${argv[0]}: ${res.error.code === 'ETIMEDOUT' ? 'timeout' : res.error.message}`);
	}
	return res;
}

/** the JSON answers in an output, one per command; an error message counts as a failed command */
export function answers(stdout) {
	const out = [];
	for(const line of stdout.split('\n')) {
		const url = /(?:^|\]\()(https:\/\/mermaid\.live\/[^\s)]+)/.exec(line);
		if(url) {
			out.push({ url: url[1] });
		} else if(line.startsWith('{')) {
			try {
				out.push(JSON.parse(line));
			} catch{
				out.push(undefined);
			}
		} else if(/^(Invalid|Error|Unknown)\b/.test(line)) {
			out.push(undefined);
		}
	}
	return out;
}

/**
 * How flowR parses: tree-sitter with its lax parser (the default) reads code with syntax errors, so
 * fragments in a document do not hide the rest; r-shell needs R.
 */
export const ENGINES = {
	lax:           ['--default-engine', 'tree-sitter', '--engine.tree-sitter.lax'],
	'tree-sitter': ['--default-engine', 'tree-sitter'],
	'r-shell':     ['--default-engine', 'r-shell'],
	default:       []
};

/**
 * A backend that speaks flowR's REPL: `exec(cmds, dir)` runs commands (files of `dir` are named by
 * `file(name)`) and answers with one JSON object per command.
 */
export class Repl {
	constructor(name, argv, { timeout, mount, engine = 'lax' } = {}) {
		Object.assign(this, { name, argv, timeout, mount, engine: ENGINES[engine] });
		if(!this.engine) {
			throw new Error(`unknown engine ${engine}`);
		}
	}
	file(dir, name) {
		return this.mount ? `${this.mount}/${name}` : path.join(dir, name).replaceAll('\\', '/');
	}
	query(queries, dir, name) {
		return `:query* ${JSON.stringify(queries)} file://${this.file(dir, name)}`;
	}
	version() {
		if(!this.cachedVersion) {
			let res = run([...this.prefix(os.tmpdir()), ...this.engine, '--version', '--no-ansi'], { timeout: this.timeout });
			if(!/flowR:?\s+v?\d/.test(res.stdout ?? '') && this.engine.length) {
				// a flowR without these engines: its default one
				this.engine = [];
				res = run([...this.prefix(os.tmpdir()), '--version', '--no-ansi'], { timeout: this.timeout });
			}
			const m = /flowR:?\s+v?(\d+\.\d+\.\d+)/.exec(res.stdout ?? '');
			if(!m) {
				throw new Error(`${this.name}: not flowR (${texMessage((res.stdout || res.stderr || '').split('\n')[0]) || 'no output'})`);
			}
			this.cachedVersion = m[1];
		}
		return this.cachedVersion;
	}
	prefix(dir) {
		return typeof this.argv === 'function' ? this.argv(dir) : this.argv;
	}
	exec(cmds, dir) {
		if(cmds.length === 0) {
			return [];
		}
		if(cmds.some(c => c.includes(';'))) {
			throw new Error('a flowR command must not contain ";"');
		}
		const res = run(this.command(cmds, dir), { cwd: dir, timeout: this.timeout });
		const list = answers(res.stdout ?? '');
		if(list.length !== cmds.length) {
			const why = (res.stderr || res.stdout || '').split('\n').find(l => l.trim()) ?? `exit code ${res.status}`;
			throw new Error(`${this.name}: ${list.length} of ${cmds.length} answers from flowR: ${texMessage(why)}`);
		}
		return list;
	}
	command(cmds, dir) {
		return [...this.prefix(dir), ...this.engine, '--no-ansi', '-e', cmds.join(';')];
	}
	describe() {
		return `${this.name} flowR ${this.version()}`;
	}
}

/** the R package flowr, which runs flowR for R */
export class RRepl extends Repl {
	constructor(rscript, opts) {
		super('r', splitCommand(rscript), opts);
	}
	rcode(dir, cmds) {
		fs.writeFileSync(path.join(dir, 'cmds.txt'), cmds.join(';'));
		return `suppressMessages(library(flowr)); r <- flowr_repl(readLines("cmds.txt"), ansi = FALSE)
			for (x in if (is.null(r$messages)) r else r$messages)
				if (is.list(x) && identical(x$stream, "stdout")) cat(x$result, "\\n", sep = "")`;
	}
	version() {
		if(!this.cachedVersion) {
			const res = run([...this.argv, '--vanilla', '-e', 'cat(as.character(packageVersion("flowr")))'], { timeout: this.timeout });
			if(res.status !== 0) {
				throw new Error('r: no R package flowr');
			}
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-r-'));
			try {
				const v = run([...this.argv, '--vanilla', '-e', this.rcode(dir, [':version'])], { cwd: dir, timeout: this.timeout });
				this.cachedVersion = /flowR:?\s+v?(\d+\.\d+\.\d+)/.exec(v.stdout ?? '')?.[1] ?? `r-flowr-${res.stdout.trim()}`;
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
		return this.cachedVersion;
	}
	command(cmds, dir) {
		return [...this.argv, '--vanilla', '-e', this.rcode(dir, cmds)];
	}
}

export function libraryEntries(answer) {
	const deps = answer?.dependencies, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!deps || !Array.isArray(deps.library)) {
		throw new Error('the dependencies query of flowR has no library entries');
	}
	const out = [];
	for(const e of deps.library) {
		const fn = Array.isArray(e.functionName) ? e.functionName[0] : e.functionName;
		if(typeof e.value !== 'string' || !/^[A-Za-z][A-Za-z0-9.]*$/.test(e.value)) {
			continue;
		}
		const loc = ids[String(e.nodeId)], raw = e.derivedRange?.raw;
		out.push({
			pkg:     e.value, attach: ATTACHING.has(fn),
			line:    Array.isArray(loc?.[1]) ? loc[1][0] : undefined,
			version: typeof raw === 'string' && /^=?\d[\w.-]*$/.test(raw) ? raw.replace(/^=/, '') : undefined,
			symbols: e.namespaceInfo?.exportedSymbols
		});
	}
	return out;
}

export const LABEL_MARK = /^## magic-r label (\S+)\s*$/;
export const REQUEST_MARK = /^## magic-r request (\{.*\})\s*$/;

/** the block a request names, by its label or id (the last one of that label), none for the document */
export function blockOf(blocks, ref) {
	return ref === undefined || ref === '' ? undefined : blocks.filter(b => b.label === String(ref) || b.id === String(ref)).at(-1);
}

/** the blocks of the code, each with its label, and the requests of the document */
export function parseCode(code) {
	const blocks = [], requests = [];
	let cur;
	code.split(/\r?\n/).forEach(line => {
		const m = BLOCK_MARK.exec(line), label = LABEL_MARK.exec(line), req = REQUEST_MARK.exec(line);
		if(m) {
			blocks.push(cur = { id: m[1], lines: [] });
		} else if(label && cur) {
			cur.label = label[1];
		} else if(req) {
			try {
				requests.push(JSON.parse(req[1]));
			} catch{ /* not one of ours */ }
		} else if(cur) {
			cur.lines.push(line);
		} else if(line.trim()) {
			blocks.push(cur = { id: '0', lines: [line] });
		}
	});
	return { blocks, requests };
}

const ANALYSIS = [{ type: 'dependencies' }, { type: 'location-map' }, { type: 'dataflow' }];

/**
 * The loads of all blocks as one script. flowR answers nothing for code that does not parse, so a
 * sentinel load at the end tells; then every block is analyzed on its own and broken ones skipped.
 * Each analysis is a unit: its answer, and where a line of its file is (block and line).
 */
export function detectWithFlowr(repl, blocks, dir) {
	const sentinel = `library(${SENTINEL})`;
	const map = [];
	const lines = [];
	for(const b of blocks) {
		lines.push(`## magic-r block ${b.id}`);
		b.lines.forEach((l, i) => {
			lines.push(l);
			map[lines.length] = [b.id, i + 1];
		});
	}
	fs.writeFileSync(path.join(dir, 'doc.R'), `${lines.join('\n')}\n${sentinel}\n`);
	const answer = repl.exec([repl.query(ANALYSIS, dir, 'doc.R')], dir)[0];
	const whole = libraryEntries(answer);
	if(whole.some(e => e.pkg === SENTINEL)) {
		const unit = { answer, at: l => map[l], source: l => lines[l - 1], ids: blocks.map(b => b.id) };
		return { entries: whole.filter(e => e.pkg !== SENTINEL).map(e => ({ ...e, at: map[e.line] })), skipped: [], units: [unit] };
	}
	const cmds = blocks.map((b, i) => {
		fs.writeFileSync(path.join(dir, `b${i}.R`), `${b.lines.join('\n')}\n${sentinel}\n`);
		return repl.query(ANALYSIS, dir, `b${i}.R`);
	});
	const entries = [], skipped = [], units = [];
	repl.exec(cmds, dir).forEach((a, i) => {
		const es = a ? libraryEntries(a) : [];
		if(es.some(e => e.pkg === SENTINEL)) {
			const b = blocks[i];
			entries.push(...es.filter(e => e.pkg !== SENTINEL).map(e => ({ ...e, at: e.line ? [b.id, e.line] : undefined })));
			units.push({ answer: a, at: l => l <= b.lines.length ? [b.id, l] : undefined, source: l => b.lines[l - 1], ids: [b.id] });
		} else {
			skipped.push(blocks[i].id);
		}
	});
	return { entries, skipped, units };
}

const NAME = /^(?:[A-Za-z]|\.[A-Za-z._]?)[A-Za-z0-9._]*$/;
const EDGE = { reads: 1, definedBy: 2, calls: 4, returns: 8, argument: 64 };
/** the vertices and edges of a dataflow graph, with the location of each vertex */
function graphOf(answer) {
	const graph = answer?.dataflow?.graph, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!graph) {
		return undefined;
	}
	const vertices = new Map(graph.vertexInformation.map(([id, v]) => [String(id), v]));
	const edges = new Map(graph.edgeInformation.map(([from, es]) => [String(from), es.map(([to, e]) => [String(to), e.types])]));
	const params = new Set([...vertices.values()].flatMap(v => v.tag === 'fdef' ? Object.keys(v.params ?? {}) : []));
	const loc = id => {
		const l = ids[id]?.[1];
		return Array.isArray(l) ? l : undefined;
	};
	const out = id => edges.get(id) ?? [];
	const kind = id => params.has(id) ? 'param'
		: out(id).some(([t, types]) => types & EDGE.definedBy && vertices.get(t)?.tag === 'fdef') ? 'fun' : 'var';
	// the name a vertex stands for in one line, and where it starts: '"w"' of assign("w", ...) is w, a
	// backtick name has a column for each of its words, as magic-r sees them
	const name = (id, source) => {
		const l = loc(id);
		if(!l || l[0] !== l[2]) {
			return undefined;
		}
		const text = source(l[0])?.slice(l[1] - 1, l[3]) ?? '';
		const q = /^(["'`])(.*)\1$/.exec(text);
		if(q?.[1] === '`') {
			const cols = [...q[2].matchAll(/[A-Za-z.][A-Za-z0-9._]*/g)].map(m => l[1] + 1 + m.index);
			return cols.length > 0 && { text: q[2], line: l[0], col: cols[0], cols, end: l[3] };
		}
		return q ? NAME.test(q[2]) && { text: q[2], line: l[0], col: l[1] + 1, end: l[3] }
			: NAME.test(text) && { text, line: l[0], col: l[1], end: l[3] };
	};
	return { vertices, edges, loc, out, kind, name };
}

/**
 * What flowR knows of the names of a unit, for magic-r: \mrFlowDef{block@line@col}{kind} defines a
 * name there, \mrFlowRef{at}{kind}{at} links a use to its definition, \mrFlowExt{at} is a name of a
 * package (or R), \mrFlowArg{at} the name of an argument.
 */
export function flowFacts({ answer, at, source }) {
	const g = graphOf(answer);
	if(!g) {
		return [];
	}
	const place = (l, col) => {
		const a = at(l);
		return a && `${a[0]}@${a[1]}@${col}`;
	};
	const name = id => g.name(id, source);
	const before = (a, b) => a.line < b.line || a.line === b.line && a.col <= b.col;
	const facts = new Map();
	const set = (n, fact) => {
		for(const c of n.cols ?? [n.col]) {
			const at = place(n.line, c);
			facts.set(at, fact(at));
		}
	};
	for(const [id, v] of g.vertices) {
		const n = name(id);
		const here = n && place(n.line, n.col);
		if(!here || facts.has(here)) {
			continue;
		}
		if(v.tag === 'vdef') {
			// the further words of a backtick name link to its first one
			set(n, at => at === here ? `\\mrFlowDef{${at}}{${g.kind(id)}}` : `\\mrFlowRef{${at}}{${g.kind(id)}}{${here}}`);
		} else if(v.tag === 'use' || v.tag === 'fcall' && typeof v.name === 'string' && v.name === n.text) {
			// the definition read last before the use, else the first one
			const defs = g.out(id).filter(([t, types]) => types & EDGE.reads && g.vertices.get(t)?.tag === 'vdef')
				// only a definition of the same name: flowR places some reads at a call ('c' of mget(c("x")))
				.map(([t]) => ({ t, n: name(t) })).filter(d => d.n && d.n.text === n.text && place(d.n.line, d.n.col));
			const def = defs.filter(d => before(d.n, n)).sort((a, b) => before(a.n, b.n) ? 1 : -1)[0] ?? defs[0];
			if(def) {
				const kind = v.tag === 'fcall' ? 'fun' : g.kind(def.t);
				set(n, at => `\\mrFlowRef{${at}}{${kind}}{${place(def.n.line, def.n.col)}}`);
			} else if(v.tag === 'use' && /^\s*=(?!=)/.test(source(n.line)?.slice(n.end) ?? '')) {
				set(n, at => `\\mrFlowArg{${at}}`);
			} else {
				set(n, at => `\\mrFlowExt{${at}}`);
			}
		}
	}
	return [...facts.values()];
}

export const DEPENDENCY_KINDS = ['read', 'write', 'source', 'visualize', 'test', 'remote'];
/** the last line of a call that starts at line l after column c (its name): where its parentheses close */
export function callEnd(source, l, c) {
	let depth = 0, quote = null, opened = false;
	for(let line = l; line < l + 100 && source(line) !== undefined; line++) {
		const text = source(line);
		for(let i = line === l ? c : 0; i < text.length; i++) {
			const ch = text[i];
			if(quote) {
				if(ch === '\\') {
					i++;
				} else if(ch === quote) {
					quote = null;
				}
			} else if(ch === '"' || ch === "'" || ch === '`') {
				quote = ch;
			} else if(ch === '#') {
				break;
			} else if(ch === '(') {
				depth++;
				opened = true;
			} else if(ch === ')' && --depth === 0 && opened) {
				return line;
			} else if(!opened && !/\s/.test(ch)) {
				return l; // no call after the name
			}
		}
	}
	return l;
}

/** the lines that read, write, source, ... (dependencies query): \mrFlowLine{block@line}{kind} */
export function dependencyLines({ answer, at, source = () => undefined }) {
	const deps = answer?.dependencies, ids = answer?.['location-map']?.map?.ids ?? {};
	const out = new Map();
	for(const kind of DEPENDENCY_KINDS) {
		for(const e of Array.isArray(deps?.[kind]) ? deps[kind] : []) {
			const l = ids[String(e.nodeId)]?.[1];
			if(!Array.isArray(l)) {
				continue;
			}
			// printing writes to the console only; a call over several lines marks all of them
			const k = kind === 'write' && /^std(out|err)$/.test(e.value ?? '') ? 'output' : kind;
			for(let line = l[0]; line <= Math.max(l[2], callEnd(source, l[0], l[3])); line++) {
				const a = at(line);
				if(a && (!out.has(`${a[0]}@${a[1]}`) || out.get(`${a[0]}@${a[1]}`).endsWith('{output}'))) {
					out.set(`${a[0]}@${a[1]}`, `\\mrFlowLine{${a[0]}@${a[1]}}{${k}}`);
				}
			}
		}
	}
	return [...out.values()];
}

/** text for TeX, every special character as \char */
export function texText(s, max = 2000) {
	const t = String(s).replace(/[^ -~]/g, ' ');
	return (t.length > max ? t.slice(0, max - 3) + '...' : t).replace(/[\\{}$&#^_%~]/g, c => `{\\char${c.charCodeAt(0)}}`);
}
const shorten = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

/**
 * A layered layout: the target of every edge is in a layer above its source (in the dataflow
 * graph, what is read is above what reads it), nodes of a layer are ordered by the mean position
 * of their targets, cycles are broken where a depth-first search finds them. With up, the source
 * is above the target instead (control flows down). nodes: {id, label (lines), kind, pos},
 * edges: {from, to}.
 */
export function layout(nodes, edges, { up = false, gap = 0.22, vgap = 0.2, char = 0.12 } = {}) {
	const ids = new Set(nodes.map(n => n.id));
	const live = edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
	// down: from a node to the ones below it (what reads a definition, what control flows to)
	const down = new Map(nodes.map(n => [n.id, []]));
	for(const e of live) {
		down.get(up ? e.from : e.to).push(up ? e.to : e.from);
	}
	const byPos = [...nodes].sort((a, b) => a.pos - b.pos);
	const byId = new Map(nodes.map(n => [n.id, n]));
	// the file of a node, or of the edge a point of a lane belongs to (several files side by side)
	const fileOf = n => n.file ?? byId.get(n.of)?.file ?? 0;
	// a depth-first search from the roots finds the edges that go back up (loops)
	const back = new Set(), state = new Map();
	const hasIn = new Set([...down.values()].flat());
	const dfs = id => {
		state.set(id, 1);
		for(const t of down.get(id)) {
			if(state.get(t) === 1) {
				back.add(`${id}>${t}`);
			} else if(!state.has(t)) {
				dfs(t);
			}
		}
		state.set(id, 2);
	};
	[...byPos.filter(n => !hasIn.has(n.id)), ...byPos].forEach(n => state.has(n.id) || dfs(n.id));
	// the layer: the longest path from a root without the edges back
	const layer = new Map();
	const depthOf = id => {
		if(!layer.has(id)) {
			layer.set(id, 0);
			const above = live.filter(e => (up ? e.to : e.from) === id && !back.has(up ? `${e.from}>${e.to}` : `${e.to}>${e.from}`))
				.map(e => up ? e.from : e.to);
			layer.set(id, Math.max(0, ...above.map(a => depthOf(a) + 1)));
		}
		return layer.get(id);
	};
	byPos.forEach(n => depthOf(n.id));
	const depth = Math.max(0, ...layer.values());
	// an edge over several layers passes a point in each layer between, which takes part in the
	// order like a node, so the edge gets a lane of its own
	const near = new Map(nodes.map(n => [n.id, []]));
	const link = (a, b) => {
		near.get(a).push(b);
		near.get(b).push(a);
	};
	const points = [], lanes = new Map();
	live.forEach((e, i) => {
		const a = layer.get(e.from), b = layer.get(e.to), isBack = back.has(up ? `${e.from}>${e.to}` : `${e.to}>${e.from}`);
		// the control flow graph routes its loops around the blocks, the dataflow graph gives them lanes
		if(isBack && up || Math.abs(a - b) < 2) {
			link(e.from, e.to);
			return;
		}
		const step = a < b ? 1 : -1, lane = [];
		let prev = e.from;
		for(let d = a + step; d !== b; d += step) {
			const id = `~${i}.${d}`, pos = (byPos.find(n => n.id === e.from).pos + byPos.find(n => n.id === e.to).pos) / 2;
			points.push({ id, label: [''], pos, point: true, of: e.from });
			layer.set(id, d);
			near.set(id, []);
			link(prev, id);
			lane.push(id);
			prev = id;
		}
		link(prev, e.to);
		lanes.set(e, lane);
	});
	const rows = Array.from({ length: depth + 1 }, (_, d) => [...byPos, ...points].filter(n => layer.get(n.id) === d));
	// stadiums and hexagons need room for their round and pointed ends
	const width = n => n.point ? 0.1 : ({ use: 0.1, value: 0.2, fcall: 0.08, entry: 0.2, exit: 0.2, branch: 0.25, cgmain: 0.2, cgbuiltin: 0.1 }[n.kind] ?? 0)
		+ Math.max(0.45, Math.max(...n.label.map(l => l.length)) * char + 0.26
		+ (n.note === undefined ? 0 : String(n.note).length * 0.09 + 0.08), (n.builtin ?? '').length * 0.09 + 0.3);
	const height = n => n.point ? 0 : n.label.length * 0.34 + 0.2 + (n.builtin ? 0.24 : 0);
	// the order: sweeps down and up, each sorts a layer by the mean place of its neighbors in the other ones
	const rank = new Map();
	const rerank = () => rows.forEach(row => row.forEach((n, i) => rank.set(n.id, i / Math.max(1, row.length - 1))));
	rerank();
	for(let sweep = 0; sweep < 6; sweep++) {
		const order = sweep % 2 ? [...rows.keys()].reverse() : [...rows.keys()];
		for(const d of order) {
			const other = id => sweep % 2 ? layer.get(id) > d : layer.get(id) < d;
			const bary = n => {
				const ns = near.get(n.id).filter(other);
				return ns.length ? ns.reduce((p, q) => p + rank.get(q), 0) / ns.length : rank.get(n.id);
			};
			const b = new Map(rows[d].map(n => [n.id, bary(n)]));
			rows[d].sort((p, q) => fileOf(p) - fileOf(q) || b.get(p.id) - b.get(q.id) || p.pos - q.pos);
			rows[d].forEach((n, i) => rank.set(n.id, i / Math.max(1, rows[d].length - 1)));
		}
	}
	// the places: each node wants to be above or below its neighbors in the layers placed already,
	// the nodes of a layer keep their order and a gap
	const x = new Map(), y = new Map();
	for(const row of rows) {
		const want = row.map(n => {
			const xs = near.get(n.id).filter(t => x.has(t)).map(t => x.get(t));
			return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : undefined;
		});
		// a node with a loop at its right side (recursion) keeps more room
		const ws = row.map(n => width(n) + (n.loop ? 0.6 : 0));
		// a priority layout: in the order of the code, each node takes the place it wants (above its
		// neighbors), or the nearest one that leaves room for the nodes between it and those placed
		const span = (i, j) => ws[i] / 2 + ws[j] / 2 + gap * (j - i) + ws.slice(i + 1, j).reduce((p, q) => p + q, 0);
		const place = new Array(row.length);
		// nodes before the lanes of long edges, nodes with a wish before the others, then in the order of the code
		const order = [...row.keys()].sort((i, j) => !!row[i].point - !!row[j].point
			|| (want[i] === undefined) - (want[j] === undefined) || row[i].pos - row[j].pos);
		for(const i of order) {
			let lo = -Infinity, hi = Infinity;
			place.forEach((at, j) => {
				if(j < i) {
					lo = Math.max(lo, at + span(j, i));
				} else if(j > i) {
					hi = Math.min(hi, at - span(i, j));
				}
			});
			const d = want[i] ?? (lo > -Infinity ? lo : hi < Infinity ? hi : 0);
			place[i] = lo > hi ? lo : Math.min(Math.max(d, lo), hi);
		}
		// where a row was too tight for the wishes, its nodes move apart: nothing overlaps
		for(let i = 1; i < row.length; i++) {
			place[i] = Math.max(place[i], place[i - 1] + span(i - 1, i));
		}
		row.forEach((n, i) => x.set(n.id, place[i]));
	}
	// the files lie side by side, each right of the ones before
	const files = [...new Set([...byPos, ...points].map(fileOf))].sort((a, b) => a - b);
	let shift = 0;
	for(let k = 1; k < files.length; k++) {
		const ext = (f, sign) => [...byPos, ...points].filter(n => fileOf(n) === f).map(n => x.get(n.id) + sign * width(n) / 2);
		const before = Math.max(...files.slice(0, k).flatMap(f => ext(f, 1)));
		const delta = Math.max(0, before + 0.6 - Math.min(...ext(files[k], -1)));
		shift = delta;
		[...byPos, ...points].filter(n => fileOf(n) >= files[k]).forEach(n => x.set(n.id, x.get(n.id) + shift));
	}
	// a lane runs straight where it can: all its points move to one place (that of its source, its
	// target, or one of its points) that is free in each of its rows
	const busy = (d, px, self) => rows[d].some(n => !self.includes(n.id)
		&& Math.abs(x.get(n.id) - px) < width(n) / 2 + (n.point ? 0.14 : 0.16));
	for(const [e, lane] of lanes) {
		const base = [x.get(e.from), x.get(e.to), ...lane.map(id => x.get(id))];
		const cost = c => lane.reduce((p, id) => p + Math.abs(x.get(id) - c), 0);
		const cands = [...base, ...base.flatMap(b => [1, -1, 2, -2, 3, -3].map(k => b + k * 0.15))];
		const fine = cands.filter(c => lane.every(id => !busy(layer.get(id), c, lane)));
		// the place of the source or the target first, else the one that moves the lane least
		const best = fine.find(c => c === base[0] || c === base[1]) ?? fine.sort((p, q) => cost(p) - cost(q))[0];
		if(best !== undefined) {
			lane.forEach(id => x.set(id, best));
		}
	}
	// a gap between two layers is as high as the edges that run sideways in it need
	const runs = new Array(depth + 1).fill(0);
	// an edge between nodes that overlap sideways goes straight, so it needs no run sideways
	const span = id => byId.get(id) ? width(byId.get(id)) / 2 - 0.12 : 0;
	const hop = (p, q) => {
		if(Math.abs(x.get(p) - x.get(q)) > Math.max(0.1, span(p) + span(q))) {
			runs[Math.min(layer.get(p), layer.get(q))]++;
		}
	};
	live.forEach(e => {
		if(lanes.has(e)) {
			[e.from, ...lanes.get(e), e.to].forEach((id, k, seq) => k && hop(seq[k - 1], id));
		} else if(Math.abs(layer.get(e.from) - layer.get(e.to)) === 1) {
			hop(e.from, e.to);
		}
	});
	let top = 0;
	rows.forEach((row, d) => {
		const h = Math.max(0, ...row.map(height));
		row.forEach(n => y.set(n.id, top - h / 2));
		// a gap that edges only cross straight needs room for their tips, one with runs sideways also
		// room above and below them
		top -= h + Math.max(vgap, runs[d] ? 0.34 + 0.09 * (runs[d] - 1) : 0);
	});
	// places on a grid of 0.01 cm, as the picture gets them, so that what is in line stays in line
	const placed = byPos.map(n => ({ ...n, x: round(x.get(n.id)), y: round(y.get(n.id)), layer: layer.get(n.id), w: width(n), h: height(n) }));
	// the lanes of the long edges, from their source to their target
	placed.lanes = new Map([...lanes].map(([e, lane]) => [e, lane.map(id => [round(x.get(id)), round(y.get(id)), layer.get(id)])]));
	return placed;
}
const round = v => Math.round(v * 100) / 100;
const num = v => round(v).toString();
export function graphText(name, nodes, edges) {
	const ns = nodes.map(n => `\\mrGraphNode${n.w ? `[${num(n.w)}]` : ''}{${n.id}}{${num(n.x)}}{${num(n.y)}}{${n.kind}}{${n.label.map(l => texText(l)).join('\\\\')}${
		n.note === undefined ? '' : `\\mrGraphId{${texText(n.note)}}`}${n.builtin ? `\\mrGraphBuiltin{${texText(n.builtin)}}` : ''}}`);
	const at = new Map(nodes.map(n => [n.id, n]));
	// the rows of the layers: their middle and height
	const rows = new Map();
	for(const n of nodes) {
		const r = rows.get(n.layer) ?? { y: n.y, h: 0 };
		r.h = Math.max(r.h, n.h ?? 0.5);
		rows.set(n.layer, r);
	}
	const row = p => rows.get(p.layer) ?? { y: p.y, h: 0 };
	// edges run orthogonally: out of a node and into the next vertically, sideways only in the middle
	// of the gap between two rows, where the edges of a gap keep apart
	const gap = (a, b) => {
		const [hi, lo] = row(a).y > row(b).y ? [row(a), row(b)] : [row(b), row(a)];
		return { mid: (hi.y - hi.h / 2 + lo.y + lo.h / 2) / 2, size: hi.y - hi.h / 2 - lo.y - lo.h / 2 };
	};
	const xy = ([px, py]) => `(${num(px)},${num(py)})`;
	const anchor = (id, side, dx = 0) => Math.abs(dx) < 0.005 ? `(mr-${id}.${side})` : `([xshift=${num(dx)}cm]mr-${id}.${side})`;
	// the label of a branch sits in the middle of its first run sideways, else of its first segment
	// (TikZ places a node on the segment it follows)
	const pathText = (e, spec) => {
		if(!e.label) {
			return `\\mrGraphPath{${e.kind}}{${spec}}`;
		}
		const parts = spec.split(' -- ');
		const ys = parts.map(q => /^\(([-\d.]+),([-\d.]+)\)$/.exec(q)?.[2]);
		let k = ys.findIndex((y, j) => j > 0 && y !== undefined && y === ys[j - 1]);
		const side = k > 0 ? 'above' : 'right';
		k = k > 0 ? k : 1;
		parts[k] = `node[mr edge label,pos=.5,${side}]{\\mrGraphLabel{${e.label}}} ${parts[k]}`;
		return `\\mrGraphPath{${e.kind}}{${parts.join(' -- ')}}`;
	};
	// the edges at the top and at the bottom of a node end at points of their own along it, in the
	// order of where they come from, so that no two arrows meet
	const ends = new Map(), plans = [];
	for(const e of edges) {
		const from = at.get(e.from), to = at.get(e.to), lane = nodes.lanes?.get(e);
		if(!from || !to || e.kind === 'back' && lane || from.layer === to.layer) {
			plans.push({ e, from, to, lane });
			continue;
		}
		const upward = to.y > from.y;
		const seq = [from, ...(lane ?? []).map(([px, py, l]) => ({ x: px, y: py, layer: l })), to];
		const plan = { e, from, to, seq, sideS: upward ? 'north' : 'south', sideE: upward ? 'south' : 'north' };
		for(const [node, side, toward] of [[from, plan.sideS, seq[1]], [to, plan.sideE, seq[seq.length - 2]]]) {
			const key = `${node.id}.${side}`;
			(ends.get(key) ?? ends.set(key, []).get(key)).push({ plan, toward: toward.x, which: node === from ? 'offS' : 'offE' });
		}
		plans.push(plan);
	}
	// how far from its sides an edge may end on a node: on the straight part of stadiums and hexagons
	const edge = n => n.kind === 'use' || n.kind === 'cgbuiltin' ? Math.min(0.17, n.w / 2 - 0.1) : ['entry', 'exit', 'cgmain'].includes(n.kind)
		? Math.min((n.h ?? 0.5) / 2, n.w / 2 - 0.1) : n.kind === 'value' || n.kind === 'branch' ? 0.2 : 0.08;
	// an end may move along its side of the node if it stays on the node (room) and keeps away from the
	// other ends there (free)
	const room = (n, x) => round(Math.min(Math.max(x, n.x - n.w / 2 + edge(n)), n.x + n.w / 2 - edge(n)));
	const free = (node, side, x, plan) => (ends.get(`${node.id}.${side}`) ?? []).every(it => it.plan === plan
		|| Math.abs(node.x + (it.plan[it.which] ?? 0) - x) >= 0.14);
	const fits = (node, side, x, plan) => Math.abs(room(node, x) - x) < 0.005 && free(node, side, x, plan);
	for(const [key, list] of ends) {
		const node = at.get(key.slice(0, key.lastIndexOf('.')));
		list.sort((a, b) => a.toward - b.toward);
		const width = Math.min(node.w - 2 * edge(node), 0.18 * (list.length - 1));
		list.forEach((it, k) => {
			it.plan[it.which] = list.length < 2 ? 0 : round(-width / 2 + width * k / (list.length - 1));
		});
	}
	const es = [], runs = [], used = new Map(), lines = [];
	for(const p of plans) {
		const { e, from, to, lane } = p;
		if(!from || !to) {
			continue;
		}
		if(e.kind === 'back' && lane) {
			// around the blocks, into the side of the target
			es.push(pathText(e, [e.start, ...lane.map(xy), e.end].join(' -- ')));
			continue;
		}
		if(e.from === e.to) {
			// a call of itself (recursion): a small loop at the right side
			es.push(pathText(e, `([yshift=2pt]mr-${e.from}.east) -- ++(0.22,0) -- ++(0,-0.26) -- ++(-0.22,0)`));
			continue;
		}
		if(from.layer === to.layer) {
			es.push(pathText(e, `(mr-${e.from}) -- (mr-${e.to})`));
			continue;
		}
		// an edge between two nodes above each other goes straight: its end moves below its start (or
		// the other way round) as far as the node allows, rather than lean
		if(p.seq.length === 2) {
			const s0 = from.x + p.offS, e0 = to.x + p.offE;
			if(Math.abs(s0 - e0) < 0.6) {
				if(fits(to, p.sideE, s0, p)) {
					p.offE = s0 - to.x;
				} else if(fits(from, p.sideS, e0, p)) {
					p.offS = e0 - from.x;
				}
			}
		}
		const xs = p.seq.map((q, k) => k === 0 ? q.x + p.offS : k === p.seq.length - 1 ? q.x + p.offE : q.x);
		const last = xs.length - 1;
		const moveStart = x => fits(from, p.sideS, x, p) && (xs[0] = x, p.offS = x - from.x, true);
		const moveEnd = x => fits(to, p.sideE, x, p) && (xs[last] = x, p.offE = x - to.x, true);
		// an edge with a lane leaves and enters in line with it where the node allows
		if(last > 1) {
			moveStart(xs[1]);
			moveEnd(xs[last - 1]);
		}
		// a jog of almost nothing would be a notch: the lane, or else an end, moves in line instead.
		// An edge never leans
		for(let k = 0; k < last; k++) {
			if(Math.abs(xs[k] - xs[k + 1]) < 0.12) {
				if(k + 1 < last) {
					xs[k + 1] = xs[k];
				} else if(!moveEnd(xs[k]) && k === 0) {
					moveStart(xs[1]);
				}
			}
		}
		const segs = [];
		for(let k = 0; k < last; k++) {
			if(Math.abs(xs[k] - xs[k + 1]) < 0.005) {
				continue;
			}
			const g = gap(p.seq[k], p.seq[k + 1]), key = g.mid.toFixed(2);
			used.set(key, (used.get(key) ?? 0) + 1);
			segs.push({ k, g, key });
		}
		runs.push({ p, xs, segs });
	}
	// the runs sideways in one gap spread over its middle, but keep away from the rows, so that every
	// edge leaves and enters a node straight
	const seen = new Map();
	for(const { p, xs, segs } of runs) {
		const pts = [];
		for(const { k, g, key } of segs) {
			const count = used.get(key), n = seen.get(key) ?? 0;
			seen.set(key, n + 1);
			const step = count > 1 ? Math.min(0.09, Math.max(0, g.size - 0.34) / (count - 1)) : 0;
			const yl = g.mid + (n - (count - 1) / 2) * step;
			pts.push([xs[k], yl], [xs[k + 1], yl]);
		}
		es.push(pathText(p.e, [anchor(p.e.from, p.sideS, p.offS), ...pts.map(xy), anchor(p.e.to, p.sideE, p.offE)].join(' -- ')));
		const yOf = (n, side) => n.y + (side === 'north' ? 1 : -1) * (n.h ?? 0.5) / 2;
		lines.push([[xs[0], yOf(p.from, p.sideS)], ...pts, [xs.at(-1), yOf(p.to, p.sideE)]]);
	}
	// a frame around the nodes of each file, with its name
	const frames = (nodes.files ?? []).map((f, k) => {
		const mine = nodes.filter(n => n.file === k);
		return mine.length ? `\\mrGraphGroup{${texText(f)}}{${mine.map(n => `(mr-${n.id})`).join('')}}` : '';
	});
	return `\\mrFlowrGraph{${name}}{${ns.join('')}${frames.join('')}${legendText(nodes, edges, lines)}}{${es.join('')}}`;
}

const LEGEND_NAMES = { cgmain: 'top level', cgfun: 'function', cgbuiltin: 'of R', vdef: 'definition', fdef: 'function', use: 'use', value: 'value', fcall: 'call', entry: 'entry',
	block: 'block', branch: 'condition', exit: 'exit', reads: 'reads', definedBy: 'defined by', calls: 'calls',
	returns: 'returns', argument: 'argument', flow: 'flow', cond: 'branch (T, F)', back: 'loop' };
/**
 * Where the legend of a graph goes: \mrGraphLegendAt{x}{y} (its top left corner, cm) in a corner of the
 * graph that no node or edge crosses, else below the graph (no position). Its size is estimated from
 * the names of the shapes and edges it lists, in two columns.
 */
function legendText(nodes, edges, lines) {
	const kinds = [...new Set(nodes.map(n => n.kind))].filter(k => LEGEND_NAMES[k]);
	const ekinds = [...new Set(edges.map(e => e.kind))].filter(k => LEGEND_NAMES[k]);
	const len = ks => Math.max(0, ...ks.map(k => LEGEND_NAMES[k].length));
	const w = 0.65 + len(kinds) * 0.075 + 0.95 + len(ekinds) * 0.075, h = 0.2 + 0.34 * Math.max(kinds.length, ekinds.length);
	const xs = nodes.flatMap(n => [n.x - n.w / 2, n.x + n.w / 2]), ys = nodes.flatMap(n => [n.y - (n.h ?? 0.5) / 2, n.y + (n.h ?? 0.5) / 2]);
	const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
	const hits = (l, r, b, t) => nodes.some(n => n.x - n.w / 2 < r && n.x + n.w / 2 > l && n.y - (n.h ?? 0.5) / 2 < t && n.y + (n.h ?? 0.5) / 2 > b)
		|| lines.some(ps => ps.some((q, k) => k > 0 && Math.min(q[0], ps[k - 1][0]) < r && Math.max(q[0], ps[k - 1][0]) > l
			&& Math.min(q[1], ps[k - 1][1]) < t && Math.max(q[1], ps[k - 1][1]) > b));
	const m = 0.12;
	for(const [l, t] of [[x1 - w, y0 + h], [x0, y0 + h], [x1 - w, y1], [x0, y1]]) {
		if(x1 - x0 >= w && !hits(l - m, l + w + m, t - h - m, t + m)) {
			return `\\mrGraphLegendAt{${num(l)}}{${num(t)}}`;
		}
	}
	return '';
}

const HIDDEN_CALLS = new Set(['{', '(', '<-', '<<-', '=', '->', '->>']);
/** the dataflow graph of an answer as magic-r draws it */
export function dataflowGraph(name, answer, lines, opts = {}) {
	const g = graphOf(answer);
	if(!g) {
		return undefined;
	}
	const text = id => {
		const l = g.loc(id);
		return l ? (l[0] === l[2] ? lines[l[0] - 1]?.slice(l[1] - 1, l[3]) : lines[l[0] - 1]?.slice(l[1] - 1)) ?? '' : '';
	};
	const nodes = [];
	for(const [id, v] of g.vertices) {
		// grouping and assignment add nothing: the definition reads its value directly
		if(v.tag === 'fcall' && HIDDEN_CALLS.has(v.name)) {
			continue;
		}
		const l = g.loc(id);
		const label = v.tag === 'fcall' ? Array.isArray(v.name) ? `${v.name[1]}::${v.name[0]}` : String(v.name)
			: v.tag === 'fdef' ? 'function' : text(id);
		const file = opts.files?.findIndex(f => l && l[0] >= f.from && l[0] <= f.to);
		nodes.push({ id: `v${id}`, kind: v.tag, label: [shorten(label.trim(), 20)], note: id, pos: l ? l[0] * 1000 + l[1] : 1e9,
			...file >= 0 ? { file } : {} });
	}
	// what a vertex reads or calls of R itself ('built-in:+') is named below its label
	const seen = new Map(nodes.map(n => [n.id, n]));
	for(const [from, es] of g.edges) {
		const at = seen.get(`v${from}`);
		const builtins = (at ? es : []).filter(([to, types]) => to.startsWith('built-in:') && types & (EDGE.reads | EDGE.calls));
		if(builtins.length) {
			at.builtin = [...new Set(builtins.map(([to]) => to))].join(' ');
		}
	}
	const ids = new Set(nodes.map(n => n.id)), edges = [];
	for(const [from, es] of g.edges) {
		for(const [to, types] of es) {
			const kind = Object.entries(EDGE).find(([, bit]) => types & bit)?.[0];
			if(kind && ids.has(`v${from}`) && ids.has(`v${to}`)) {
				edges.push({ from: `v${from}`, to: `v${to}`, kind });
			}
		}
	}
	const placed = layout(nodes, edges, opts);
	placed.files = opts.files?.map(f => f.name);
	return graphText(name, placed, edges);
}

/**
 * The call graph of an answer: the top level, the functions of the code (named as they are assigned),
 * and what of R they call, with an edge from each caller to each function it calls.
 */
export function callGraph(name, answer, lines, opts = {}) {
	const cg = answer?.['call-graph']?.graph, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!cg) {
		return undefined;
	}
	const vertices = new Map(cg.vertexInformation.map(([id, v]) => [String(id), v]));
	const out = new Map(cg.edgeInformation.map(([from, es]) => [String(from), es.map(([to]) => String(to))]));
	const loc = id => Array.isArray(ids[id]?.[1]) ? ids[id][1] : undefined;
	const fname = id => {
		const l = loc(id);
		return (l && /([A-Za-z.][\w.]*)\s*(?:<<-|<-|=)\s*$/.exec((lines[l[0] - 1] ?? '').slice(0, l[1] - 1))?.[1]) ?? `function ${id}`;
	};
	const nodes = [{ id: 'main', kind: 'cgmain', label: ['top level'], pos: -1 }], edges = [], known = new Set(['main']);
	const node = (id, kind, label, pos) => {
		if(!known.has(id)) {
			known.add(id);
			nodes.push({ id, kind, label: [shorten(label, 24)], pos });
		}
		return id;
	};
	const fdefs = [...vertices].filter(([, v]) => v.tag === 'fdef').map(([id]) => id);
	fdefs.forEach(id => node(`f${id}`, 'cgfun', fname(id), (loc(id)?.[0] ?? 0) * 1000 + (loc(id)?.[1] ?? 0)));
	// the calls of a function: those its definition points to, and the calls in their arguments, but
	// not the calls of the functions they call (which their definitions point to)
	const direct = new Map(fdefs.map(f => [f, new Set(out.get(f) ?? [])]));
	const owned = new Map();
	for(const f of fdefs) {
		const todo = [...direct.get(f)];
		while(todo.length) {
			const c = todo.pop();
			if(owned.has(c) || vertices.get(c)?.tag !== 'fcall' || fdefs.some(g => g !== f && direct.get(g).has(c))) {
				continue;
			}
			owned.set(c, f);
			todo.push(...(out.get(c) ?? []));
		}
	}
	const owner = c => owned.get(c);
	const builtins = new Map();
	const calls = (caller, c) => {
		const v = vertices.get(c);
		if(v?.tag !== 'fcall' || HIDDEN_CALLS.has(v.name) || v.name === 'function') {
			return;
		}
		const targets = (out.get(c) ?? []).filter(t => vertices.get(t)?.tag === 'fdef');
		const b = builtins.get(String(v.name)) ?? builtins.set(String(v.name), `b${builtins.size}`).get(String(v.name));
		const to = targets.length ? targets.map(t => `f${t}`) : [node(b, 'cgbuiltin', String(v.name), 1e9)];
		for(const t of to) {
			if(!edges.some(e => e.from === caller && e.to === t)) {
				edges.push({ from: caller, to: t, kind: 'calls' });
			}
		}
	};
	for(const c of vertices.keys()) {
		const f = owner(c);
		calls(f === undefined ? 'main' : `f${f}`, c);
	}
	// with a function: only what it calls, directly or not
	let shown = nodes, shownEdges = edges;
	if(opts.function) {
		const root = nodes.find(n => n.kind === 'cgfun' && n.label[0] === opts.function);
		const keep = new Set(root ? [root.id] : []);
		for(let more = true; more;) {
			more = false;
			for(const e of edges) {
				if(keep.has(e.from) && !keep.has(e.to)) {
					keep.add(e.to);
					more = true;
				}
			}
		}
		shown = nodes.filter(n => keep.has(n.id));
		shownEdges = edges.filter(e => keep.has(e.from) && keep.has(e.to));
	}
	// a function that calls itself gets room for the loop at its right
	shown.forEach(n => n.loop = shownEdges.some(e => e.from === n.id && e.to === n.id));
	return graphText(name, layout(shown, shownEdges, { ...opts, up: true }), shownEdges);
}

/** the control flow graph of an answer in basic blocks, each labeled with its code */
export function controlFlowGraph(name, answer, lines, opts = {}) {
	const cf = answer?.['control-flow']?.controlFlow, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!cf?.graph) {
		return undefined;
	}
	const entry = new Set((cf.entryPoints ?? []).map(String)), exit = new Set((cf.exitPoints ?? []).map(String));
	const nodes = [];
	for(const [id, info] of cf.graph.vtxInfos) {
		// markers ('12-exit') stand where their compound starts, they are no code of the block
		const elems = (Array.isArray(info[2]) ? info[2].map(e => String(e[1])) : [String(id)]).filter(e => !/-exit$/.test(e));
		let locs = elems.map(e => ids[e]?.[1]).filter(Array.isArray);
		// a loop or condition stands for its end in the block after it: its keyword is no code there
		const code = locs.filter(l => !/^(for|while|repeat|if|function)$/.test(lines[l[0] - 1]?.slice(l[1] - 1, l[3]) ?? ''));
		locs = code.length ? code : locs;
		if(!locs.length) {
			continue;
		}
		// the lines of its elements, compound ones ('for', 'if') only if there is nothing else
		const single = locs.filter(l => l[0] === l[2]);
		const rows = [...new Set((single.length ? single : locs).map(l => l[0]))].sort((x, y) => x - y);
		const from = rows[0];
		let label = rows.map(r => lines[r - 1]?.trim() ?? '').filter(Boolean);
		if(rows.length === 1 && locs.every(l => l[0] === l[2])) {
			// a block within one line: what it spans there
			const c1 = Math.min(...locs.map(l => l[1])), line = lines[from - 1] ?? '';
			let c2 = Math.max(...locs.map(l => l[3]));
			// a call is located at its name, so the closing parentheses come along
			const open = t => (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
			while(open(line.slice(c1 - 1, c2)) > 0 && line[c2] === ')') {
				c2++;
			}
			label = [line.slice(c1 - 1, c2).trim()];
		}
		if(label.length > 5) {
			label = [...label.slice(0, 4), '…'];
		}
		nodes.push({ id: `b${String(id).replace(/[^\w]/g, '')}`, raw: String(id), kind: entry.has(String(id)) ? 'entry' : exit.has(String(id)) ? 'exit' : 'block',
			label: label.map(l => shorten(l, 32)), pos: from * 1000 + Math.min(...locs.map(l => l[1])) });
	}
	const byRaw = new Map(nodes.map(n => [n.raw, n.id])), edges = [];
	for(const [from, es] of cf.graph.edgeInfos) {
		for(const [to, e] of es) {
			if(byRaw.has(String(from)) && byRaw.has(String(to))) {
				edges.push({ from: byRaw.get(String(from)), to: byRaw.get(String(to)), kind: e?.when === undefined ? 'flow' : 'cond',
					label: e?.when === undefined ? '' : e.when ? 'T' : 'F' });
			}
		}
	}
	// a block that decides (with edges for true and false) is a condition
	for(const n of nodes) {
		if(n.kind === 'block' && edges.some(e => e.from === n.id && e.kind === 'cond')) {
			n.kind = 'branch';
		}
	}
	const placed = layout(nodes, edges, { ...opts, up: true });
	const at = new Map(placed.map(n => [n.id, n]));
	// an edge that goes back up (a loop) runs right of every block between its ends, one lane per loop
	let lane = 0;
	const routed = edges.map(e => {
		const from = at.get(e.from), to = at.get(e.to);
		if(!from || !to || to.layer > from.layer) {
			return e;
		}
		const right = Math.max(...placed.filter(n => n.y <= Math.max(from.y, to.y) + 0.01 && n.y >= Math.min(from.y, to.y) - 0.01)
			.map(n => n.x + n.w / 2)) + 0.25 + 0.18 * lane++;
		// it leaves and enters at the right side, or below and above where a block is right of its end
		const beside = n => placed.some(m => m !== n && Math.abs(m.y - n.y) < 0.01 && m.x > n.x);
		const below = from.y - from.h / 2 - 0.2, above = to.y + to.h / 2 + 0.2;
		const back = { ...e, kind: 'back',
			start: beside(from) ? `(mr-${e.from}.south)` : `(mr-${e.from}.east)`,
			end: beside(to) ? `(mr-${e.to}.north)` : `(mr-${e.to}.east)` };
		placed.lanes ??= new Map();
		placed.lanes.set(back, [
			...beside(from) ? [[from.x, below], [right, below]] : [[right, from.y]],
			...beside(to) ? [[right, above], [to.x, above]] : [[right, to.y]]
		]);
		return back;
	});
	return graphText(name, placed, routed);
}

/** the lines of the code a slice keeps */
export function sliceLines(answer) {
	const ids = answer?.['location-map']?.map?.ids ?? {}, lines = new Set();
	for(const r of Object.values(answer?.['static-slice']?.results ?? {})) {
		for(const id of r?.slice?.result ?? []) {
			const l = ids[String(id)]?.[1];
			if(Array.isArray(l)) {
				for(let i = l[0]; i <= l[2]; i++) {
					lines.add(i);
				}
			}
		}
	}
	return [...lines].sort((a, b) => a - b);
}

/** the value of a JSON pointer ('/a/0/b') in an answer, as text */
export function pointer(value, ptr = '') {
	for(const key of ptr.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
		value = value?.[key];
	}
	if(value === undefined) {
		return '??';
	}
	if(Array.isArray(value) && value.every(v => typeof v !== 'object')) {
		return value.join(', ');
	}
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The place [line, column] a criterion points at: '5:3', '5@x' (the first x of line 5), or '5@[2]x'
 * (the second one), undefined for others ('$12') or names that are not there.
 */
export function place(c, lines) {
	const m = /^(\d+)(?::(\d+)|@(?:\[(\d+)\])?(.+))$/.exec(String(c).trim());
	if(!m) {
		return undefined;
	}
	if(m[2]) {
		return [Number(m[1]), Number(m[2])];
	}
	const name = m[4].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const found = [...(lines[m[1] - 1] ?? '').matchAll(new RegExp(`(?<![\\w.])${name}(?![\\w.])`, 'g'))][(m[3] ?? 1) - 1];
	return found && [Number(m[1]), found.index + 1];
}

/** a criterion as flowR reads it: the line and column of '5@[2]x', others as they are */
export function criterion(c, lines) {
	const p = /@\[/.test(c) && place(c, lines);
	return p ? p.join(':') : String(c).trim().replace(/@\[\d+\]/, '@');
}

/**
 * The part after '#' of a link into flowR's playground: the code (base64url), marks (lines '3',
 * criteria '5@x', findings 'lint:rule'), and where the cursor is ('3:5').
 */
export function playgroundHash(lines, marks = [], at) {
	const enc = s => s.replace(/[^A-Za-z0-9\-._~!$'()*,;:@/?=]/gu, c => encodeURIComponent(c));
	const code = lines.slice(0, lines.findLastIndex(l => l.trim()) + 1).join('\n');
	return [`c=t${Buffer.from(code).toString('base64url')}`, marks.length ? `h=${enc(marks.join(','))}` : '',
		at ? `p=${at}` : ''].filter(Boolean).join('&');
}

/** the links of the listings that ask for one (no flowR needed): \mrFlowrPlayground{name}{hash} */
export function playgroundTexts(code) {
	const { blocks, requests } = parseCode(code);
	return requests.filter(r => r.kind === 'playground' && /^[\w.:-]+$/.test(String(r.name))).flatMap(r => {
		// the code with its indentation, which magic-r writes to a file of its own, else as flowR gets it
		const b = blockOf(blocks, r.block);
		const file = typeof r.file === 'string' && /^[\w.-]+$/.test(r.file) && fs.existsSync(r.file) ? r.file : undefined;
		const lines = file ? fs.readFileSync(file, 'utf8').split('\n') : b?.lines;
		const marks = [].concat(r.marks ?? []).map(c => criterion(c, lines ?? [])).filter(c => /^\d+(:\d+|@.+)?$/.test(c));
		return lines ? [`\\mrFlowrPlayground{${r.name}}{${playgroundHash(lines, marks)}}`] : [];
	});
}

const REQUESTS = {
	dataflow:       () => [{ type: 'dataflow' }, { type: 'location-map' }],
	'call-graph':   () => [{ type: 'call-graph' }, { type: 'location-map' }],
	// a link to the graph on mermaid.live, as flowR's REPL gives it
	mermaid:        r => ({ 'call-graph': ':query [{"type":"call-graph"}]', 'control-flow': ':controlflowbb*' }[r.graph] ?? ':dataflow*'),
	'control-flow': () => [{ type: 'control-flow', config: { simplificationPasses: ['unique-cf-sets', 'to-basic-blocks'] } }, { type: 'location-map' }],
	slice:          r => [{ type: 'static-slice', criteria: [].concat(r.criterion ?? []).map(c => String(c).trim()) }, { type: 'location-map' }],
	query:          r => Array.isArray(r.query) ? r.query : [r.query],
	lint:           r => [{ type: 'linter', ...Array.isArray(r.rules) && r.rules.length ? { rules: r.rules } : {} }],
	arrows:         () => [{ type: 'dataflow' }, { type: 'location-map' }]
};

/**
 * The arrows of a block: from the name each criterion points at to every definition it reads, or with
 * all, from every use of a variable. Arrows of one variable (one criterion without all) form a group:
 * \mrFlowArrow{block}{line}{column}{line}{column}{group}{tracks and lane} from the use to the definition,
 * and \mrFlowArrowCriterion{block}{line}{column}{group} for a name a criterion points at. With all,
 * the groups are apart (each can be shown alone), so each gets tracks and lanes of its own.
 */
export function arrowTexts(block, answer, lines, criteria = [], all = false) {
	const g = graphOf(answer);
	if(!g) {
		return [];
	}
	const at = id => g.name(id, l => lines[l - 1]) || undefined;
	const vertexAt = new Map([...g.vertices.keys()].map(v => [at(v) && `${at(v).line}:${at(v).col}`, v]));
	const groups = new Map(), arrows = [], seen = new Set(), marks = [];
	const group = key => groups.get(key) ?? groups.set(key, groups.size + 1).get(key);
	const from = (id, k) => {
		const u = at(id);
		for(const [t, types] of g.out(id)) {
			const d = at(t);
			if(types & EDGE.reads && g.vertices.get(t)?.tag === 'vdef' && d && !seen.has(`${u.line}:${u.col}>${d.line}:${d.col}`)) {
				seen.add(`${u.line}:${u.col}>${d.line}:${d.col}`);
				arrows.push({ lu: u.line, cu: u.col, ld: d.line, cd: d.col, g: k });
			}
		}
	};
	[].concat(criteria).forEach((c, i) => {
		const p = place(c, lines), id = p && vertexAt.get(p.join(':'));
		if(id !== undefined) {
			const k = group(all ? at(id).text : `criterion ${i}`);
			marks.push(`\\mrFlowArrowCriterion{${block}}{${p[0]}}{${p[1]}}{${k}}`);
			from(id, k);
		}
	});
	if(all) {
		for(const [id, v] of g.vertices) {
			const n = at(id);
			if(n && (v.tag === 'use' || v.tag === 'vdef')) {
				// every name of a variable can be clicked, also one without arrows
				marks.push(`\\mrFlowArrowName{${block}}{${n.line}}{${n.col}}{${group(n.text)}}`);
				if(v.tag === 'use') {
					from(id, group(n.text));
				}
			}
		}
	}
	const placed = all ? [...new Set(arrows.map(a => a.g))].flatMap(k => arrowTracks(arrows.filter(a => a.g === k))) : arrowTracks(arrows);
	return [...placed.map(a => `\\mrFlowArrow{${block}}{${a.lu}}{${a.cu}}{${a.ld}}{${a.cd}}{${a.g}}{${a.ut}}{${a.dt}}{${a.lane}}`), ...marks];
}

/**
 * Places the arrows of a listing so that none runs on another: an arrow runs below the line of its use
 * from its column to the left of the code (column 0), along a lane up or down, and below the line of its
 * definition to its column (one segment if both are in one line). Segments below one line that overlap
 * get tracks of their own (0 is closest to the line), vertical ones that overlap lanes of their own.
 */
export function arrowTracks(arrows) {
	const rows = new Map();
	const lanes = [];
	const free = (list, lo, hi) => {
		let k = 0;
		while(list.some(s => s.k === k && s.lo <= hi && lo <= s.hi)) {
			k++;
		}
		list.push({ lo, hi, k });
		return k;
	};
	const row = l => rows.get(l) ?? rows.set(l, []).get(l);
	const span = a => a.lu === a.ld ? Math.abs(a.cu - a.cd) : a.cu + a.cd + 1000 * Math.abs(a.lu - a.ld);
	for(const a of [...arrows].sort((x, y) => span(x) - span(y))) {
		if(a.lu === a.ld) {
			a.ut = a.dt = free(row(a.lu), Math.min(a.cu, a.cd), Math.max(a.cu, a.cd));
			a.lane = 0;
		} else {
			a.ut = free(row(a.lu), 0, a.cu);
			a.dt = free(row(a.ld), 0, a.cd);
			a.lane = free(lanes, Math.min(a.lu, a.ld), Math.max(a.lu, a.ld));
		}
	}
	return arrows;
}

/**
 * The findings of flowR's linter in a block: every line a finding spans gets \mrFlowLint{block@line}
 * {from}{to}{certain|uncertain} with the columns it covers there, its first line also
 * \mrFlowLintNote{block@line}{rule}.
 */
export function lintTexts(block, answer, lines) {
	const out = [], notes = new Map(), play = new Map();
	for(const [rule, r] of Object.entries(answer?.linter?.results ?? {})) {
		const found = Array.isArray(r) ? r : r?.results;
		for(const f of Array.isArray(found) ? found : []) {
			const loc = f.loc ?? f.range;
			if(!Array.isArray(loc) || typeof loc[0] !== 'number') {
				continue;
			}
			const [l1, c1, l2, c2] = loc, certainty = f.certainty === 'certain' ? 'certain' : 'uncertain';
			for(let l = l1; l <= l2; l++) {
				out.push(`\\mrFlowLint{${block}@${l}}{${l === l1 ? c1 : 1}}{${l === l2 ? c2 : (lines[l - 1] ?? '').length}}{${certainty}}`);
				// in flowR's playground, a finding is marked by its rule and the cursor is at its start
				const p = play.get(`${block}@${l}`) ?? play.set(`${block}@${l}`, { rules: new Set(), at: `${l1}` }).get(`${block}@${l}`);
				p.rules.add(`lint:${rule}`);
			}
			const at = `${block}@${l1}`;
			notes.set(at, [...new Set([...notes.get(at) ?? [], rule])]);
		}
	}
	// a rule names its page in flowR's wiki: file-path-validity is [Linting-Rule]-File-Path-Validity
	const page = r => r.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
	return [...new Set(out), ...[...notes].map(([at, rules]) =>
		`\\mrFlowLintNote{${at}}{${rules.map(r => `\\mrLintRule{${r}}{${page(r)}}`).join(', ')}}`),
	...[...play].map(([at, p]) => `\\mrFlowLintPlay{${at}}{${[...p.rules].join(',')}}{${p.at}}`)];
}
/**
 * The requests of the document (\mrDataflowGraph, \mrControlFlowGraph, the key mrslice,
 * \mrFlowrQuery), each on the code of its block (by label or id), else of all blocks.
 */
/** the distance between the rows of a graph a request asks for (cm) */
const graphOptions = r => ({ ...Number(r.rowsep) >= 0 ? { vgap: Number(r.rowsep) } : {}, ...r.function ? { function: String(r.function) } : {},
	...r.files ? { files: r.files } : {} });

/**
 * The flowR of a request that names one ('docker:eagleoutice/flowr:2.14.0', 'node:node ~/flowr/dist/src/cli/flowr.js'),
 * to compare the answers of several flowR on one document; undefined if it does not work
 */
export function instanceRepl(spec, opts = {}) {
	const m = /^(node|docker):(.+)$/.exec(spec ?? '');
	if(!m) {
		throw new Error(`cannot read the flowR '${spec}' (docker:<image> or node:<command>)`);
	}
	// an image docker already has: pulling one in the middle of a LaTeX run is no option
	const docker = m[1] === 'docker' && onPath('docker');
	if(m[1] === 'docker' && (!docker || run([docker, 'image', 'inspect', m[2]], { timeout: 20 }).status !== 0)) {
		throw new Error(`docker has no image ${m[2]} (docker pull ${m[2]})`);
	}
	const repl = backends({ ...opts, backend: m[1], ...m[1] === 'docker' ? { image: m[2] } : { flowr: m[2] } })[0];
	repl.version();
	return repl;
}

export function requestTexts(repl, requests, blocks, dir, opts = {}) {
	const todo = [];
	for(let r of requests) {
		if(!REQUESTS[r.kind] || typeof r.name !== 'string' || !/^[\w.:-]+$/.test(r.name)) {
			continue;
		}
		// several listings ('a,b') are one script, each a file of its own in the graph
		const parts = String(r.block ?? '').includes(',') ? String(r.block).split(',').map(x => blockOf(blocks, x.trim())) : undefined;
		const block = parts ? undefined : blockOf(blocks, r.block);
		let lines = parts ? (parts.every(Boolean) ? parts.flatMap(b => b.lines) : undefined)
			: block ? block.lines : r.block === undefined || r.block === '' ? blocks.flatMap(b => b.lines) : undefined;
		if(parts && lines) {
			let first = 1;
			r = { ...r, files: parts.map((b, i) => {
				const f = { name: String(r.block).split(',')[i].trim(), from: first, to: first + b.lines.length - 1 };
				first += b.lines.length;
				return f;
			}) };
		}
		// a slice is computed on all the code of its listing, which magic-r keeps in a file of its own
		let shown;
		if(r.kind === 'slice' && typeof r.file === 'string' && /^[\w.-]+$/.test(r.file) && fs.existsSync(r.file)) {
			shown = lines;
			lines = fs.readFileSync(r.file, 'utf8').replace(/\n$/, '').split('\n');
		}
		if(!lines) {
			continue;
		}
		const crit = c => [].concat(c ?? []).map(x => criterion(x, lines));
		r = { ...r, criterion: crit(r.criterion), criteria: crit(r.criteria) };
		const file = `r${todo.length}.R`;
		fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
		todo.push({ r, lines, shown, file });
	}
	// the requests of each flowR run together; one that flowR cannot answer must not take the others
	// along: then each runs alone
	const out = [];
	for(const spec of new Set(todo.map(t => t.r.instance ?? ''))) {
		const mine = todo.filter(t => (t.r.instance ?? '') === spec);
		let flowr = repl;
		if(spec) {
			try {
				flowr = instanceRepl(spec, opts);
				out.push(`\\mrFlowrInstance{${texText(spec)}}{${texMessage(flowr.describe())}}`);
			} catch(e) {
				out.push(`\\mrFlowrInstance{${texText(spec)}}{${texMessage(e.message)}}`);
				continue;
			}
		}
		const cmds = mine.map(({ r, file }) => {
			const q = REQUESTS[r.kind](r);
			return typeof q === 'string' ? `${q} file://${flowr.file(dir, file)}` : flowr.query(q, dir, file);
		});
		let answers;
		try {
			answers = flowr.exec(cmds, dir);
		} catch{
			answers = cmds.map(c => {
				try {
					return flowr.exec([c], dir)[0];
				} catch{
					return undefined;
				}
			});
		}
		mine.forEach((t, i) => out.push(...answerText(t, answers[i])));
	}
	return out;
}

/** what magic-r reads of the answer to a request, by its kind (a query, else) */
const ANSWERS = {
	// the part after '#' apart, which TeX cannot take in a link otherwise
	mermaid:        ({ r }, a) => typeof a.url === 'string'
		? [`\\mrFlowrMermaid{${r.name}}{${a.url.replace(/[^!-~]/g, '').replace('#', '}{')}}`] : [],
	dataflow:       ({ r, lines }, a) => [dataflowGraph(r.name, a, lines, graphOptions(r))],
	'call-graph':   ({ r, lines }, a) => [callGraph(r.name, a, lines, graphOptions(r))],
	'control-flow': ({ r, lines }, a) => [controlFlowGraph(r.name, a, lines, graphOptions(r))],
	arrows:         ({ r, lines }, a) => arrowTexts(r.block, a, lines, r.criteria, r.all === true),
	lint:           ({ r, lines }, a) => lintTexts(r.block, a, lines),
	slice:          ({ r, lines, shown }, a) => {
		const kept = sliceLines(a);
		// the listing shows all of the code or just the slice, else its file is old: no slice, so
		// that the next run shows all and writes the file again
		const same = (xs, ys) => xs.length === ys.length && xs.every((x, j) => x === ys[j]);
		const trim = xs => xs.slice(0, xs.findLastIndex(x => x.trim()) + 1);
		const fresh = !shown || same(trim(shown), trim(lines)) || same(trim(shown), trim(kept.map(l => lines[l - 1])));
		return [`\\mrFlowrSlice{${r.name}}{${fresh ? kept.join(',') : ''}}`];
	},
	query:          ({ r }, a) => [`\\mrFlowrResult{${r.name}}{${texText(pointer(a, r.path ?? ''))}}`]
};
const answerText = (t, a) => a ? ANSWERS[t.r.kind](t, a).filter(Boolean) : [];

/** whether a version satisfies a requirement: '2.15.10' (exactly), '>=2.15', '>2', '<=3', '<3' */
export function satisfies(version, req) {
	const m = /^\s*(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*)\s*$/.exec(req ?? '');
	if(!m) {
		throw new Error(`cannot read the version requirement '${req}'`);
	}
	const v = String(version ?? '').split(/[.-]/).map(Number), r = m[2].split('.').map(Number);
	if(v.some(Number.isNaN) || !v.length) {
		return false;
	}
	let cmp = 0;
	for(let i = 0; i < r.length && cmp === 0; i++) {
		cmp = Math.sign((v[i] ?? 0) - r[i]);
	}
	return { '>=': cmp >= 0, '<=': cmp <= 0, '>': cmp > 0, '<': cmp < 0, '=': cmp === 0, undefined: cmp === 0 }[m[1]];
}

/** the loads a plain scan finds: library(x), require("x"), pacman::p_load(x, y), and x::name */
export function detectByScan(blocks) {
	const entries = [];
	for(const b of blocks) {
		b.lines.forEach((raw, i) => {
			const line = raw.replace(/(^|[^"'\\])#.*$/, '$1');
			const at = [b.id, i + 1];
			for(const m of line.matchAll(/\b(library|require|requireNamespace|loadNamespace)\s*\(\s*["'`]?([A-Za-z][A-Za-z0-9.]*)/g)) {
				entries.push({ pkg: m[2], attach: ATTACHING.has(m[1]), at });
			}
			for(const m of line.matchAll(/\bp_load\s*\(([^)]*)\)/g)) {
				for(const p of m[1].split(',').map(s => s.trim().replace(/^["'`]|["'`]$/g, ''))) {
					if(/^[A-Za-z][A-Za-z0-9.]*$/.test(p)) {
						entries.push({ pkg: p, attach: true, at });
					}
				}
			}
			for(const m of line.matchAll(/(?<![\w.])([A-Za-z][A-Za-z0-9.]*):::?(?=[A-Za-z.`%])/g)) {
				entries.push({ pkg: m[1], attach: false, at });
			}
		});
	}
	return { entries, skipped: [] };
}

export function planPrefixes(symbols, max = MAX_MATCHES) {
	const plan = (names, prefix) => {
		if(names.length <= max) {
			return [prefix];
		}
		const groups = new Map();
		for(const n of names) {
			const k = n.length > prefix.length ? n[prefix.length] : '';
			groups.set(k, [...groups.get(k) ?? [], n]);
		}
		return [...groups].flatMap(([c, ns]) => c === '' ? [prefix + '\0'] : plan(ns, prefix + c));
	};
	return plan([...new Set(symbols)], '');
}
/** '?' stands for the characters a glob would read, a trailing '\0' for the prefix as a name */
export function globOf(prefix) {
	return prefix.endsWith('\0') ? prefix.slice(0, -1) : prefix.replace(/[*?]/g, '?') + (prefix === '' ? '?*' : '*');
}

/** the exports of packages from flowR's signature query: pkg -> {version, fns} */
export function exportsWithFlowr(repl, wanted, dir) {
	fs.writeFileSync(path.join(dir, 'sig.R'), wanted.map(w => `library(${w.pkg})`).join('\n') + '\n');
	const result = new Map(wanted.map(w => [w.pkg, { version: w.version, fns: new Map() }]));
	// the export lists of the dependencies query plan the searches; without, they split when truncated
	let todo = wanted.flatMap(w => (w.symbols ? planPrefixes(w.symbols) : ['']).map(p => [w.pkg, p]));
	for(let round = 0; todo.length > 0; round++) {
		if(round > 4) {
			throw new Error('the signature database does not narrow down');
		}
		const next = [];
		repl.exec(todo.map(([pkg, p]) => repl.query([{ type: 'signature', package: pkg, function: globOf(p) }], dir, 'sig.R')), dir).forEach((a, i) => {
			const [pkg, prefix] = todo[i], sig = a?.signature, entry = result.get(pkg);
			if(!sig) {
				throw new Error(`the signature query of flowR failed for ${pkg}`);
			}
			const matches = sig.matches ?? (sig.function?.name ? [{ ...sig.function, package: pkg }] : []);
			if(sig.truncated) {
				// the next characters: those of the export list, else every one a name may have
				const known = wanted.find(w => w.pkg === pkg).symbols?.filter(n => n.startsWith(prefix) && n.length > prefix.length);
				const chars = new Set([...known?.map(n => n[prefix.length]) ?? ALPHABET, ...matches.map(m => m.name[prefix.length]).filter(Boolean)]);
				next.push([pkg, prefix + '\0'], ...[...chars].map(c => [pkg, prefix + c]));
				return;
			}
			for(const m of matches) {
				if(m.package === pkg && m.exported !== false && !entry.fns.has(m.name)) {
					entry.fns.set(m.name, m);
					entry.version ??= m.version;
				}
			}
		});
		todo = next;
	}
	return new Map([...result].map(([p, r]) => [p, { version: r.version, fns: [...r.fns.values()] }]));
}

/** the web backend: the table the signature browser embeds, kept for a week */
export class Web {
	constructor({ cache, page = SIGDB_PAGE, timeout } = {}) {
		Object.assign(this, { name: 'web', cache, page, timeout });
	}
	async load() {
		if(this.table) {
			return this.table;
		}
		const file = this.cache && path.join(this.cache, 'sigdb-page.txt');
		let text;
		if(file && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 24 * 3600e3) {
			text = fs.readFileSync(file, 'utf8');
		} else {
			const res = await fetch(this.page, { signal: AbortSignal.timeout((this.timeout ?? 120) * 1000) });
			if(!res.ok) {
				throw new Error(`web: ${this.page} answers ${res.status}`);
			}
			const html = await res.text();
			const data = /<[^>]*\bid="data"[^>]*>([^<]*)</.exec(html)?.[1].trim();
			if(!data) {
				throw new Error('web: the signature browser has no table');
			}
			text = zlib.gunzipSync(Buffer.from(data, 'base64')).toString('utf8');
			if(file) {
				fs.mkdirSync(this.cache, { recursive: true });
				fs.writeFileSync(file + '.part', text);
				fs.renameSync(file + '.part', file);
			}
		}
		this.table = parseTable(text);
		this.stamp = this.table.stamp;
		return this.table;
	}
	describe() {
		return `web sigdb ${this.stamp ?? ''}`.trim();
	}
}

/**
 * The table of the signature browser: names, a blank line, packages. A package is
 * 'name\tversion\tbase\t...', a name 'name\towner,owner' with an owner 'index:flags:params:topic:...'
 * (the topic only if it is not the name). Flags: 'u' no help page, 'm' an S4 method only.
 */
export function parseTable(text) {
	const between = text.indexOf('\n\n');
	const packages = text.slice(between + 2).split('\n').map(l => l.split('\t'));
	const exports = new Map(); // package index -> [{name, topic}]
	for(const line of text.slice(0, between).split('\n')) {
		const tab = line.indexOf('\t');
		const name = line.slice(0, tab);
		if(!linkable(name)) {
			continue;
		}
		for(const owner of line.slice(tab + 1).split(',').filter(Boolean)) {
			const [index, flags = '', , topic] = owner.split(':');
			if(!/[um]/.test(flags)) {
				const list = exports.get(+index) ?? [];
				exports.set(+index, list);
				list.push({ name, topic: topic ? decodeURIComponent(topic) : name });
			}
		}
	}
	const byName = new Map(packages.map(([name, version], i) => [name, { version, fns: exports.get(i) ?? [] }]));
	return { byName, stamp: packages.length ? `${packages.length} packages` : '' };
}

/** topics from the help index of installed packages: pkg -> Map(alias -> topic) */
export function helpTopics(rscript, pkgs) {
	const out = new Map();
	if(!rscript || pkgs.length === 0) {
		return out;
	}
	// the aliases of the help pages, and the data sets, which are no exports ('mtcars')
	const code = `for (p in commandArgs(TRUE)) { f <- system.file("help", "aliases.rds", package = p)
		if (nzchar(f)) { a <- readRDS(f); cat(paste(p, names(a), a, sep = "\\t"), sep = "\\n")
			d <- utils::data(package = p)$results[, "Item"]
			if (length(d)) cat(paste(p, "", sub(" .*", "", d), sep = "\\t"), sep = "\\n") } }`;
	try {
		const res = run([...splitCommand(rscript), '--vanilla', '-e', code, '--args', ...pkgs], { timeout: 60 });
		for(const line of (res.stdout ?? '').split('\n')) {
			const [p, alias, topic] = line.split('\t');
			const help = out.get(p) ?? out.set(p, new Map()).get(p);
			if(alias && topic) {
				help.set(alias, topic);
			} else if(topic) {
				(help.data ??= []).push(topic);
			}
		}
	} catch{ /* R is optional */ }
	return out;
}

/** the exports of installed packages, for packages flowR does not know: pkg -> {version, fns} */
export function rExports(rscript, pkgs) {
	const out = new Map();
	if(!rscript || pkgs.length === 0) {
		return out;
	}
	const code = `for (p in commandArgs(TRUE)) if (nzchar(system.file(package = p))) {
		x <- tryCatch(getNamespaceExports(p), error = function(e) character())
		cat(paste(p, packageDescription(p)$Version, x, sep = "\t"), sep = "\n") }`;
	try {
		const res = run([...splitCommand(rscript), '--vanilla', '-e', code, '--args', ...pkgs], { timeout: 120 });
		for(const line of (res.stdout ?? '').split('\n')) {
			const [p, version, name] = line.split('\t');
			if(name) {
				const e = out.get(p) ?? out.set(p, { version, fns: [] }).get(p);
				e.fns.push({ name });
			}
		}
	} catch{ /* R is optional */ }
	return out;
}

/** the versions of installed packages as their DESCRIPTION has them ('7.3-65'): pkg -> version */
export function rVersions(rscript, pkgs) {
	const out = new Map();
	if(!rscript || pkgs.length === 0) {
		return out;
	}
	const code = `for (p in commandArgs(TRUE)) if (nzchar(system.file(package = p))) cat(p, "\t", packageDescription(p)$Version, "\n", sep = "")`;
	try {
		for(const line of (run([...splitCommand(rscript), '--vanilla', '-e', code, '--args', ...pkgs], { timeout: 60 }).stdout ?? '').split('\n')) {
			const [p, v] = line.split('\t');
			if(v) {
				out.set(p, v.trim());
			}
		}
	} catch{ /* R is optional */ }
	return out;
}

/**
 * The help index of an installed package decides the topics: the signature database guesses a
 * topic from the name for names without a help page (dead links) and misses some aliases ('%>%').
 * A name the index lacks keeps its link only if the database knows a topic other than its name.
 */
export function withHelp(fns, help) {
	if(!help) {
		return fns;
	}
	return fns.flatMap(f => {
		if(help.has(f.name)) {
			return [{ name: f.name, topic: help.get(f.name) }];
		}
		const topic = f.topic ?? Object.values(SCHEMES).map(re => f.docUrl?.match(re)).find(Boolean)?.[2];
		return topic && topic !== f.name ? [f] : [];
	});
}

export function cacheDir(opts) {
	if(opts.noCache) {
		return undefined;
	}
	return opts.cache ?? process.env.MAGIC_R_CACHE ?? (process.platform === 'win32'
		? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'magic-r')
		: path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'magic-r'));
}

/** the backends to try, in order */
export function backends(opts) {
	const timeout = opts.timeout, kinds = opts.backend && opts.backend !== 'auto' ? [opts.backend] : ['node', 'docker', 'r', 'web'];
	const out = [];
	for(const kind of kinds) {
		if(kind === 'node') {
			const cmd = opts.flowr ?? process.env.MAGIC_R_FLOWR ?? onPath('flowr');
			if(cmd) {
				out.push(new Repl('node', splitCommand(cmd), { timeout, engine: opts.engine }));
			}
		} else if(kind === 'docker') {
			const image = opts.image ?? 'eagleoutice/flowr:latest', docker = onPath('docker');
			// an image docker already has: pulling 700 MB in the middle of a LaTeX run is no option
			if(docker && (opts.backend === 'docker' || run([docker, 'image', 'inspect', image], { timeout: 20 }).status === 0)) {
				const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
				out.push(new Repl('docker', dir => [docker, 'run', '--rm', '-i', ...user, '-v', `${dir}:/work`, image],
					{ timeout, mount: '/work', engine: opts.engine }));
			}
		} else if(kind === 'r') {
			if(opts.rscript) {
				out.push(new RRepl(opts.rscript, { timeout }));
			}
		} else if(kind === 'web') {
			out.push(new Web({ cache: cacheDir(opts), timeout }));
		} else {
			throw new Error(`unknown backend ${kind}`);
		}
	}
	return out;
}

/** runs f with the first backend that works; the failures of the others explain a total failure */
export async function withBackend(opts, f) {
	const errors = [];
	for(const b of backends(opts)) {
		try {
			const version = b.version?.(); // that it is flowR at all
			if(opts.requireVersion && !satisfies(version, opts.requireVersion)) {
				throw new Error(`${b.name}: flowR ${version ?? 'of unknown version'} does not satisfy ${opts.requireVersion}`);
			}
			return await withTemp(dir => f(b, dir));
		} catch(e) {
			errors.push(e.message);
		}
	}
	throw new Error(errors.length ? errors.join('; ') : 'no flowR backend');
}

async function withTemp(f) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-r-'));
	try {
		return await f(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** the database entries of packages (pkg -> text), cached per backend version and package version */
export async function packageEntries(backend, wanted, opts, dir) {
	const cache = cacheDir(opts), web = backend instanceof Web;
	if(web) {
		await backend.load();
		wanted = wanted.map(w => ({ ...w, version: backend.table.byName.get(w.pkg)?.version }));
	}
	// the format of the entries is part of the key: a new one makes the old cache unused
	const key = `${web ? 'web' : `flowr-${backend.version()}`}-${CACHE_FORMAT}`;
	const file = w => cache && w.version ? path.join(cache, key, `${w.pkg}@${w.version}.cfg`) : undefined;
	const entries = new Map(), missing = [];
	for(const w of wanted) {
		const f = file(w);
		if(f && fs.existsSync(f)) {
			entries.set(w.pkg, fs.readFileSync(f, 'utf8').trimEnd());
		} else {
			missing.push(w);
		}
	}
	if(missing.length) {
		const found = web ? new Map(missing.map(w => [w.pkg, backend.table.byName.get(w.pkg)]).filter(([, v]) => v))
			: exportsWithFlowr(backend, missing, dir);
		// what flowR does not know, an installed R may
		for(const [p, e] of rExports(opts.rscript, missing.filter(w => !found.get(w.pkg)?.fns.length).map(w => w.pkg))) {
			found.set(p, e);
		}
		const topics = helpTopics(opts.rscript, missing.map(w => w.pkg));
		const versions = rVersions(opts.rscript, missing.map(w => w.pkg));
		for(const w of missing) {
			const s = found.get(w.pkg), help = topics.get(w.pkg);
			const fns = [...s?.fns ?? [], ...(help?.data ?? []).map(name => ({ name }))];
			if(!fns.length) {
				continue;
			}
			const text = packageEntry(w.pkg, versions.get(w.pkg) ?? s?.version ?? 'unknown', withHelp(fns, help));
			entries.set(w.pkg, text);
			const f = file({ ...w, version: s.version });
			if(f) {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f + '.part', text + '\n');
				fs.renameSync(f + '.part', f);
			}
		}
	}
	return entries;
}

export async function documentText(backend, code, opts, dir) {
	const { blocks, requests } = parseCode(code);
	const web = backend instanceof Web;
	const { entries, skipped, units = [] } = web || blocks.length === 0 ? detectByScan(blocks) : detectWithFlowr(backend, blocks, dir);
	const wanted = new Map();
	for(const e of entries) {
		const w = wanted.get(e.pkg) ?? wanted.set(e.pkg, { pkg: e.pkg }).get(e.pkg);
		w.version ??= e.version;
		w.symbols ??= e.symbols;
	}
	const pkgs = await packageEntries(backend, [...wanted.values()], opts, dir);
	const ops = operators([...pkgs.values()]);
	let answered = [];
	if(requests.length) {
		try {
			if(web) {
				throw new Error('the web backend answers no queries');
			}
			answered = requestTexts(backend, requests, blocks, dir, opts);
		} catch(e) {
			answered = [`\\mrFlowrRequestsFailed{${texMessage(e.message)}}`];
		}
	}
	return [
		`% magic-r: the packages of the document, found by ${backend.describe()}`,
		`\\mrFlowrStatus{ok}{${texMessage(backend.describe())}}`,
		...skipped.map(id => `\\mrFlowrSkipped{${id}}`),
		...pkgs.values(),
		...ops.length ? [`\\mrOperators{${ops.join(',')}}`] : [],
		...[...wanted.keys()].map(p => `\\mrUses{${p}}`),
		...entries.filter(e => e.attach && e.at).map(e => `\\mrLoad{${e.at[0]}}{${e.at[1]}}{${e.pkg}}`),
		...units.length ? [`\\mrFlowBlocks{${units.flatMap(u => u.ids).join(',')}}`] : [],
		...units.flatMap(flowFacts),
		...units.flatMap(dependencyLines),
		...answered
	].join('\n') + '\n';
}

function writeAtomic(file, text) {
	fs.writeFileSync(file + '.part', text);
	fs.renameSync(file + '.part', file);
}

export async function documentCommand(opts, [input, output]) {
	if(!input || !output) {
		throw new Error('usage: magic-r-flowr.mjs document [options] <code.R> <out.cfg>');
	}
	let text, code = '';
	try {
		code = fs.readFileSync(input, 'utf8');
		text = await withBackend(opts, (b, dir) => documentText(b, code, opts, dir));
	} catch(e) {
		text = `\\mrFlowrStatus{failed}{${texMessage(e.message)}}\n`;
	}
	// links into the playground need no flowR
	writeAtomic(output, text + playgroundTexts(code).map(t => t + '\n').join(''));
}

export async function generateCommand(opts, [list]) {
	const root = path.dirname(fileURLToPath(import.meta.url));
	const pkgs = fs.readFileSync(list ?? path.join(root, 'tools', 'packages.txt'), 'utf8')
		.split('\n').flatMap(l => l.replace(/#.*/, '').trim().split(/\s+/)).filter(Boolean);
	const out = opts.output ?? path.join(root, 'magic-r-links.cfg');
	const text = await withBackend(opts, async(b, dir) => {
		let wanted = pkgs.map(pkg => ({ pkg }));
		if(!(b instanceof Web)) {
			fs.writeFileSync(path.join(dir, 'doc.R'), pkgs.map(p => `library(${p})`).join('\n') + '\n');
			const found = new Map(libraryEntries(b.exec([b.query([{ type: 'dependencies' }], dir, 'doc.R')], dir)[0]).map(e => [e.pkg, e]));
			wanted = pkgs.map(pkg => ({ pkg, version: found.get(pkg)?.version, symbols: found.get(pkg)?.symbols }));
		}
		const entries = await packageEntries(b, wanted, { ...opts, noCache: true }, dir);
		const missing = pkgs.filter(p => !entries.has(p));
		if(missing.length) {
			throw new Error(`${b.name}: no package ${missing.join(', ')}`);
		}
		const body = pkgs.map(p => entries.get(p));
		return `% magic-r-links.cfg: generated by magic-r-flowr.mjs (${b.describe()}), regenerate it from tools/packages.txt\n`
			+ body.join('\n') + `\n\\mrOperators{${operators(body).join(',')}}\n`;
	});
	writeAtomic(out, text);
	console.error(`wrote ${pkgs.length} packages to ${out}`);
}

const untex = s => s.replace(/\\([%#$&])/g, '$1');
const DOCS = { rman: p => `https://stat.ethz.ch/R-manual/R-devel/library/${p}/html/`, cran: p => `https://rdrr.io/cran/${p}/man/` };
const PACKAGE = /\\mrPackage\[(\w+)\]\{([^}]*)\}\{[^}]*\}\{%\n([\s\S]*?)\n\}$/gm;
const ENTRY = /\\([NTU])(?:\{([^}]*)\})?\{(?:%\n)?([\s\S]*?)\}%/g;
/** the URL of a name in an entry of a database, as magic-r computes it */
function entryUrl(scheme, pkg, kind, arg, name) {
	return kind === 'U' ? untex(arg) : DOCS[scheme](pkg) + (kind === 'N' ? name : untex(arg)) + '.html';
}
const entryNames = names => names.replace(/%\n/g, '').split(',').filter(Boolean);

/** the URLs of a database: url -> names */
export function databaseUrls(text) {
	const urls = new Map();
	for(const [, scheme, pkg, body] of text.matchAll(PACKAGE)) {
		for(const [, kind, arg, names] of body.matchAll(ENTRY)) {
			for(const n of entryNames(names)) {
				const url = entryUrl(scheme, pkg, kind, arg, untex(n));
				urls.set(url, [...urls.get(url) ?? [], `${pkg}::${untex(n)}`]);
			}
		}
	}
	return urls;
}

/** the database without the names whose page is one of `dead` */
export function prune(text, dead) {
	const out = text.replace(PACKAGE, (all, scheme, pkg, body) => {
		const kept = body.replace(ENTRY, (entry, kind, arg, names) => {
			const alive = entryNames(names).filter(n => !dead.has(entryUrl(scheme, pkg, kind, arg, untex(n))));
			return alive.length === 0 ? '' : entryText(`\\${kind}${arg === undefined ? '' : `{${arg}}`}`, alive.map(untex));
		}).replace(/\n{2,}/g, '\n').replace(/^\n|\n$/g, '');
		return `\\mrPackage[${scheme}]{${pkg}}{${all.match(/^\\mrPackage\[\w+\]\{[^}]*\}\{([^}]*)\}/)[1]}}{%\n${kept}\n}`;
	});
	return out.replace(/\\mrOperators\{[^\n]*\}/, () => `\\mrOperators{${operators([out.replace(/\\mrOperators\{[^\n]*\}/, '')]).join(',')}}`);
}

export async function verifyCommand(opts, [file]) {
	const root = path.dirname(fileURLToPath(import.meta.url));
	file ??= path.join(root, 'magic-r-links.cfg');
	const text = fs.readFileSync(file, 'utf8');
	const urls = [...databaseUrls(text)];
	const dead = new Set();
	let next = 0;
	const worker = async() => {
		while(next < urls.length) {
			const [url, names] = urls[next++];
			let status = 0;
			for(let attempt = 0; attempt < 3 && status !== 200 && status !== 404; attempt++) {
				status = await fetch(url).then(r => r.status, () => 0);
			}
			if(status !== 200) {
				dead.add(url);
				console.log(`FAIL ${status} ${url} (${names.join(', ')})`);
			}
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	console.error(`verified ${urls.length} pages, ${dead.size} failed`);
	if(opts.prune && dead.size) {
		writeAtomic(file, prune(text, dead));
		console.error(`removed their names from ${file}`);
	} else {
		process.exitCode = dead.size ? 1 : 0;
	}
}

export function parseArgs(argv) {
	const opts = {}, rest = [];
	const keys = { '--flowr': 'flowr', '--rscript': 'rscript', '--cache': 'cache', '--timeout': 'timeout', '-o': 'output', '--backend': 'backend', '--image': 'image', '--require-version': 'requireVersion', '--engine': 'engine' };
	for(let i = 0; i < argv.length; i++) {
		if(argv[i] === '--no-cache') {
			opts.noCache = true;
		} else if(argv[i] === '--prune') {
			opts.prune = true;
		} else if(keys[argv[i]]) {
			if(i + 1 >= argv.length) {
				throw new Error(`${argv[i]} needs a value`);
			}
			opts[keys[argv[i]]] = argv[++i];
		} else {
			rest.push(argv[i]);
		}
	}
	opts.timeout = opts.timeout === undefined ? undefined : Number(opts.timeout);
	opts.rscript = opts.rscript === '-' ? undefined : opts.rscript ?? process.env.MAGIC_R_RSCRIPT ?? onPath('Rscript');
	return { opts, rest };
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	const { opts, rest } = parseArgs(args);
	const commands = { document: documentCommand, generate: generateCommand, verify: verifyCommand };
	if(commands[cmd]) {
		return commands[cmd](opts, rest);
	}
	const usage = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
	console.log(usage.slice(1, usage.findIndex(l => l.startsWith('import'))).map(l => l.slice(3)).join('\n'));
	process.exitCode = cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(e => {
		console.error(`error: ${e.message}`);
		process.exitCode = 1;
	});
}
