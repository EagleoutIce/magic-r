#!/usr/bin/env node
// magic-r-flowr.mjs: the bridge between magic-r and flowR (https://github.com/flowr-analysis/flowr).
//
//   node magic-r-flowr.mjs document [options] <code.R> <out.cfg>
//   node magic-r-flowr.mjs generate [options] [-o magic-r-links.cfg] [packages.txt]
//   node magic-r-flowr.mjs verify [--prune] [cfg]
//   node magic-r-flowr.mjs install <version>
//
// document: finds the packages the R code of a document loads or uses (magic-r writes one
//   block per listing, each after a line '## magic-r block <id>') and writes their links and
//   the block and line of every load to a file magic-r reads. With a backend that has a
//   dataflow graph, it adds where each name is defined, the lines that read or write files,
//   and the answers of the requests of the document ('## magic-r request {...}': graphs,
//   slices, queries). The lines that read, write, ... only for the blocks that mark them (a line
//   '## magic-r dependencies'). The file always exists afterwards and starts with \mrFlowrStatus{...}.
//   Unless --no-cleanup, it removes the side files of older versions ('<job>.mr-play-<n>.R').
// generate: the shipped link database, for the packages of a list (one name per line).
//   It requests every page and handles the ones that fail as verify --prune does.
// verify: requests every documentation page of a database and reports the ones that fail;
//   --prune moves their names to the first fallback page that works (the page of the name
//   itself, then search.r-project.org) and removes the ones without any.
// install: installs flowR of a version into the cache (npm), for --require-version <version>.
//
// flowR runs through the first backend that works (--backend picks one):
//   node    the flowR command line: --flowr <command>, $MAGIC_R_FLOWR, 'flowr' on the PATH, or
//           the one of 'npm install -g @eagleoutice/flowr'
//   docker  the image eagleoutice/flowr (--image), if docker has it
//   r       the R package flowr, through Rscript
//   web     the signature table of https://flowr-analysis.github.io/flowr/wiki/sigdb/, with
//           loads found by a plain scan of the code
// Other options: --rscript <command> (R's help index improves topics, '-' to skip),
//   --cache <dir> (default $MAGIC_R_CACHE, else the user cache: the entries of packages, the versions
//   of flowR, and flowR's answers by the code they are of), --no-cache, --timeout <s>,
//   --require-version <v> (a backend must have flowR v: '2.15.10', '>=2.15', '<3'; an exact version
//   switches flowR: the docker image eagleoutice/flowr:<v>, else the npm package of that version,
//   installed into the cache once unless --no-install),
//   --engine lax|tree-sitter|r-shell|default (how the node and docker backends parse: lax, the
//   default, is tree-sitter with its lax parser, which reads code with syntax errors).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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
const CACHE_FORMAT = 'f4';
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
 * The S3 generics of a package: those R knows (`generics`, from an installed package), else the
 * functions with at least two methods ('tidy' of 'tidy.lm' and 'tidy.glm') among its names.
 */
export function s3Generics(fns, generics) {
	if(generics) {
		return [...new Set(generics)].filter(linkable);
	}
	const names = new Set(fns.map(f => f.name)), methods = new Map();
	for(const n of names) {
		for(let i = n.indexOf('.', 1); i > 0; i = n.indexOf('.', i + 1)) {
			const g = n.slice(0, i);
			if(names.has(g) && i < n.length - 1) {
				methods.set(g, (methods.get(g) ?? 0) + 1);
			}
		}
	}
	return [...methods].filter(([g, k]) => k >= 2 && linkable(g)).map(([g]) => g);
}

/**
 * The database entry of a package: \N lists the names documented under their own name, \T{topic}
 * the ones of another topic, \U{url} the ones of any other page, \S the S3 generics, whose methods
 * ('print.foo') link to them, \D the names that are no functions (data sets).
 * @param {{name: string, docUrl?: string, topic?: string}[]} fns
 * @param {string[]} [generics] the S3 generics R knows, else they are guessed from the names
 * @param {string[]} [data] the names that are no functions (data sets, constants): \D, plain as variables
 */
export function packageEntry(pkg, version, fns, generics, data = []) {
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
	// only generics that link themselves
	const s3 = s3Generics(fns, generics).filter(g => seen.has(g));
	if(s3.length) {
		out.push(entryText('\\S', s3));
	}
	const values = [...new Set(data)].filter(n => seen.has(n));
	if(values.length) {
		out.push(entryText('\\D', values));
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

/**
 * The command line of flowR installed with 'npm install -g @eagleoutice/flowr', which has no
 * command 'flowr': its cli/flowr.js, run by this node. npm installs into <prefix>/lib/node_modules
 * (<prefix>/node_modules on Windows), the prefix is $NPM_CONFIG_PREFIX or the one of this node.
 */
export function npmFlowr(env = process.env, execPath = process.execPath) {
	const prefixes = [env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix,
		process.platform === 'win32' ? path.dirname(execPath) : path.dirname(path.dirname(execPath))].filter(Boolean);
	for(const prefix of prefixes) {
		for(const root of [path.join(prefix, 'lib', 'node_modules'), path.join(prefix, 'node_modules')]) {
			const cli = path.join(root, '@eagleoutice', 'flowr', 'cli', 'flowr.js');
			if(fs.existsSync(cli)) {
				return [execPath, cli];
			}
		}
	}
	return undefined;
}

export function run(argv, { cwd, timeout, input, merged, toFile, env } = {}) {
	// a .js file runs with this node, so a flowR checkout works without a wrapper
	const [cmd, ...args] = /\.[cm]?js$/.test(argv[0]) ? [process.execPath, ...argv] : argv;
	// merged: stdout and stderr in one file, in order; toFile: stdout in a file (older flowR cuts a pipe at 8 KiB)
	const file = (merged || toFile) && path.join(os.tmpdir(), `magic-r-${merged ? 'merged' : 'out'}-${process.pid}.out`);
	const fd = file && fs.openSync(file, 'w');
	try {
		const res = spawnSync(cmd, args, {
			cwd, input, env, encoding: 'utf8', timeout: (timeout ?? 120) * 1000, maxBuffer: 1 << 30, windowsHide: true,
			shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd), ...fd ? { stdio: [input === undefined ? 'ignore' : 'pipe', fd, merged ? fd : 'pipe'] } : {}
		});
		if(res.error) {
			throw new Error(`cannot run ${argv[0]}: ${res.error.code === 'ETIMEDOUT' ? 'timeout' : res.error.message}`);
		}
		return fd ? { ...res, stdout: fs.readFileSync(file, 'utf8'), stderr: merged ? '' : res.stderr ?? '' } : res;
	} finally {
		if(fd) {
			fs.closeSync(fd);
			fs.rmSync(file, { force: true });
		}
	}
}

/** run without blocking, so that R works while flowR does: resolves with stdout and the exit status */
export function runAsync(argv, { cwd, timeout } = {}) {
	return new Promise(resolve => {
		let stdout = '';
		const child = spawn(argv[0], argv.slice(1), { cwd, timeout: (timeout ?? 120) * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		child.stdout.setEncoding('utf8').on('data', d => stdout += d);
		child.on('error', () => resolve({ stdout, status: null }));
		child.on('close', status => resolve({ stdout, status }));
	});
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
 * The answers of commands separated by ':version' (one line of every flowR), so a failing command
 * takes no other along: JSON (or a mermaid link), null for anything else (an error), undefined if
 * flowR stopped before (crash, timeout). `parts`: the separators seen
 */
export function separatedAnswers(stdout, count) {
	const out = new Array(count).fill(undefined);
	let parts = 0;
	for(const line of stdout.split('\n')) {
		if(/^\s*flowR:?\s+v?\d/.test(versionIn.plain(line))) {
			parts++;
			continue;
		}
		const k = parts - 1;
		if(k < 0 || k >= count || out[k] !== undefined) {
			continue;
		}
		const url = /(?:^|\]\()(https:\/\/mermaid\.live\/[^\s)]+)/.exec(line);
		if(url) {
			out[k] = { url: url[1] };
		} else if(line.startsWith('{')) {
			try {
				out[k] = JSON.parse(line);
			} catch{ /* cut */ }
		}
	}
	for(let k = 0; k < count && k + 2 <= parts; k++) {
		out[k] ??= null;
	}
	return { answers: out, parts };
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
/** what a flowR that does not know an engine (older ones lack lax) gets instead, in order */
const ENGINE_FALLBACKS = { lax: ['tree-sitter', 'default'], 'tree-sitter': ['default'], 'r-shell': ['default'], default: [] };

/** a version of flowR in its output ('flowR: 2.15.10'), also when it is a link of the terminal */
export function versionIn(text) {
	return /flowR:?\s+v?(\d+\.\d+\.\d+)/.exec(versionIn.plain(text))?.[1];
}
versionIn.plain = text => String(text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** a query command every flowR reads: older ones split like a shell, so the JSON is quoted and escaped */
export function queryCommand(queries, file) {
	return `:query* "${JSON.stringify(queries).replace(/[\\"']/g, c => '\\' + c)}" file://${file}`;
}

/**
 * A backend that speaks flowR's REPL: `exec(cmds, dir)` runs commands (files of `dir` are named by
 * `file(name)`) and answers with one JSON object per command.
 */
export class Repl {
	constructor(name, argv, { timeout, mount, engine = 'lax', cache, identity, home } = {}) {
		Object.assign(this, { name, argv, timeout, mount, cache, identity, engineName: engine, engine: ENGINES[engine], fixedHome: home });
		if(!this.engine) {
			throw new Error(`unknown engine ${engine}`);
		}
	}
	file(dir, name) {
		return this.mount ? `${this.mount}/${name}` : path.join(dir, name).replaceAll('\\', '/');
	}
	query(queries, dir, name) {
		return queryCommand(queries, this.file(dir, name));
	}
	/** where flowR runs: older versions look for tree-sitter in ./node_modules */
	home(dir) {
		if(this.fixedHome !== undefined || !Array.isArray(this.argv)) {
			return this.fixedHome ?? dir;
		}
		this.fixedHome = null;
		for(const a of this.argv.slice(0, 3)) {
			let real;
			try {
				real = fs.realpathSync(path.isAbsolute(a) || /[/\\]/.test(a) ? a : onPath(a) ?? '');
			} catch{
				continue;
			}
			for(let d = path.dirname(real), k = 0; k < 8 && d !== path.dirname(d); d = path.dirname(d), k++) {
				if(fs.existsSync(path.join(d, 'node_modules', 'web-tree-sitter'))) {
					this.fixedHome = d;
					return d;
				}
			}
		}
		return dir;
	}
	/** the version of flowR, cached by what identifies it (its files, the id of its image) */
	version() {
		if(this.cachedVersion) {
			return this.cachedVersion;
		}
		const id = this.identity ? this.identity() : Array.isArray(this.argv) ? commandIdentity(this.argv) : undefined;
		const key = this.cache && id && JSON.stringify([id, this.engine]);
		const known = key && readVersions(this.cache)[key];
		if(known && Array.isArray(known.engine)) {
			this.engine = known.engine;
			this.cachedVersion = known.version;
		} else {
			this.askVersion();
			if(key) {
				writeVersion(this.cache, key, { version: this.cachedVersion, engine: this.engine });
			}
		}
		this.answerKey = key && JSON.stringify([id, this.cachedVersion, this.engine]);
		return this.cachedVersion;
	}
	askVersion() {
		const tmp = os.tmpdir();
		const res = run([...this.prefix(tmp), '--version', '--no-ansi'], { cwd: this.home(tmp), timeout: this.timeout });
		const v = versionIn(res.stdout);
		if(!v) {
			throw new Error(`${this.name}: not flowR (${texMessage((res.stdout || res.stderr || '').split('\n').find(l => l.trim()) ?? '') || 'no output'})`);
		}
		this.cachedVersion = v;
		// the engine asked for, else the next that answers a query (older flowR lacks lax, and some
		// accept its option for --version only)
		const engines = [this.engineName, ...ENGINE_FALLBACKS[this.engineName] ?? []];
		if(engines.length > 1) {
			const dir = fs.mkdtempSync(path.join(tmp, 'magic-r-'));
			try {
				fs.writeFileSync(path.join(dir, 'probe.R'), 'x <- 1\n');
				const probe = this.query([{ type: 'dataflow' }], dir, 'probe.R');
				this.engine = ENGINES[engines.find(e => {
					this.engine = ENGINES[e];
					try {
						return Boolean(this.exec([probe], dir)[0]);
					} catch{
						return false;
					}
				}) ?? engines.at(-1)];
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	}
	prefix(dir) {
		return typeof this.argv === 'function' ? this.argv(dir) : this.argv;
	}
	/**
	 * flowR's secure mode (2.16) when it parses with tree-sitter and needs no R: no process, no network,
	 * and the clipboard stays alone (flowR copies mermaid links there)
	 */
	env(engine = this.engine) {
		return engine.includes('tree-sitter') ? { ...process.env, FLOWR_SECURE_MODE: '1' } : undefined;
	}
	exec(cmds, dir) {
		if(cmds.length === 0) {
			return [];
		}
		if(cmds.some(c => c.includes(';'))) {
			throw new Error('a flowR command must not contain ";"');
		}
		try {
			return this.execBatch(cmds, dir);
		} catch(e) {
			// the answers of a large document exceed what node holds in one string: halve the batch
			if(cmds.length > 1 && (e instanceof RangeError || /string longer than|ERR_STRING_TOO_LONG|ENOBUFS/.test(e?.message ?? ''))) {
				const half = Math.ceil(cmds.length / 2);
				return [...this.exec(cmds.slice(0, half), dir), ...this.exec(cmds.slice(half), dir)];
			}
			throw e;
		}
	}
	execBatch(cmds, dir) {
		const all = [':version', ...cmds.flatMap(c => [c, ':version'])];
		const res = run(this.command(all, dir), { cwd: this.home(dir), timeout: this.timeout, toFile: true, env: this.env() });
		const { answers: list, parts } = separatedAnswers(res.stdout ?? '', cmds.length);
		if(parts === 0) {
			const why = (res.stderr || res.stdout || '').split('\n').find(l => l.trim()) ?? `exit code ${res.status}`;
			throw new Error(`${this.name}: no answers from flowR: ${texMessage(why)}`);
		}
		return list;
	}
	command(cmds, dir) {
		return [...this.prefix(dir), ...this.engine, '--no-ansi', '-e', cmds.join(';')];
	}
	/** what flowR's REPL prints for the commands, as text; rcode: it may run R (the r-shell engine) */
	raw(cmds, dir, rcode = false) {
		const engine = rcode ? ['--default-engine', 'r-shell', '--r-session-access'] : this.engine;
		// flowR writes its messages ('the command ... is unknown') to stderr, the answers to stdout
		const res = run([...this.prefix(dir), ...engine, '--no-ansi', '-e', cmds.join(';')], { cwd: this.home(dir), timeout: this.timeout, merged: true, env: this.env(engine) });
		if(res.status !== 0 && !res.stdout) {
			throw new Error(`${this.name}: ${texMessage((res.stderr || '').split('\n').find(l => l.trim()) ?? `exit code ${res.status}`)}`);
		}
		return res.stdout ?? '';
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
	// R reads cmds.txt in its directory
	home(dir) {
		return dir;
	}
	env() {
		return undefined;
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

/** the versions of flowR the cache knows: identity -> {version, engine}, each kept for a day */
const VERSIONS = 'flowr-versions.json', VERSION_AGE = 24 * 3600e3;
function readVersions(cache) {
	try {
		const all = JSON.parse(fs.readFileSync(path.join(cache, VERSIONS), 'utf8'));
		return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - v.at < VERSION_AGE));
	} catch{
		return {};
	}
}
function writeVersion(cache, key, value) {
	try {
		fs.mkdirSync(cache, { recursive: true });
		writeAtomic(path.join(cache, VERSIONS), JSON.stringify({ ...readVersions(cache), [key]: { ...value, at: Date.now() } }));
	} catch{ /* only a cache */ }
}

/** flowR's answers by flowR (files, version, engine), command, and code; brotli, gone after 30 days unused */
export class AnswerCache {
	static FORMAT = 'a1';
	static AGE = 30 * 24 * 3600e3;
	static for(repl, opts) {
		const dir = cacheDir(opts);
		return new AnswerCache(dir && repl?.answerKey ? path.join(dir, 'answers') : undefined, repl?.answerKey);
	}
	constructor(dir, flowr) {
		Object.assign(this, { dir, flowr });
	}
	get enabled() {
		return this.dir !== undefined;
	}
	key(...parts) {
		return crypto.createHash('sha256').update(JSON.stringify([AnswerCache.FORMAT, this.flowr, ...parts])).digest('hex');
	}
	get(key) {
		if(!this.enabled || !key) {
			return undefined;
		}
		const file = path.join(this.dir, `${key}.br`);
		try {
			const value = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(file)).toString('utf8'));
			const now = new Date();
			fs.utimesSync(file, now, now);
			return value;
		} catch{
			return undefined;
		}
	}
	set(key, value) {
		if(!this.enabled || !key || value === undefined) {
			return;
		}
		try {
			if(!this.pruned) {
				this.prune();
			}
			const data = zlib.brotliCompressSync(JSON.stringify(value), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
			writeAtomic(path.join(this.dir, `${key}.br`), data);
		} catch{ /* only a cache */ }
	}
	prune() {
		this.pruned = true;
		fs.mkdirSync(this.dir, { recursive: true });
		for(const f of fs.readdirSync(this.dir)) {
			try {
				if(Date.now() - fs.statSync(path.join(this.dir, f)).mtimeMs > AnswerCache.AGE) {
					fs.rmSync(path.join(this.dir, f), { force: true });
				}
			} catch{ /* gone */ }
		}
	}
}
const NO_CACHE = new AnswerCache(undefined, undefined);

/** an answer without the environments of its graphs, which magic-r never reads (most of a dataflow graph) */
export function slim(answer) {
	const strip = graph => graph && {
		...graph, _idMap: undefined,
		vertexInformation: graph.vertexInformation?.map(([id, v]) => [id, { ...v, environment: undefined,
			...v.subflow ? { subflow: { ...v.subflow, environment: undefined } } : {} }])
	};
	if(!answer?.dataflow?.graph && !answer?.['call-graph']?.graph) {
		return answer;
	}
	return { ...answer,
		...answer.dataflow?.graph ? { dataflow: { ...answer.dataflow, graph: strip(answer.dataflow.graph) } } : {},
		...answer['call-graph']?.graph ? { 'call-graph': { ...answer['call-graph'], graph: strip(answer['call-graph'].graph) } } : {} };
}

/** what a command asks: the command without its file's place, and the code in that file */
function commandContent(repl, cmd, dir) {
	if(typeof repl.file !== 'function') {
		return undefined;
	}
	const probe = repl.file(dir, '\0'), base = `file://${probe.slice(0, -1)}`;
	const at = cmd.indexOf(base);
	try {
		return at < 0 ? undefined : ['command', cmd.slice(0, at), fs.readFileSync(path.join(dir, cmd.slice(at + base.length)), 'utf8')];
	} catch{
		return undefined;
	}
}

/** the cache key of a command: the command without its file's place, and the code in that file */
export function commandKey(repl, cache, cmd, dir) {
	const content = cache.enabled ? commandContent(repl, cmd, dir) : undefined;
	return content && cache.key(...content);
}

/**
 * runs the commands not in the cache, with `extra` (not cached) in the same start: { answers, more };
 * commands that ask the same of the same code (the overlays of a beamer frame) run once
 */
export function execCached(repl, cmds, dir, cache = NO_CACHE, extra = []) {
	const keys = cmds.map(c => commandKey(repl, cache, c, dir));
	const answers = keys.map(k => cache.get(k));
	const same = cmds.map(c => JSON.stringify(commandContent(repl, c, dir) ?? c));
	const first = new Map();
	const miss = cmds.map((_, i) => i).filter(i => answers[i] === undefined && !first.has(same[i]) && first.set(same[i], i));
	if(miss.length === 0 && extra.length === 0) {
		return { answers, more: [] };
	}
	const got = repl.exec([...miss.map(i => cmds[i]), ...extra], dir);
	miss.forEach((i, j) => {
		answers[i] = got[j];
		// an error may pass (a file flowR does not see)
		if(!answerError(got[j])) {
			cache.set(keys[i], slim(got[j]));
		}
	});
	answers.forEach((a, i) => {
		answers[i] = a ?? answers[first.get(same[i])];
	});
	return { answers, more: got.slice(miss.length) };
}

/**
 * What identifies the flowR of a command line: the files it names and flowR's package.json, with size
 * and time. undefined for anything else ('npx flowr'), whose version may change any time
 */
export function commandIdentity(argv) {
	const files = [], node = fs.realpathSync(process.execPath);
	for(const [i, a] of argv.entries()) {
		const file = path.isAbsolute(a) || a.includes('/') || a.includes('\\') ? a : onPath(a);
		try {
			const real = fs.realpathSync(file);
			if(real === node || !fs.statSync(real).isFile()) {
				continue;
			}
			files.push(real);
			for(let dir = path.dirname(real), k = 0; k < 6 && dir !== path.dirname(dir); dir = path.dirname(dir), k++) {
				if(fs.existsSync(path.join(dir, 'package.json'))) {
					files.push(path.join(dir, 'package.json'));
					break;
				}
			}
		} catch{
			// a word after the program that is no option and no file
			if(i > 0 && !a.startsWith('-')) {
				return undefined;
			}
		}
	}
	return files.length ? files.map(f => {
		const st = fs.statSync(f);
		return `${f}:${st.size}:${st.mtimeMs}`;
	}) : undefined;
}

/** the dependencies in the form of current flowR (2.2 names them libraries, readData, ...) */
export function dependenciesOf(answer) {
	const deps = answer?.dependencies;
	if(!deps || !['libraries', 'readData', 'writtenData', 'sourcedFiles'].some(k => k in deps)) {
		return deps;
	}
	const old = (list, key) => Array.isArray(list) ? list.map(e => ({ ...e, value: e.value ?? e[key] })) : undefined;
	return { ...deps, library: old(deps.libraries, 'libraryName'), read: old(deps.readData, 'source'),
		write: old(deps.writtenData, 'destination'), source: old(deps.sourcedFiles, 'file') };
}

export function libraryEntries(answer) {
	const deps = dependenciesOf(answer), ids = answer?.['location-map']?.map?.ids ?? {};
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
export const SCOPE_MARK = /^## magic-r scope (\S+)\s*$/;
export const REQUEST_MARK = /^## magic-r request (\{.*\})\s*$/;
export const INDENT_MARK = /^## magic-r indent ([\d,]+)\s*$/;
// a listing whose lines that read, write, ... are marked (option dependencies, key mrdependencies)
export const DEPENDENCIES_MARK = /^## magic-r dependencies\s*$/;
// the code of a file of the key mrsource, which the listing runs after: its lines up to source-end
export const SOURCE_MARK = /^## magic-r source (.+?)\s*$/;
export const SOURCE_END = /^## magic-r source-end\s*$/;

/** the block a request names, by its label or id (the last one of that label), none for the document */
export function blockOf(blocks, ref) {
	return ref === undefined || ref === '' ? undefined : blocks.filter(b => b.label === String(ref) || b.id === String(ref)).at(-1);
}

/** the blocks of the code, each with its label, and the requests of the document */
export function parseCode(code) {
	const blocks = [], requests = [];
	let cur, src;
	code.split(/\r?\n/).forEach(line => {
		// the lines of a file are code, whatever they look like
		if(src) {
			if(SOURCE_END.test(line)) {
				src = undefined;
			} else {
				src.lines.push(line);
			}
			return;
		}
		const m = BLOCK_MARK.exec(line), label = LABEL_MARK.exec(line), req = REQUEST_MARK.exec(line), scope = SCOPE_MARK.exec(line);
		if(m) {
			blocks.push(cur = { id: m[1], lines: [] });
		} else if(label && cur) {
			cur.label = label[1];
		} else if(scope && cur) {
			cur.scope = scope[1];
		} else if(DEPENDENCIES_MARK.test(line) && cur) {
			cur.dependencies = true;
		} else if(SOURCE_MARK.test(line) && cur) {
			src = { name: SOURCE_MARK.exec(line)[1], lines: [] };
			(cur.sources ??= []).push(src);
		} else if(INDENT_MARK.test(line) && cur) {
			// the indentation of each line, which flowR does not get
			cur.indent = INDENT_MARK.exec(line)[1].split(',').map(Number);
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

/** the error of a query in an answer, readable; flowR's 'At least one request must be set' means no R file */
export function answerError(a) {
	for(const [type, part] of Object.entries(a && typeof a === 'object' ? a : {})) {
		if(typeof part?.error === 'string') {
			const why = part.error.split('\n')[0].trim();
			return `${type}: ${/^At least one request must be set/.test(why)
				? 'flowR found no R code in the file it was given (the file is missing, or the directory is not shared with its docker container)'
				: why}`;
		}
	}
	return undefined;
}

/** the analysis of blocks: loads, locations, dataflow; reads, writes, ... only for blocks that mark them (2.4.8) */
export function analysis(repl, group) {
	const onlyLibrary = !group.some(b => b.dependencies) && knownSatisfies(repl, '>=2.4.8');
	return [{ type: 'dependencies', ...onlyLibrary ? { enabledCategories: ['library'] } : {} }, { type: 'location-map' }, dataflowQuery(repl)];
}

/** the version of a flowR, undefined if it does not tell */
function versionOf(repl) {
	try {
		return repl?.version?.();
	} catch{
		return undefined;
	}
}
const knownSatisfies = (repl, req) => versionOf(repl) !== undefined && satisfies(versionOf(repl), req);
const satisfiesSafe = (repl, req) => versionOf(repl) === undefined || satisfies(versionOf(repl), req);

/** the dataflow query, without the environments (most of the answer) from flowR 2.16 on */
export function dataflowQuery(repl) {
	return { type: 'dataflow', ...knownSatisfies(repl, '>=2.16.0') ? { environments: false } : {} };
}

/** the blocks grouped by their scope (key mrscope), in the order the scopes first appear */
export function scopesOf(blocks) {
	const groups = new Map();
	for(const b of blocks) {
		const key = b.scope ?? '';
		if(!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key).push(b);
	}
	return [...groups.values()];
}

/**
 * The loads of all blocks, each scope (key mrscope) as one script, so a scope does not see the
 * definitions of another. flowR answers nothing for code that does not parse, so a sentinel load at
 * the end tells; then every block of that scope is analyzed on its own and broken ones skipped.
 * Each analysis is a unit: its answer, and where a line of its file is (block and line).
 */
export function detectWithFlowr(repl, blocks, dir, extra = [], cache = NO_CACHE) {
	const sentinel = `library(${SENTINEL})`;
	// the files of mrsource come before their listing; their loads count at its first line (from)
	const scopes = scopesOf(blocks).map((group, s) => {
		const map = [], from = [], lines = [];
		for(const b of group) {
			lines.push(`## magic-r block ${b.id}`);
			for(const l of (b.sources ?? []).flatMap(x => x.lines)) {
				lines.push(l);
				from[lines.length] = [b.id, 1];
			}
			b.lines.forEach((l, i) => {
				lines.push(l);
				map[lines.length] = [b.id, i + 1];
			});
		}
		const file = s === 0 ? 'doc.R' : `doc${s}.R`;
		fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n${sentinel}\n`);
		return { group, map, from, lines, file };
	});
	const entries = [], skipped = [], units = [], broken = [];
	const loadsOf = a => {
		try {
			return a ? libraryEntries(a) : [];
		} catch(e) {
			if(answerError(a)) {
				return [];
			}
			throw e;
		}
	};
	// the requests run along (one start of flowR less); if that fails, the analysis runs alone
	const cmds = scopes.map(sc => repl.query(analysis(repl, sc.group), dir, sc.file));
	let all, more;
	try {
		({ answers: all, more } = execCached(repl, cmds, dir, cache, extra));
		more = extra.length ? more : undefined;
	} catch(e) {
		if(!extra.length) {
			throw e;
		}
		all = execCached(repl, cmds, dir, cache).answers;
	}
	all.forEach((answer, s) => {
		const { group, map, from, lines } = scopes[s];
		const whole = loadsOf(answer);
		if(whole.some(e => e.pkg === SENTINEL)) {
			entries.push(...whole.filter(e => e.pkg !== SENTINEL).map(e => ({ ...e, at: map[e.line] ?? from[e.line] })));
			units.push({ answer, at: l => map[l], source: l => lines[l - 1], sourced: l => from[l] !== undefined, ids: group.map(b => b.id) });
		} else {
			broken.push(...group);
		}
	});
	if(broken.length === 0) {
		return { entries, skipped, units, more };
	}
	const pre = b => (b.sources ?? []).flatMap(x => x.lines);
	const alone = broken.map((b, i) => {
		fs.writeFileSync(path.join(dir, `b${i}.R`), `${[...pre(b), ...b.lines].join('\n')}\n${sentinel}\n`);
		return repl.query(analysis(repl, [b]), dir, `b${i}.R`);
	});
	const single = execCached(repl, alone, dir, cache).answers;
	if(units.length === 0 && all.every(a => a === null) && single.every(a => a === null)) {
		throw new Error(`${repl.name}: flowR answered none of the analyses`);
	}
	single.forEach((a, i) => {
		const es = loadsOf(a);
		const b = broken[i], off = pre(b).length, code = [...pre(b), ...b.lines];
		const at = l => l > off && l - off <= b.lines.length ? [b.id, l - off] : undefined;
		if(es.some(e => e.pkg === SENTINEL)) {
			entries.push(...es.filter(e => e.pkg !== SENTINEL).map(e => ({ ...e, at: !e.line ? undefined : at(e.line) ?? (e.line <= off ? [b.id, 1] : undefined) })));
			units.push({ answer: a, at, source: l => code[l - 1], sourced: l => l <= off, ids: [b.id] });
		} else {
			skipped.push(b.id);
		}
	});
	// nothing analyzed and flowR says why: that, not 'does not parse'
	const why = units.length === 0 && [...all, ...single].map(answerError).find(Boolean);
	if(why) {
		throw new Error(`${repl.name}: ${why}`);
	}
	return { entries, skipped, units, more };
}

const NAME = /^(?:[A-Za-z]|\.[A-Za-z._]?)[A-Za-z0-9._]*$/;
const TAGS = { 'function-call': 'fcall', 'variable-definition': 'vdef', 'function-definition': 'fdef' };
const EDGE = { reads: 1, definedBy: 2, calls: 4, returns: 8, argument: 64 };
/** a call of a replacement function, such as 'names<-' of names(x) <- v, but not an assignment */
const isReplacement = v => v?.tag === 'fcall' && typeof v.name === 'string' && /^[^<].*<-$/.test(v.name) && v.name !== '<<-';
/** the vertices and edges of a dataflow graph, with the location of each vertex */
function graphOf(answer, source = () => undefined) {
	const graph = answer?.dataflow?.graph, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!graph) {
		return undefined;
	}
	// flowR before 2.8 names tags in full
	const vertices = new Map(graph.vertexInformation.map(([id, v]) => [String(id), TAGS[v.tag] ? { ...v, tag: TAGS[v.tag] } : v]));
	const edges = new Map(graph.edgeInformation.map(([from, es]) => [String(from), es.map(([to, e]) => [String(to), e.types])]));
	const loc = id => {
		const l = ids[id]?.[1];
		return Array.isArray(l) ? l : undefined;
	};
	// the parameters; before 2.8 flowR lists none: the definitions in the parentheses after 'function'
	const params = new Set([...vertices].flatMap(([id, v]) => {
		if(v.tag !== 'fdef') {
			return [];
		}
		if(v.params) {
			return Object.keys(v.params);
		}
		const l = loc(id), line = l && source(l[0]);
		const open = line ? line.indexOf('(', l[3]) + 1 : 0, close = open ? closing(line, open) : undefined;
		return close ? (v.subflow?.graph ?? []).map(String).filter(p => vertices.get(p)?.tag === 'vdef'
			&& loc(p)?.[0] === l[0] && loc(p)[2] === l[0] && loc(p)[1] > open && loc(p)[3] < close) : [];
	}));
	const out = id => edges.get(id) ?? [];
	// a definition of a function: by a function, a call that returns one ('add1 <- adder(1)'), or a
	// name of one ('h <- adder')
	const fun = (id, seen = new Set()) => {
		const v = vertices.get(id);
		if(!v || seen.has(id)) {
			return false;
		}
		seen.add(id);
		const to = bit => out(id).filter(([, types]) => types & bit).map(([t]) => t);
		return v.tag === 'fdef'
			|| v.tag === 'fcall' && to(EDGE.returns).some(t => fun(t, seen))
			|| v.tag === 'use' && to(EDGE.reads).some(t => fun(t, seen))
			|| v.tag === 'vdef' && to(EDGE.definedBy).some(t => fun(t, seen));
	};
	const kind = id => params.has(id) ? 'param' : fun(id) ? 'fun' : 'var';
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
export function flowFacts({ answer, at, source, sourced = () => false }) {
	const g = graphOf(answer, source);
	if(!g) {
		return [];
	}
	const place = (l, col) => {
		const a = at(l);
		return a && `${a[0]}@${a[1]}@${col}`;
	};
	const name = id => g.name(id, source);
	const before = (a, b) => a.line < b.line || a.line === b.line && a.col <= b.col;
	// a replacement call ('body(f) <- v') redefines a name, which keeps the kind of its definition before
	const strictlyBefore = (a, b) => a.line < b.line || a.line === b.line && a.col < b.col;
	const kind = id => {
		const k = g.kind(id), n = name(id);
		if(k !== 'var' || !n || !g.out(id).some(([t, types]) => types & EDGE.definedBy && isReplacement(g.vertices.get(t)))) {
			return k;
		}
		const prev = [...g.vertices].filter(([t, v]) => v.tag === 'vdef' && name(t)?.text === n.text && strictlyBefore(name(t), n))
			.sort(([a], [b]) => before(name(a), name(b)) ? 1 : -1)[0];
		return prev ? kind(prev[0]) : k;
	};
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
			set(n, at => at === here ? `\\mrFlowDef{${at}}{${kind(id)}}` : `\\mrFlowRef{${at}}{${kind(id)}}{${here}}`);
		} else if(v.tag === 'use' || v.tag === 'fcall' && typeof v.name === 'string' && v.name === n.text) {
			// the definition read last before the use, else the first one
			const read = g.out(id).filter(([t, types]) => types & EDGE.reads && g.vertices.get(t)?.tag === 'vdef')
				.map(([t]) => ({ t, n: name(t) })).filter(d => d.n && place(d.n.line, d.n.col));
			// a definition of the same name: flowR places some reads at a call ('c' of mget(c("x"))). A
			// variable defined under another name ('var_name' of assign(var_name, 42)) counts for a use
			// when it has none, as for the arrows
			const same = read.filter(d => d.n.text === n.text);
			// the last definition before the use, else one after it in the same listing (a function reads
			// what comes after it), never one of a later listing; of the same name first
			const listing = d => at(d.n.line)?.[0];
			const pick = defs => defs.filter(d => before(d.n, n)).sort((a, b) => before(a.n, b.n) ? 1 : -1)[0]
				?? defs.filter(d => listing(d) === at(n.line)?.[0])[0];
			// a call flowR resolves to a function but reads no definition for ('g' of g(return(1))): the
			// definitions of that function, of the same name
			const called = v.tag === 'fcall' ? g.out(id).filter(([t, types]) => types & EDGE.calls && g.vertices.get(t)?.tag === 'fdef')
				.flatMap(([f]) => [...g.vertices].filter(([t, w]) => w.tag === 'vdef'
					&& g.out(t).some(([d, types]) => types & EDGE.definedBy && d === f)).map(([t]) => ({ t, n: name(t) })))
				.filter(d => d.n && d.n.text === n.text && place(d.n.line, d.n.col)) : [];
			const def = pick(same) ?? (v.tag === 'use' ? pick(read) : pick(called));
			// else one in a file of mrsource, which the document does not show
			const inFile = def ? undefined : fileDefinition(g, id, v, n, name, sourced);
			if(def) {
				const k = v.tag === 'fcall' ? 'fun' : kind(def.t);
				set(n, at => `\\mrFlowRef{${at}}{${k}}{${place(def.n.line, def.n.col)}}`);
			} else if(inFile) {
				set(n, at => `\\mrFlowFile{${at}}{${v.tag === 'fcall' ? 'fun' : kind(inFile)}}`);
			} else if(v.tag === 'use' && /^\s*=(?!=)/.test(source(n.line)?.slice(n.end) ?? '')) {
				set(n, at => `\\mrFlowArg{${at}}`);
			} else {
				set(n, at => `\\mrFlowExt{${at}}`);
			}
		}
	}
	return [...facts.values()];
}

/** the definition (vertex) in the sourced lines that a use reads or a call calls, of its name first */
function fileDefinition(g, id, v, n, name, sourced) {
	const inFile = t => {
		const d = name(t);
		return d && sourced(d.line) ? { t, d } : undefined;
	};
	const reads = g.out(id).filter(([t, types]) => types & EDGE.reads && g.vertices.get(t)?.tag === 'vdef').map(([t]) => inFile(t)).filter(Boolean);
	const calls = v.tag !== 'fcall' ? [] : g.out(id).filter(([t, types]) => types & EDGE.calls && g.vertices.get(t)?.tag === 'fdef')
		.flatMap(([f]) => [...g.vertices].filter(([t, w]) => w.tag === 'vdef' && g.out(t).some(([d, types]) => types & EDGE.definedBy && d === f)).map(([t]) => inFile(t)))
		.filter(Boolean);
	const all = [...reads, ...calls];
	return (all.find(x => x.d.text === n.text) ?? (v.tag === 'use' ? reads[0] : undefined))?.t;
}

export const DEPENDENCY_KINDS = ['read', 'write', 'source', 'visualize', 'test', 'remote', 'statistics'];
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
	const deps = dependenciesOf(answer), ids = answer?.['location-map']?.map?.ids ?? {};
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
	const layer = new Map(), aboveOf = new Map();
	for(const e of live) {
		const id = up ? e.to : e.from;
		aboveOf.set(id, [...aboveOf.get(id) ?? [], e]);
	}
	const depthOf = id => {
		if(!layer.has(id)) {
			layer.set(id, 0);
			const above = (aboveOf.get(id) ?? []).filter(e => !back.has(up ? `${e.from}>${e.to}` : `${e.to}>${e.from}`))
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
			const id = `~${i}.${d}`, pos = (byId.get(e.from).pos + byId.get(e.to).pos) / 2;
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
	const rows = Array.from({ length: depth + 1 }, () => []);
	[...byPos, ...points].forEach(n => rows[layer.get(n.id)].push(n));
	// stadiums and hexagons need room for their round and pointed ends
	const width = n => n.point ? 0.1 : ({ use: 0.1, value: 0.2, fcall: 0.08, entry: 0.2, exit: 0.2, branch: 0.25, cgmain: 0.2, cgbuiltin: 0.1 }[n.kind] ?? 0)
		+ Math.max(0.45, Math.max(...n.label.map(l => l.length)) * char + 0.26
		+ (n.note === undefined ? 0 : String(n.note).length * 0.09 + 0.08) + (n.line === undefined ? 0 : String(n.line).length * 0.09 + 0.22),
		(n.builtin ?? '').length * 0.09 + 0.3);
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
		const pre = [0];
		ws.forEach((w, i) => pre.push(pre[i] + w));
		const span = (i, j) => ws[i] / 2 + ws[j] / 2 + gap * (j - i) + pre[j] - pre[i + 1];
		const place = new Array(row.length);
		// the bounds the placed nodes set, max(place[j] + span(j, i)) left and min(place[j] - span(i, j))
		// right, in two Fenwick trees: rows of long graphs have thousands of points
		const n = row.length, left = new Array(n + 1).fill(-Infinity), right = new Array(n + 1).fill(Infinity);
		const mark = (i, at) => {
			for(let k = i + 1; k <= n; k += k & -k) {
				left[k] = Math.max(left[k], at + ws[i] / 2 - gap * i - pre[i + 1]);
			}
			for(let k = n - i; k <= n; k += k & -k) {
				right[k] = Math.min(right[k], at - ws[i] / 2 - gap * i - pre[i]);
			}
		};
		const bounds = i => {
			let l = -Infinity, r = Infinity;
			for(let k = i; k > 0; k -= k & -k) {
				l = Math.max(l, left[k]);
			}
			for(let k = n - i - 1; k > 0; k -= k & -k) {
				r = Math.min(r, right[k]);
			}
			return [l + ws[i] / 2 + gap * i + pre[i], r - ws[i] / 2 + gap * i + pre[i + 1]];
		};
		// nodes before the lanes of long edges, nodes with a wish before the others, then in the order of the code
		const order = [...row.keys()].sort((i, j) => !!row[i].point - !!row[j].point
			|| (want[i] === undefined) - (want[j] === undefined) || row[i].pos - row[j].pos);
		for(const i of order) {
			const [lo, hi] = bounds(i);
			const d = want[i] ?? (lo > -Infinity ? lo : hi < Infinity ? hi : 0);
			place[i] = lo > hi ? lo : Math.min(Math.max(d, lo), hi);
			mark(i, place[i]);
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
	// each row sorted by place, so a check sees only the nodes in reach
	const reachOf = new Map([...byPos, ...points].map(n => [n.id, width(n) / 2 + (n.point ? 0.14 : 0.16)]));
	const reach = rows.map(row => Math.max(0, ...row.map(n => reachOf.get(n.id))));
	const sorted = rows.map(row => row.map(n => n.id).sort((p, q) => x.get(p) - x.get(q)));
	const firstFrom = (ids, v) => {
		let lo = 0, hi = ids.length;
		while(lo < hi) {
			const mid = (lo + hi) >> 1;
			x.get(ids[mid]) < v ? lo = mid + 1 : hi = mid;
		}
		return lo;
	};
	const busy = (d, px, self) => {
		const ids = sorted[d];
		for(let k = firstFrom(ids, px - reach[d]); k < ids.length && x.get(ids[k]) <= px + reach[d]; k++) {
			if(!self.has(ids[k]) && Math.abs(x.get(ids[k]) - px) < reachOf.get(ids[k])) {
				return true;
			}
		}
		return false;
	};
	const move = (id, to) => {
		const ids = sorted[layer.get(id)];
		ids.splice(ids.indexOf(id), 1);
		x.set(id, to);
		ids.splice(firstFrom(ids, to), 0, id);
	};
	for(const [e, lane] of lanes) {
		const own = new Set(lane);
		const base = [x.get(e.from), x.get(e.to), ...lane.map(id => x.get(id))];
		const cost = c => lane.reduce((p, id) => p + Math.abs(x.get(id) - c), 0);
		const cands = [...new Set([...base, ...base.flatMap(b => [1, -1, 2, -2, 3, -3].map(k => b + k * 0.15))])];
		const fine = c => lane.every(id => !busy(layer.get(id), c, own));
		// the place of the source or the target first, else the one that moves the lane least
		const costs = new Map(cands.map(c => [c, cost(c)]));
		const best = [base[0], base[1]].find(fine) ?? cands.sort((p, q) => costs.get(p) - costs.get(q)).find(fine);
		if(best !== undefined) {
			lane.forEach(id => move(id, best));
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
/** with the key lines: the line of the code of each node (its position: line * 1000 + column), not of
 * the ends, of R's functions, or of the top level */
function withLines(nodes, opts) {
	if(opts.lines) {
		nodes.filter(n => n.kind !== 'exit' && n.pos >= 1000 && n.pos < 1e9).forEach(n => n.line = Math.floor(n.pos / 1000));
	}
	return nodes;
}
export function graphText(name, nodes, edges) {
	const ns = nodes.map(n => `\\mrGraphNode${n.w ? `[${num(n.w)}]` : ''}{${n.id}}{${num(n.x)}}{${num(n.y)}}{${n.kind}}{${n.label.map(l => texText(l)).join('\\\\')}${
		n.note === undefined ? '' : `\\mrGraphId{${texText(n.note)}}`}${n.line === undefined ? '' : `\\mrGraphLine{${n.line}}`}${n.builtin ? `\\mrGraphBuiltin{${texText(n.builtin)}}` : ''}}`);
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

export const LEGEND_NAMES = { cgmain: 'top level', cgfun: 'function', cgbuiltin: 'R fn', vdef: 'definition', fdef: 'function', use: 'use', value: 'value', fcall: 'call', entry: 'entry',
	block: 'block', branch: 'condition', exit: 'exit', reads: 'reads', definedBy: 'defined by', calls: 'calls',
	returns: 'returns', argument: 'argument', flow: 'flow', cond: 'branch (T, F)', back: 'loop', body: 'body', dead: 'unreachable', unreach: 'after a return', cgcall: 'calls', forces: 'forces' };
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
	const placed = layout(withLines(nodes, opts), edges, opts);
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
				edges.push({ from: caller, to: t, kind: 'cgcall' });
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
	return graphText(name, layout(withLines(shown, opts), shownEdges, { ...opts, up: true }), shownEdges);
}

/** a line of R without its comment ('#' outside of strings) */
export function withoutComment(line) {
	let quote = null;
	for(let i = 0; i < line.length; i++) {
		const c = line[i];
		if(quote) {
			if(c === '\\') {
				i++;
			} else if(c === quote) {
				quote = null;
			}
		} else if(c === '"' || c === '\'' || c === '`') {
			quote = c;
		} else if(c === '#') {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

/** the arguments of a call (the text between its parentheses), split at its commas of the top level */
function splitArgs(text) {
	const out = [];
	let depth = 0, quote = null, cur = '';
	for(let i = 0; i < text.length; i++) {
		const c = text[i];
		if(quote) {
			if(c === '\\') {
				cur += c + (text[++i] ?? '');
				continue;
			}
			if(c === quote) {
				quote = null;
			}
		} else if(c === '"' || c === '\'') {
			quote = c;
		} else if('([{'.includes(c)) {
			depth++;
		} else if(')]}'.includes(c)) {
			depth--;
		} else if(c === ',' && depth === 0) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	return cur.trim() || out.length ? [...out, cur] : out;
}

/** the column (1-based) of the parenthesis that closes the one at column `col`, else undefined */
function closing(line, col) {
	let depth = 0, quote = null;
	for(let i = col - 1; i < line.length; i++) {
		const c = line[i];
		if(quote) {
			if(c === '\\') {
				i++;
			} else if(c === quote) {
				quote = null;
			}
		} else if(c === '"' || c === '\'') {
			quote = c;
		} else if(c === '(') {
			depth++;
		} else if(c === ')' && --depth === 0) {
			return i + 1;
		}
	}
	return undefined;
}

/**
 * The control flow graph of an answer in basic blocks, each labeled with its code. flowR gives the
 * body of a function a graph of its own; a block with a call gets an edge to the body of the function
 * it calls (flowR names the definition a call targets, and the definition its body).
 */
export function controlFlowGraph(name, answer, lines, opts = {}) {
	const cf = answer?.['control-flow']?.controlFlow, ids = answer?.['location-map']?.map?.ids ?? {};
	if(!cf?.graph) {
		return undefined;
	}
	const entry = new Set((cf.entryPoints ?? []).map(String)), exit = new Set((cf.exitPoints ?? []).map(String));
	// the block of an element, the body of a function definition, the definitions a call targets
	const blockOf = new Map((cf.graph.bbChildren ?? []).map(([e, b]) => [String(e), String(b)]));
	const bodyOf = new Map(), callsOf = new Map(), callsAt = new Map(), callName = new Map(), edges = [];
	for(const [id, info] of cf.graph.vtxInfos) {
		for(const e of Array.isArray(info[2]) ? info[2] : []) {
			if(Array.isArray(e[2]) && e[2].length) {
				bodyOf.set(String(e[1]), String(e[2][0]));
			}
			if(Array.isArray(e[3]) && e[3].length) {
				callsOf.set(String(id), [...callsOf.get(String(id)) ?? [], ...e[3].map(String)]);
				callsAt.set(String(e[1]), e[3].map(String));
			}
			// the name of an element: the code at its place ('return')
			const l = ids[String(e[1])]?.[1];
			if(Array.isArray(l) && l[0] === l[2]) {
				callName.set(String(e[1]), (lines[l[0] - 1] ?? '').slice(l[1] - 1, l[3]));
			}
		}
	}
	// the parameters of a function stand in its first line, between the parentheses after 'function'
	const params = [];
	for(const f of bodyOf.keys()) {
		const l = ids[f]?.[1], line = Array.isArray(l) ? lines[l[0] - 1] ?? '' : '';
		const open = Array.isArray(l) ? line.indexOf('(', l[3]) + 1 : 0, close = open ? closing(line, open) : undefined;
		if(close) {
			params.push([l[0], open, close]);
		}
	}
	const isParam = l => params.some(([row, from, to]) => l[0] === row && l[2] === row && l[1] > from && l[3] < to);
	// the statements of a block, one node each (a line, or the part of a line a block spans): the
	// first one takes the edges into the block, the last one those out of it
	const nodes = [], first = new Map(), last = new Map(), nodeOfElem = new Map(), rowsOf = new Map(), rowNode = new Map();
	// the node of an element: its own, else the one of its line in its block ('function' is no code there)
	const nodeOf = e => nodeOfElem.get(e) ?? rowNode.get(`${blockOf.get(e)}:${ids[e]?.[1]?.[0]}`);
	// a line without its comment, a definition without the brace that opens its body
	const text = r => withoutComment(lines[r - 1] ?? '').trim().replace(/\s*\{$/, '');
	const sliceOf = (row, locs) => {
		const c1 = Math.min(...locs.map(l => l[1])), line = lines[row - 1] ?? '';
		let c2 = Math.max(...locs.map(l => l[3]));
		// a call is located at its name, so its arguments and closing parentheses come along
		if(line[c2] === '(') {
			c2 = closing(line, c2 + 1) ?? c2;
		}
		const open = t => (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
		while(open(line.slice(c1 - 1, c2)) > 0 && line[c2] === ')') {
			c2++;
		}
		return { text: withoutComment(line.slice(c1 - 1, c2)).trim().replace(/\s*\{$/, ''), c1, c2 };
	};
	for(const [id, info] of cf.graph.vtxInfos) {
		// markers ('12-exit') stand where their compound starts, they are no code of the block
		const elems = (Array.isArray(info[2]) ? info[2].map(e => String(e[1])) : [String(id)]).filter(e => !/-exit$/.test(e));
		const located = elems.map(e => [e, ids[e]?.[1]]).filter(([, l]) => Array.isArray(l));
		// the parameters belong to the definition, not to the code of the body
		let code = located.filter(([, l]) => !isParam(l));
		code = code.length ? code : located;
		// a loop or condition stands for its end in the block after it: its keyword is no code there
		const words = code.filter(([, l]) => !/^(for|while|repeat|if|function)$/.test(lines[l[0] - 1]?.slice(l[1] - 1, l[3]) ?? ''));
		code = words.length ? words : code;
		if(!code.length) {
			continue;
		}
		// the lines of its elements, compound ones ('for', 'if') only if there is nothing else
		const single = code.filter(([, l]) => l[0] === l[2]);
		const rows = [...new Set((single.length ? single : code).map(([, l]) => l[0]))].sort((x, y) => x - y);
		rowsOf.set(String(id), rows);
		const raw = String(id), base = `b${raw.replace(/[^\w]/g, '')}`;
		rows.forEach((row, k) => {
			const here = code.filter(([, l]) => l[0] === row);
			const all = here.length && here.every(([, l]) => l[0] === l[2]);
			const nid = k === 0 ? base : `${base}s${k}`;
			const cut = rows.length === 1 && all ? sliceOf(row, here.map(([, l]) => l)) : undefined;
			nodes.push({ id: nid, raw, kind: k === 0 && entry.has(raw) ? 'entry' : 'block', row, ...cut ? { c1: cut.c1, c2: cut.c2 } : {},
				label: [shorten(cut ? cut.text : text(row), 32)],
				pos: row * 1000 + Math.min(...(here.length ? here : code).map(([, l]) => l[1])) });
			here.forEach(([e]) => nodeOfElem.set(e, nid));
			rowNode.set(`${raw}:${row}`, nid);
			if(k > 0) {
				edges.push({ from: k === 1 ? base : `${base}s${k - 1}`, to: nid, kind: 'flow', label: '' });
			}
		});
		first.set(raw, base);
		last.set(raw, rows.length > 1 ? `${base}s${rows.length - 1}` : base);
	}
	const byRaw = first;
	for(const [from, es] of cf.graph.edgeInfos) {
		for(const [to, e] of es) {
			if(last.has(String(from)) && first.has(String(to))) {
				edges.push({ from: last.get(String(from)), to: first.get(String(to)), kind: e?.when === undefined ? 'flow' : 'cond',
					label: e?.when === undefined ? '' : e.when ? 'T' : 'F' });
			}
		}
	}
	const bodyBlock = f => {
		const body = bodyOf.get(f);
		return body && (blockOf.get(body) ?? body);
	};
	// a call leads to the body of the function it calls, a definition to the body it defines
	for(const [block, targets] of callsOf) {
		for(const f of targets) {
			const to = byRaw.get(bodyBlock(f)), from = [...nodeOfElem].find(([e]) => blockOf.get(e) === block && (callsAt.get(e) ?? []).includes(f))?.[1] ?? last.get(block);
			if(to && from && !edges.some(e => e.from === from && e.to === to && e.kind === 'calls')) {
				edges.push({ from, to, kind: 'calls', label: '' });
			}
		}
	}
	for(const f of bodyOf.keys()) {
		const from = nodeOf(f), to = byRaw.get(bodyBlock(f));
		if(from && to) {
			edges.push({ from, to, kind: 'body', label: '' });
		}
	}
	// the blocks of a function: those its body reaches, and the others within its lines (flowR leaves
	// code it deems unreachable without edges); its exit follows the blocks where its body ends, a
	// return() with an edge of its own
	const next = new Map();
	for(const [from, es] of cf.graph.edgeInfos) {
		next.set(String(from), [...next.get(String(from)) ?? [], ...es.map(([to]) => String(to))]);
	}
	const owner = new Map(), spans = [];
	for(const f of bodyOf.keys()) {
		const row = ids[f]?.[1]?.[0], root = bodyBlock(f);
		if(!root || row === undefined || !first.has(root)) {
			continue;
		}
		const todo = [root], seen = new Set();
		while(todo.length) {
			const b = todo.pop();
			if(!seen.has(b) && first.has(b)) {
				seen.add(b);
				todo.push(...next.get(b) ?? []);
			}
		}
		// the lines of the definition: up to the next statement of the code around it
		const outer = blockOf.get(f), after = (rowsOf.get(outer) ?? []).filter(r => r > row);
		const end = after.length ? Math.min(...after) - 1 : lines.length;
		spans.push({ f, row, end, seen });
	}
	spans.sort((x, y) => (x.end - x.row) - (y.end - y.row));
	for(const raw of first.keys()) {
		const rows = rowsOf.get(raw) ?? [];
		const span = spans.find(sp => sp.seen.has(raw)) ?? spans.find(sp => rows.length && rows.every(r => r > sp.row && r <= sp.end));
		if(span) {
			owner.set(raw, span);
		}
	}
	const returns = raw => [...nodeOfElem].some(([e]) => blockOf.get(e) === raw && /^return$/.test(String(callName.get(e) ?? '')));
	const ends = raw => !(next.get(raw) ?? []).some(t => first.has(t));
	for(const sp of spans) {
		const name = /^\s*([\w.]+)\s*(<<?-|=)/.exec(lines[sp.row - 1] ?? '')?.[1];
		const xid = `x${String(sp.f).replace(/[^\w]/g, '')}`;
		nodes.push({ id: xid, raw: xid, kind: 'exit', label: [name ? `end of ${name}` : 'end'], pos: sp.end * 1000 + 999 });
		for(const raw of first.keys()) {
			if(owner.get(raw) === sp && (ends(raw) || returns(raw))) {
				edges.push({ from: last.get(raw), to: xid, kind: returns(raw) ? 'returns' : 'flow', label: '' });
			}
		}
	}
	// the end of the code outside of the functions
	const top = [...first.keys()].filter(raw => !owner.has(raw) && (exit.has(raw) || ends(raw)));
	if(top.length) {
		nodes.push({ id: 'xmain', raw: 'xmain', kind: 'exit', label: ['end'], pos: lines.length * 1000 + 999 });
		top.forEach(raw => edges.push({ from: last.get(raw), to: 'xmain', kind: 'flow', label: '' }));
	}
	// the parameters of a function definition (element f): their names, in order
	const paramsOf = f => {
		const l = ids[f]?.[1], line = Array.isArray(l) ? lines[l[0] - 1] ?? '' : '';
		const open = Array.isArray(l) ? line.indexOf('(', l[3]) + 1 : 0, close = open ? closing(line, open) : undefined;
		return close ? splitArgs(line.slice(open, close - 1)).map(p => p.replace(/=.*$/s, '').trim()) : [];
	};
	// the node where the function a call calls first uses the parameter its argument binds
	const forcingNode = (call, arg) => {
		const line = lines[call.row - 1] ?? '', open = line.indexOf('(', call.c1 - 1) + 1, close = closing(line, open);
		if(!open || !close) {
			return undefined;
		}
		// the argument's place among the arguments, or its name ('g(a = return(x))')
		const args = splitArgs(line.slice(open, close - 1));
		let at = open, index = -1, named;
		args.forEach((a, i) => {
			const from = at, to = at + a.length;
			if(arg.c1 - 1 >= from && arg.c1 - 1 <= to) {
				index = i;
				named = /^\s*([\w.]+)\s*=(?!=)/.exec(a)?.[1];
			}
			at = to + 1;
		});
		for(const [e, nid] of nodeOfElem) {
			if(nid !== call.id) {
				continue;
			}
			for(const f of callsAt.get(e) ?? []) {
				const params = paramsOf(f), param = named ?? params[index];
				if(!param) {
					continue;
				}
				const use = new RegExp(`(^|[^\\w.])${param.replace(/[.]/g, '\\.')}([^\\w.]|$)`);
				const sp = spans.find(x => x.f === f);
				const node = nodes.filter(n => n.row !== undefined && sp && owner.get(n.raw) === sp && n.row > sp.row && use.test(n.label[0]))
					.sort((a, b) => a.pos - b.pos)[0];
				if(node) {
					return node.id;
				}
			}
		}
		return undefined;
	};
	// flowR computes an argument before its call; R calls first, and the argument when the callee
	// needs it ('g(return(x))'): what leads into the argument leads into the call, which goes on into it
	const byId = new Map(nodes.map(n => [n.id, n]));
	for(const arg of nodes) {
		const call = nodes.find(c => c !== arg && c.row === arg.row && c.c1 !== undefined && arg.c1 !== undefined
			&& c.c1 < arg.c1 && arg.c2 <= c.c2 && /^[\w.]+\s*\(/.test(c.label[0]));
		if(!call) {
			continue;
		}
		for(const e of edges) {
			if(e.to === arg.id && e.from !== call.id) {
				e.to = call.id;
			}
		}
		// the call ends where its argument ends (returns), not on its own
		for(let i = edges.length - 1; i >= 0; i--) {
			if(edges[i].from === call.id && byId.get(edges[i].to)?.kind === 'exit') {
				edges.splice(i, 1);
			}
		}
		// the callee computes the argument where it first uses its parameter: an edge forces it there
		const forced = forcingNode(call, arg);
		edges.push(forced ? { from: forced, to: arg.id, kind: 'forces', label: '' } : { from: call.id, to: arg.id, kind: 'flow', label: '' });
	}
	// code of a function that flowR never reaches (after a return), dimmed, after the statement before it
	const covered = new Set(nodes.filter(n => n.row !== undefined).map(n => n.row));
	for(const sp of spans) {
		for(let row = sp.row + 1; row <= sp.end; row++) {
			const code = text(row);
			if(covered.has(row) || !code || /^[{}()\s]*$/.test(code)) {
				continue;
			}
			const before = nodes.filter(n => n.row !== undefined && n.row < row && n.row > sp.row && owner.get(n.raw) === sp)
				.sort((a, b) => b.pos - a.pos)[0];
			const id = `u${row}`;
			nodes.push({ id, raw: id, kind: 'dead', label: [shorten(code, 32)], row, pos: row * 1000 });
			covered.add(row);
			if(before) {
				edges.push({ from: before.id, to: id, kind: 'unreach', label: '' });
			}
		}
	}
	// a block that decides (with edges for true and false) is a condition
	for(const n of nodes) {
		if(n.kind === 'block' && edges.some(e => e.from === n.id && e.kind === 'cond')) {
			n.kind = 'branch';
		}
	}
	const placed = layout(withLines(nodes, opts), edges, { ...opts, up: true });
	const at = new Map(placed.map(n => [n.id, n]));
	// an edge that goes back up (a loop) runs right of every block between its ends, one lane per loop
	let lane = 0;
	const routed = edges.map(e => {
		const from = at.get(e.from), to = at.get(e.to);
		if(!from || !to || to.layer > from.layer) {
			return e;
		}
		// beside the blocks between its ends in their column: right of them if no block of another column
		// is in the way there, else left of them if none is there, else right of all blocks between
		const between = placed.filter(n => n.y <= Math.max(from.y, to.y) + 0.01 && n.y >= Math.min(from.y, to.y) - 0.01);
		const lo = Math.min(from.x, to.x) - 0.01, hi = Math.max(from.x, to.x) + 0.01;
		const column = between.filter(n => n.x >= lo - 1.5 && n.x <= hi);
		// the points where other edges run beside the blocks, between the ends
		const others = [...placed.lanes?.values() ?? []].flat()
			.filter(([, y]) => y <= Math.max(from.y, to.y) + 0.01 && y >= Math.min(from.y, to.y) - 0.01).map(([px]) => px);
		const free = x => !between.some(n => n.x - n.w / 2 - 0.15 < x && x < n.x + n.w / 2 + 0.15)
			&& !others.some(px => Math.abs(px - x) < 0.15);
		const nearRight = Math.max(...column.map(n => n.x + n.w / 2), ...others.filter(px => px > lo)) + 0.25 + 0.18 * lane;
		const nearLeft = Math.min(...column.map(n => n.x - n.w / 2), ...others.filter(px => px < hi)) - 0.25 - 0.18 * lane;
		const left = !free(nearRight) && free(nearLeft);
		const x = free(nearRight) ? nearRight : left ? nearLeft : Math.max(...between.map(n => n.x + n.w / 2)) + 0.25 + 0.18 * lane;
		lane++;
		// it leaves and enters at its side, or below and above where a block is beside its end there
		const beside = n => placed.some(m => m !== n && Math.abs(m.y - n.y) < 0.01 && (left ? m.x < n.x : m.x > n.x));
		const below = from.y - from.h / 2 - 0.2, above = to.y + to.h / 2 + 0.2, anchor = left ? 'west' : 'east';
		const back = { ...e, kind: 'back',
			start: beside(from) ? `(mr-${e.from}.south)` : `(mr-${e.from}.${anchor})`,
			end: beside(to) ? `(mr-${e.to}.north)` : `(mr-${e.to}.${anchor})` };
		placed.lanes ??= new Map();
		placed.lanes.set(back, [
			...beside(from) ? [[from.x, below], [x, below]] : [[x, from.y]],
			...beside(to) ? [[x, above], [to.x, above]] : [[x, to.y]]
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
 * criteria '5@x', findings 'lint:rule'), the cursor ('3:5'), and other files ({ name, lines }, 2.16)
 */
export function playgroundHash(lines, marks = [], at, files = []) {
	const enc = s => s.replace(/[^A-Za-z0-9\-._~!$'()*,;:@/?=]/gu, c => encodeURIComponent(c));
	const text = ls => ls.slice(0, ls.findLastIndex(l => l.trim()) + 1).join('\n');
	const pack = t => `t${Buffer.from(t).toString('base64url')}`;
	return [`c=${pack(text(lines))}`, files.length ? `o=${pack(JSON.stringify(files.map(f => [f.name, text(f.lines)])))}` : '',
		marks.length ? `h=${enc(marks.join(','))}` : '', at ? `p=${at}` : ''].filter(Boolean).join('&');
}

/**
 * The lines of a side file of magic-r that a request names: all of the file, or with `part` the lines
 * after '## magic-r part <part>' up to the next such line. undefined without the file or the part.
 */
export function sideLines(r) {
	if(typeof r.file !== 'string' || !/^[\w.-]+$/.test(r.file) || !fs.existsSync(r.file)) {
		return undefined;
	}
	const lines = fs.readFileSync(r.file, 'utf8').replace(/\n$/, '').split('\n');
	if(r.part === undefined) {
		return lines;
	}
	const start = lines.indexOf(`## magic-r part ${r.part}`);
	if(start < 0) {
		return undefined;
	}
	const end = lines.findIndex((l, i) => i > start && /^## magic-r part /.test(l));
	return lines.slice(start + 1, end < 0 ? lines.length : end);
}

// the characters of flowR's output as ASCII, as listings reads no other ('╰' of a tree, '≈' of a time)
const ASCII = { '╰': '+', '╭': '+', '├': '+', '└': '+', '┌': '+', '┐': '+', '┘': '+', '─': '-', '━': '-', '│': '|',
	'≈': '~', '…': '...', '→': '->', '←': '<-', '✓': 'ok', '✗': 'x', '×': 'x', '•': '*', '·': '.', '“': '"', '”': '"', '‘': "'", '’': "'" };
export function ascii(line) {
	return [...line].map(c => c.charCodeAt(0) < 128 ? c : ASCII[c] ?? (/\s/u.test(c) ? ' ' : '?')).join('');
}

/**
 * The sessions of flowR's REPL (\begin{flowrsession}): each input (a command, ':dataflow* x', or R,
 * which runs as ':execute') with what flowR prints for it. The inputs run in one REPL, apart by an
 * unknown command (':mrstep<k>'), whose message marks where the answer of input k starts:
 * \mrFlowrSession{name}{inputs} and \mrFlowrSessionLine{name}{input}{line in hex} (any character).
 */
export function sessionTexts(repl, requests, dir) {
	const out = [];
	for(const r of requests.filter(r => r.kind === 'session' && /^[\w.:-]+$/.test(String(r.name)) && Array.isArray(r.inputs))) {
		const inputs = r.inputs.map(String).filter(l => l.trim());
		const cmds = inputs.flatMap((l, k) => [`:mrstep${k}`, l.trim().startsWith(':') ? l.trim() : `:execute ${l.trim()}`]);
		let text;
		try {
			text = repl.raw(cmds, dir, r.rcode === true);
		} catch(e) {
			out.push(`\\mrFlowrSessionFailed{${r.name}}{${texMessage(e.message)}}`);
			continue;
		}
		const steps = inputs.map(() => []);
		let k = -1;
		// no colors, and no note that a link went to the clipboard
		for(const line of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n')) {
			const m = /^the command 'mrstep(\d+)[^']*' is unknown/.exec(line);
			if(m) {
				k = Number(m[1]);
			} else if(k >= 0 && k < steps.length && !/^Copied .* to clipboard/.test(line)) {
				steps[k].push(line.replace(/\s+$/, ''));
			}
		}
		const trim = lines => {
			let a = 0, b = lines.length;
			while(a < b && !lines[a].trim()) {
				a++;
			}
			while(b > a && !lines[b - 1].trim()) {
				b--;
			}
			return lines.slice(a, b);
		};
		out.push(`\\mrFlowrSession{${r.name}}{${steps.length}}`, ...steps.flatMap((lines, i) =>
			trim(lines).map(l => `\\mrFlowrSessionLine{${r.name}}{${i + 1}}{${Buffer.from(ascii(l), 'utf8').toString('hex')}}`)));
	}
	return out;
}

/** the lines of the code of the key mrprefix: its statements, split at each ';' outside strings and brackets */
export function prefixLines(prefix) {
	const text = String(prefix ?? '').replace(/\\([%#&_$])/g, '$1');
	const out = [];
	let cur = '', depth = 0, quote = null;
	for(let i = 0; i < text.length; i++) {
		const ch = text[i];
		if(quote) {
			cur += ch;
			if(ch === '\\' && i + 1 < text.length) {
				cur += text[++i];
			} else if(ch === quote) {
				quote = null;
			}
		} else if(ch === ';' && depth === 0) {
			out.push(cur);
			cur = '';
		} else {
			if(ch === '"' || ch === "'" || ch === '`') {
				quote = ch;
			} else if('([{'.includes(ch)) {
				depth++;
			} else if(')]}'.includes(ch)) {
				depth = Math.max(0, depth - 1);
			}
			cur += ch;
		}
	}
	out.push(cur);
	return out.map(l => l.trim()).filter(l => l !== '');
}

/** the links of the listings that ask for one (no flowR needed): \mrFlowrPlayground{name}{hash} */
export function playgroundTexts(code) {
	const { blocks, requests } = parseCode(code);
	return requests.filter(r => r.kind === 'playground' && /^[\w.:-]+$/.test(String(r.name))).flatMap(r => {
		// the code with its indentation, which magic-r writes to a file of its own, else as flowR gets it
		const b = blockOf(blocks, r.block);
		const lines = sideLines(r) ?? b?.lines;
		const marks = [].concat(r.marks ?? []).map(c => criterion(c, lines ?? [])).filter(c => /^\d+(:\d+|@.+)?$/.test(c));
		if(!lines) {
			return [];
		}
		// the packages the listing attaches without showing it (key mrlibrary) come first, the marks move down
		const libs = [].concat(r.library ?? []).map(String).filter(p => /^[A-Za-z][A-Za-z0-9.]*$/.test(p))
			.filter(p => !lines.some(l => new RegExp(`\\b(library|require)\\(\\s*["']?${p.replace(/\./g, '\\.')}["']?\\s*[,)]`).test(l)));
		// files of mrsource and listings of mrinclude ('<name>.R') are files of their own, run first;
		// mrprefix comes before the listing
		const files = [];
		const add = (name, ls) => {
			if(files.some(f => f.name === name && f.lines.join('\n') === ls.join('\n'))) {
				return;
			}
			let unique = name;
			for(let k = 2; files.some(f => f.name === unique); k++) {
				unique = name.replace(/(\.[^.]*)?$/, `-${k}$1`);
			}
			files.push({ name: unique, lines: ls });
		};
		const sources = x => (x?.sources ?? []).forEach(f => add(String(f.name), f.lines));
		sources(b);
		for(const n of [].concat(r.include ?? []).map(String)) {
			const inc = blockOf(blocks, n);
			if(inc) {
				sources(inc);
				add(`${n}.R`, sideLines({ file: r.file, part: inc.id }) ?? inc.lines);
			}
		}
		const pre = [...libs.map(p => `library(${p})`), ...prefixLines(r.prefix)];
		const shifted = marks.map(c => c.replace(/^\d+/, n => String(Number(n) + pre.length)));
		// the cursor on the first criterion: the page opens on its slice
		const at = shifted.map(c => place(c, [...pre, ...lines])).find(Boolean);
		return [`\\mrFlowrPlayground{${r.name}}{${playgroundHash([...pre, ...lines], shifted, at?.join(':'), files)}}`];
	});
}

const REQUESTS = {
	dataflow:       (r, flowr) => [dataflowQuery(flowr), { type: 'location-map' }],
	'call-graph':   () => [{ type: 'call-graph' }, { type: 'location-map' }],
	// a link to the graph on mermaid.live, as flowR's REPL gives it
	mermaid:        r => ({ 'call-graph': ':query [{"type":"call-graph"}]', 'control-flow': ':controlflowbb*' }[r.graph] ?? ':dataflow*'),
	'control-flow': () => [{ type: 'control-flow', config: { simplificationPasses: ['unique-cf-sets', 'to-basic-blocks'] } }, { type: 'location-map' }],
	slice:          r => [{ type: 'static-slice', criteria: [].concat(r.criterion ?? []).map(c => String(c).trim()), noReconstruction: true }, { type: 'location-map' }],
	query:          r => Array.isArray(r.query) ? r.query : [r.query],
	lint:           r => [{ type: 'linter', ...Array.isArray(r.rules) && r.rules.length ? { rules: r.rules } : {} }],
	arrows:         (r, flowr) => [dataflowQuery(flowr), { type: 'location-map' }]
};

/**
 * The arrows of a block: from the name each criterion points at to every definition it reads, or with
 * all, from every use of a variable. Arrows of one variable (one criterion without all) form a group:
 * \mrFlowArrow{block}{line}{column}{line}{column}{group}{tracks and lane} from the use to the definition,
 * and \mrFlowArrowCriterion{block}{line}{column}{group} for a name a criterion points at. With all,
 * the groups are apart (each can be shown alone), so each gets tracks and lanes of its own.
 * The criteria of `calls` point at calls (or at the name of a function, for all of its calls; 'all'
 * takes every call): \mrFlowCallArrow from a call to the definition of the function it calls.
 * `route` 'auto' (the default) lets an arrow to a definition above run over the top where it can
 * (arrowTracks), 'side' keeps every arrow beside the code.
 */
export function arrowTexts(block, answer, lines, criteria = [], all = false, calls = [], route = 'auto', indent = []) {
	const g = graphOf(answer);
	if(!g) {
		return [];
	}
	const at = id => g.name(id, l => lines[l - 1]) || undefined;
	const vertexAt = new Map([...g.vertices.keys()].map(v => [at(v) && `${at(v).line}:${at(v).col}`, v]));
	const groups = new Map(), arrows = [], seen = new Set(), marks = [];
	const group = key => groups.get(key) ?? groups.set(key, groups.size + 1).get(key);
	const push = (u, d, k, call) => {
		if(d && !seen.has(`${u.line}:${u.col}>${d.line}:${d.col}`)) {
			seen.add(`${u.line}:${u.col}>${d.line}:${d.col}`);
			arrows.push({ lu: u.line, cu: u.col, nu: u.text.length, ld: d.line, cd: d.col, nd: d.text.length, g: k, call });
		}
	};
	const from = (id, k) => {
		for(const [t, types] of g.out(id)) {
			if(types & EDGE.reads && g.vertices.get(t)?.tag === 'vdef') {
				push(at(id), at(t), k, false);
			}
		}
	};
	// the names a function is defined as ('f' of 'f <- function'): fdef -> the vdefs it defines
	const named = new Map();
	for(const [id, v] of g.vertices) {
		for(const [t, types] of v.tag === 'vdef' ? g.out(id) : []) {
			if(types & EDGE.definedBy && g.vertices.get(t)?.tag === 'fdef' && at(id)) {
				named.set(t, [...named.get(t) ?? [], id]);
			}
		}
	}
	const callees = id => g.out(id).filter(([t, types]) => types & EDGE.calls && named.has(t)).flatMap(([t]) => named.get(t));
	const fromCall = (id, k) => callees(id).forEach(d => push(at(id), at(d), k, true));
	const callsOf = def => [...g.vertices].filter(([id, v]) => v.tag === 'fcall' && at(id) && callees(id).includes(def)).map(([id]) => id);
	[].concat(criteria).forEach((c, i) => {
		const p = place(c, lines), id = p && vertexAt.get(p.join(':'));
		if(id !== undefined) {
			const k = group(all ? at(id).text : `criterion ${i}`);
			marks.push(`\\mrFlowArrowCriterion{${block}}{${p[0]}}{${p[1]}}{${k}}`);
			from(id, k);
		}
	});
	const allCalls = [].concat(calls).some(c => String(c).trim() === 'all');
	[].concat(calls).filter(c => String(c).trim() !== 'all').forEach((c, i) => {
		const p = place(c, lines), id = p && vertexAt.get(p.join(':'));
		if(id !== undefined) {
			const k = group(all ? at(id).text : `call ${i}`);
			marks.push(`\\mrFlowArrowCriterion{${block}}{${p[0]}}{${p[1]}}{${k}}`);
			if(g.vertices.get(id)?.tag === 'fcall') {
				fromCall(id, k);
			} else {
				callsOf(id).forEach(c2 => push(at(c2), at(id), k, true));
			}
		}
	});
	if(allCalls || all && [].concat(calls).length) {
		for(const [id, v] of g.vertices) {
			if(v.tag === 'fcall' && at(id) && callees(id).length) {
				const k = group(all ? at(id).text : `calls of ${at(callees(id)[0]).text}`);
				if(all) {
					marks.push(`\\mrFlowArrowName{${block}}{${at(id).line}}{${at(id).col}}{${k}}`);
				}
				fromCall(id, k);
			}
		}
	}
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
	// the routes need the columns as they are shown, with the indentation of the lines
	const ind = l => indent[l - 1] ?? 0, shown = lines.map((l, i) => ' '.repeat(ind(i + 1)) + l);
	arrows.forEach(a => Object.assign(a, { cu: a.cu + ind(a.lu), cd: a.cd + ind(a.ld) }));
	const placed = (all ? [...new Set(arrows.map(a => a.g))].flatMap(k => arrowTracks(arrows.filter(a => a.g === k), shown, route))
		: arrowTracks(arrows, shown, route)).map(a => Object.assign(a, { cu: a.cu - ind(a.lu), cd: a.cd - ind(a.ld) }));
	// the last argument: the lane, where the arrow ends and starts among those of its names, and the
	// column of the lanes right of the code ('lane/i/n/i/n/column')
	return [...placed.map(a => `\\mrFlow${a.call ? 'Call' : ''}Arrow{${block}}{${a.lu}}{${a.cu}}{${a.ld}}{${a.cd}}{${a.g}}{${a.ut}}{${a.dt}}{${a.lane}/${a.ei}/${a.en}/${a.si}/${a.sn}/${a.rc}}`), ...marks];
}

/**
 * Places the arrows of a listing so that none runs on another: an arrow runs below the line of its use
 * from its column to the left of the code (column 0), along a lane up or down, and below the line of its
 * definition to its column (one segment if both are in one line). Segments below one line that overlap
 * get tracks of their own (0 is closest to the line), vertical ones that overlap lanes of their own.
 * With `route` 'auto' (the default), an arrow to a definition above leaves its use at the top: straight up
 * from the middle of the use to below the line of the definition and into it (lane -2, track `ut` below
 * the line of the definition), else below the line above the use to the middle of the definition and
 * up into it (lane -1, track `ut` below the line above the use). Each only if no letter is in its way in
 * the lines between and no other arrow runs up there.
 */
export function arrowTracks(arrows, lines = [], route = 'auto') {
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
	// shorter first; of the same height, the arrows between the same lines one after another, so that
	// their lanes are next to each other and no other lane runs between them
	const span = a => a.lu === a.ld ? Math.abs(a.cu - a.cd)
		: 1e9 * Math.abs(a.lu - a.ld) + 1e6 * Math.min(a.lu, a.ld) + a.cu + a.cd;
	// the columns of the middle of a name: one, or the two around it for an even length
	const middle = (c, n) => n % 2 ? [c + (n - 1) / 2] : [c + n / 2 - 1, c + n / 2];
	const blank = (l, c) => !/\S/.test(lines[l - 1]?.[c - 1] ?? ' ');
	// the ways up: their column, lines, and the name they share it with (a use or a definition)
	const ups = [];
	// the columns of a name: a way up may leave or enter it anywhere, as ends spread over it
	const all = (c, n) => Array.from({ length: n }, (_, i) => c + i);
	const clear = (a, cols, key) => {
		for(let l = a.ld + 1; l < a.lu; l++) {
			if(!cols.every(c => blank(l, c))) {
				return false;
			}
		}
		return !ups.some(u => cols.includes(u.col) && u.lo <= a.lu - 1 && a.ld + 1 <= u.hi && u.key !== key);
	};
	const up = (a, cols, key, lane, line) => {
		const ends = [a.cu, a.cu + (a.nu ?? 1) - 1, a.cd, a.cd + (a.nd ?? 1) - 1];
		a.ut = free(row(line), Math.min(...ends), Math.max(...ends));
		a.dt = 0;
		a.lane = lane;
		ups.push(...cols.map(col => ({ col, key, lo: a.ld + 1, hi: a.lu - 1 })));
	};
	const right = [], flow = [];
	// the right lane starts after the longest line
	const rc = Math.max(0, ...lines.map(l => l.trimEnd().length));
	// the dataflow first, so that a call knows whether the left lane is free of it
	const order = [...arrows].sort((x, y) => span(x) - span(y));
	for(const a of [...order.filter(x => !x.call), ...order.filter(x => x.call)]) {
		const fromUse = all(a.cu, a.nu ?? 1), intoDef = all(a.cd, a.nd ?? 1);
		if(route === 'auto' && a.ld < a.lu && clear(a, fromUse, `u${a.lu}:${a.cu}`)) {
			up(a, fromUse, `u${a.lu}:${a.cu}`, -2, a.ld);
		} else if(route === 'auto' && a.ld < a.lu && clear(a, intoDef, `d${a.ld}:${a.cd}`)) {
			up(a, intoDef, `d${a.ld}:${a.cd}`, -1, a.lu - 1);
		} else if(a.lu === a.ld) {
			a.ut = a.dt = free(row(a.lu), Math.min(a.cu, a.cd), Math.max(a.cu, a.cd));
			a.lane = 0;
		} else if(a.call && (flow.some(f => f.lo <= Math.max(a.lu, a.ld) && Math.min(a.lu, a.ld) <= f.hi)
			|| a.cu + a.cd > 2 * rc - (a.cu + (a.nu ?? 1) - 1) - (a.cd + (a.nd ?? 1) - 1))) {
			// a call runs along a lane right of the code (lane RIGHT + k), apart from the dataflow at the
			// left, unless no dataflow runs there along its lines and the way at the left is shorter
			a.ut = free(row(a.lu), a.cu, Infinity);
			a.dt = free(row(a.ld), a.cd, Infinity);
			a.lane = RIGHT + free(right, Math.min(a.lu, a.ld), Math.max(a.lu, a.ld));
		} else {
			a.ut = free(row(a.lu), 0, a.cu);
			a.dt = free(row(a.ld), 0, a.cd);
			a.lane = free(lanes, Math.min(a.lu, a.ld), Math.max(a.lu, a.ld));
			if(!a.call) {
				flow.push({ lo: Math.min(a.lu, a.ld), hi: Math.max(a.lu, a.ld) });
			}
		}
	}
	// arrows that share a name spread over it, in the order of where they come from or go to: the
	// left lane first, then by column, the right lane last
	const side = (a, col) => a.lane >= RIGHT ? 1e6 + a.lane : a.lane >= 0 && a.lu !== a.ld ? -1 - a.lane : col;
	const spread = (key, order, set) => {
		const groups = new Map();
		arrows.forEach(a => groups.set(key(a), [...groups.get(key(a)) ?? [], a]));
		for(const list of groups.values()) {
			list.sort((x, y) => order(x) - order(y)).forEach((a, i) => set(a, i + 1, list.length));
		}
	};
	spread(a => `${a.ld}:${a.cd}`, a => side(a, a.cu), (a, i, n) => Object.assign(a, { ei: i, en: n }));
	spread(a => `${a.lu}:${a.cu}`, a => side(a, a.cd), (a, i, n) => Object.assign(a, { si: i, sn: n }));
	// the tracks below the line of a name, so that the arrows into it (or out of it) do not cross: from
	// the left, the one further left is closer to the line; from the right, the one further right
	const balance = (key, track, place) => {
		const groups = new Map();
		for(const a of arrows.filter(x => x.lane >= 0 && x.lu !== x.ld)) {
			const k = `${key(a)}:${a.lane >= RIGHT ? 'r' : 'l'}`;
			groups.set(k, [...groups.get(k) ?? [], a]);
		}
		for(const [k, list] of groups) {
			const tracks = list.map(a => a[track]).sort((x, y) => x - y);
			list.sort((x, y) => k.endsWith('r') ? y[place] - x[place] : x[place] - y[place]).forEach((a, i) => a[track] = tracks[i]);
		}
	};
	balance(a => `${a.ld}:${a.cd}`, 'dt', 'ei');
	balance(a => `${a.lu}:${a.cu}`, 'ut', 'si');
	arrows.forEach(a => a.rc = rc);
	return arrows;
}
/** the lanes right of the code (calls) are numbered from here */
export const RIGHT = 1000;

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
	...r.files ? { files: r.files } : {}, ...r.lines === true ? { lines: true } : {} });

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
	const repl = backends({ ...opts, requireVersion: undefined, backend: m[1], ...m[1] === 'docker' ? { image: m[2] } : { flowr: m[2] } })[0];
	repl.version();
	return repl;
}

/** the requests flowR can answer, each with the code it is asked on, written to a file of `dir` */
export function planRequests(requests, blocks, dir) {
	const todo = [], files = new Map();
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
		const side = r.kind === 'slice' ? sideLines(r) : undefined;
		if(side) {
			shown = lines;
			lines = side;
		}
		if(!lines) {
			continue;
		}
		const crit = c => [].concat(c ?? []).map(x => criterion(x, lines));
		r = { ...r, criterion: crit(r.criterion), criteria: crit(r.criteria) };
		// requests on the same code share a file, which flowR (2.13) analyzes once for all
		const text = lines.join('\n') + '\n';
		let file = files.get(text);
		if(!file) {
			file = `r${files.size}.R`;
			files.set(text, file);
			fs.writeFileSync(path.join(dir, file), text);
		}
		todo.push({ r, lines, shown, file, indent: block?.indent });
	}
	const order = [...files.values()];
	return todo.map((t, i) => [t, i]).sort(([a, i], [b, j]) => order.indexOf(a.file) - order.indexOf(b.file) || i - j).map(([t]) => t);
}


/** the commands of planned requests for one flowR */
export function requestCommands(flowr, todo, dir) {
	return todo.map(({ r, file }) => {
		const q = REQUESTS[r.kind](r, flowr);
		return typeof q === 'string' ? `${q} file://${flowr.file(dir, file)}` : flowr.query(q, dir, file);
	});
}

const requestQuery = (t, flowr) => REQUESTS[t.r.kind](t.r, flowr);

/**
 * The requests on one file in one query where their queries fit: of one type only the same, but any
 * slices (memberAnswer). A REPL command, a query of the document, or two queries of a type go alone.
 * Each batch: { cmd, slices, members: [{ t, slice }] }
 */
export function batchRequests(flowr, todo, dir) {
	const batches = [], open = new Map(), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	for(const t of todo) {
		const q = requestQuery(t, flowr), at = `file://${flowr.file(dir, t.file)}`;
		if(typeof q === 'string' || t.r.kind === 'query' || new Set(q.map(x => x.type)).size !== q.length) {
			batches.push({ cmd: typeof q === 'string' ? `${q} ${at}` : flowr.query(q, dir, t.file), members: [{ t }], alone: true });
			continue;
		}
		const fits = b => q.every(x => x.type === 'static-slice' || b.queries.every(y => y.type !== x.type || same(x, y)));
		let b = (open.get(t.file) ?? []).find(fits);
		if(!b) {
			b = { file: t.file, queries: [], members: [] };
			open.set(t.file, [...open.get(t.file) ?? [], b]);
			batches.push(b);
		}
		const m = { t };
		for(const x of q) {
			if(!b.queries.some(y => same(x, y))) {
				b.queries.push(x);
			}
			if(x.type === 'static-slice') {
				m.slice = b.queries.filter(y => y.type === 'static-slice').findIndex(y => same(x, y));
			}
		}
		b.members.push(m);
	}
	for(const b of batches.filter(b => !b.alone)) {
		b.cmd = flowr.query(b.queries, dir, b.file);
		b.slices = b.queries.filter(y => y.type === 'static-slice').length;
	}
	return batches;
}

/**
 * A request's own slice of a batch's answer: keyed by criteria ('3@x,5@y'), by query JSON in older
 * flowR, else by order if all are there. undefined if the answer does not tell
 */
export function memberAnswer(b, m, a) {
	if(!a || m.slice === undefined || b.slices === 1) {
		return a;
	}
	const ss = a['static-slice'], results = ss?.results ?? {};
	const all = b.queries.filter(y => y.type === 'static-slice'), keys = Object.keys(results);
	const named = q => [q.criteria.join(','), JSON.stringify(q)].find(k => k in results);
	const key = named(all[m.slice]) ?? (keys.length === b.slices && !all.some(named) ? keys[m.slice] : undefined);
	// without a result of its own it runs alone: an error of the batch may be another slice's
	return key === undefined ? undefined : { ...a, 'static-slice': { ...ss, results: { [key]: results[key] }, error: undefined } };
}

/** cached answers (got) and the commands for the rest (cmds); `finish` keeps their answers, returns what failed */
export function requestPlan(flowr, todo, dir, cache = NO_CACHE) {
	// twins: the first request by what it asks of which code, copies: [request, its twin] (beamer overlays)
	const got = new Map(), keys = new Map(), misses = [], twins = new Map(), copies = [];
	for(const t of todo) {
		let content;
		try {
			content = [requestQuery(t, flowr), fs.readFileSync(path.join(dir, t.file), 'utf8')];
		} catch{ /* no file */ }
		const key = content && cache.enabled ? cache.key('request', ...content) : undefined;
		const hit = cache.get(key), same = content && JSON.stringify(content);
		if(hit !== undefined) {
			got.set(t, hit);
		} else if(twins.has(same)) {
			copies.push([t, twins.get(same)]);
		} else {
			if(same) {
				twins.set(same, t);
			}
			keys.set(t, key);
			misses.push(t);
		}
	}
	const batches = batchRequests(flowr, misses, dir);
	return {
		got, cmds: batches.map(b => b.cmd),
		finish(answers) {
			const failed = [];
			batches.forEach((b, i) => b.members.forEach(m => {
				const a = answers?.[i] === null && b.members.length > 1 ? undefined : memberAnswer(b, m, answers?.[i]);
				if(a === undefined) {
					failed.push(m.t);
				} else {
					this.keep(m.t, a);
				}
			}));
			return failed;
		},
		keep(t, a) {
			got.set(t, a);
			copies.forEach(([c, of]) => of === t && got.set(c, a));
			if(!answerError(a)) {
				cache.set(keys.get(t), t.r.kind === 'query' || !a ? a : slim(a));
			}
		}
	};
}

/** the answers to the requests, by the flowR each names; `answered`: those that ran along with the analysis */
export function requestTexts(repl, requests, blocks, dir, opts = {}, todo = planRequests(requests, blocks, dir), answered = new Map()) {
	// the requests of each flowR run together; one that flowR cannot answer must not take the others
	// along: then each runs alone
	const out = [];
	for(const spec of new Set(todo.map(t => t.r.instance ?? ''))) {
		let mine = todo.filter(t => (t.r.instance ?? '') === spec);
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
		mine = mine.filter(t => {
			const min = MIN_VERSIONS[t.r.kind];
			if(min && !satisfiesSafe(flowr, `>=${min}`)) {
				out.push(`\\mrFlowrRequestsFailed{${t.r.kind} ${texText(t.r.name)} needs flowR ${min} or later}`);
				return false;
			}
			return true;
		});
		const got = new Map(spec ? [] : [...answered].filter(([t]) => mine.includes(t)));
		// a request a batch could not answer runs alone
		const plan = requestPlan(flowr, mine.filter(t => !got.has(t)), dir, AnswerCache.for(flowr, opts));
		const each = cmds => {
			try {
				return flowr.exec(cmds, dir);
			} catch{
				return cmds.map(c => {
					try {
						return flowr.exec([c], dir)[0];
					} catch{
						return undefined;
					}
				});
			}
		};
		const failed = plan.cmds.length ? plan.finish(each(plan.cmds)) : [];
		const alone = failed.length ? each(requestCommands(flowr, failed, dir)) : [];
		failed.forEach((t, i) => alone[i] === undefined ? plan.got.set(t, undefined) : plan.keep(t, alone[i]));
		mine.forEach(t => {
			const a = got.get(t) ?? plan.got.get(t);
			// a slice holds its criterion: an empty one (older flowR, criteria that match nothing) failed
			const why = !a ? 'flowR gave no answer' : answerError(a) ?? (t.r.kind === 'slice' && sliceLines(a).length === 0 ? 'its criteria match nothing' : undefined);
			if(why) {
				out.push(`\\mrFlowrRequestsFailed{${t.r.kind} ${texText(t.r.name)}: ${texMessage(why)}}`);
			}
			// a failed slice keeps all lines
			if(!(why && t.r.kind === 'slice')) {
				out.push(...answerText(t, a));
			}
		});
	}
	return out;
}

/** answers magic-r reads only from newer flowR (control flow graphs changed in 2.14) */
const MIN_VERSIONS = { 'control-flow': '2.14' };

/** what magic-r reads of the answer to a request, by its kind (a query, else) */
const ANSWERS = {
	// the part after '#' apart, which TeX cannot take in a link otherwise
	mermaid:        ({ r }, a) => typeof a.url === 'string'
		? [`\\mrFlowrMermaid{${r.name}}{${a.url.replace(/[^!-~]/g, '').replace('#', '}{')}}`] : [],
	dataflow:       ({ r, lines }, a) => [dataflowGraph(r.name, a, lines, graphOptions(r))],
	'call-graph':   ({ r, lines }, a) => [callGraph(r.name, a, lines, graphOptions(r))],
	'control-flow': ({ r, lines }, a) => [controlFlowGraph(r.name, a, lines, graphOptions(r))],
	arrows:         ({ r, lines, indent }, a) => arrowTexts(r.block, a, lines, r.criteria, r.all === true, r.calls ?? [], r.route === 'side' ? 'side' : 'auto', indent),
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
/** an answer magic-r cannot read costs only its own request */
const answerText = (t, a) => {
	try {
		return a ? ANSWERS[t.r.kind](t, a).filter(Boolean) : [];
	} catch{
		return [];
	}
};

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

/** the exports flowR knows; none before 2.12 (no signature query): then R and the shipped database tell */
const exportsOrNothing = (repl, wanted, dir) => satisfiesSafe(repl, '>=2.12') ? exportsWithFlowr(repl, wanted, dir) : new Map();

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

/**
 * What an installed R knows of packages, in one run that does not block: help topics (pkg ->
 * Map(alias -> topic), `data`: its data sets), exports (pkg -> {version, fns, generics, data}; base:
 * its whole environment), and DESCRIPTION versions ('7.3-65')
 */
export async function rPackages(rscript, pkgs) {
	const topics = new Map(), exports = new Map(), versions = new Map();
	if(!rscript || pkgs.length === 0) {
		return { topics, exports, versions };
	}
	const code = `internal <- tryCatch(tools:::.get_internal_S3_generics(), error = function(e) .S3PrimitiveGenerics)
		dispatches <- function(e) is.call(e) && (identical(e[[1L]], as.name("UseMethod")) || any(vapply(as.list(e), dispatches, logical(1))))
		for (p in commandArgs(TRUE)) if (nzchar(system.file(package = p))) {
			f <- system.file("help", "aliases.rds", package = p)
			if (nzchar(f)) { a <- readRDS(f); cat(paste("H", p, names(a), a, sep = "\t"), sep = "\n")
				d <- utils::data(package = p)$results[, "Item"]
				if (length(d)) cat(paste("H", p, "", sub(" .*", "", d), sep = "\t"), sep = "\n") }
			x <- if (p == "base") ls(baseenv(), all.names = TRUE) else tryCatch(getNamespaceExports(p), error = function(e) character())
			env <- if (p == "base") baseenv() else asNamespace(p)
			g <- vapply(x, function(n) tryCatch({ f <- get(n, envir = env)
				if (!is.function(f)) "d" else if (n %in% internal || dispatches(body(f))) "g" else "" }, error = function(e) ""), character(1))
			cat(paste("E", p, packageDescription(p)$Version, x, g, sep = "\t"), sep = "\n") }`;
	const res = await runAsync([...splitCommand(rscript), '--vanilla', '-e', code, '--args', ...pkgs], { timeout: 120 });
	for(const line of res.stdout.split('\n')) {
		const [kind, p, a, b, c] = line.split('\t');
		if(kind === 'H') {
			const help = topics.get(p) ?? topics.set(p, new Map()).get(p);
			if(a && b) {
				help.set(a, b);
			} else if(b) {
				(help.data ??= []).push(b);
			}
		} else if(kind === 'E') {
			versions.set(p, a);
			if(b) {
				const e = exports.get(p) ?? exports.set(p, { version: a, fns: [], generics: [], data: [] }).get(p);
				e.fns.push({ name: b });
				({ g: e.generics, d: e.data })[c]?.push(b);
			}
		}
	}
	return { topics, exports, versions };
}

/**
 * The help index of an installed package decides the topics: the signature database guesses a
 * topic from the name for names without a help page (dead links) and misses some aliases ('%>%').
 * A name the index lacks keeps its link only if the database knows a topic other than its name.
 */
/**
 * The aliases of the help index that the package exports but the signature database lacks
 * ('anyNA' of the topic 'NA'). Internal names with a help page do not link.
 */
export function helpAliases(help, known, exported) {
	if(!help || !exported) {
		return [];
	}
	const have = new Set(known?.map(f => f.name)), out = new Set(exported.map(f => f.name));
	return [...help.keys()].filter(a => out.has(a) && !have.has(a)).map(name => ({ name }));
}

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
	const cache = cacheDir(opts), exact = exactVersion(opts.requireVersion);
	// installed versions of flowR are no cached answers: --no-cache uses them too
	const installs = cache ?? cacheDir({ ...opts, noCache: false });
	const out = [];
	for(const kind of kinds) {
		if(kind === 'node') {
			const installed = exact && npmInstalled(installs, exact);
			if(installed) {
				out.push(new Repl('node', [process.execPath, installed], { timeout, engine: opts.engine, cache }));
			}
			const cmd = opts.flowr ?? process.env.MAGIC_R_FLOWR ?? onPath('flowr');
			// an empty $MAGIC_R_FLOWR means no command line, not 'look for one'
			const argv = cmd ? splitCommand(cmd) : cmd === undefined ? npmFlowr() : undefined;
			if(argv) {
				out.push(new Repl('node', argv, { timeout, engine: opts.engine, cache }));
			}
		} else if(kind === 'docker') {
			const image = opts.image ?? `eagleoutice/flowr:${exact ?? 'latest'}`, docker = onPath('docker');
			if(docker) {
				const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
				// the image id tells the version; a missing image only for an explicit backend (no 700 MB pull mid-run)
				const identity = () => {
					const res = run([docker, 'image', 'inspect', '--format', '{{.Id}}', image], { timeout: 20 });
					if(res.status !== 0 && opts.backend !== 'docker') {
						throw new Error(`docker: no image ${image} (docker pull ${image})`);
					}
					return res.status === 0 ? [res.stdout.trim()] : undefined;
				};
				out.push(new Repl('docker', dir => [docker, 'run', '--rm', '-i', ...user, '-e', 'FLOWR_SECURE_MODE', '-v', `${dir}:/work`, image],
					{ timeout, mount: '/work', engine: opts.engine, cache, identity }));
			}
		} else if(kind === 'r') {
			if(opts.rscript) {
				out.push(new RRepl(opts.rscript, { timeout }));
			}
		} else if(kind === 'web') {
			out.push(new Web({ cache, timeout }));
		} else {
			throw new Error(`unknown backend ${kind}`);
		}
	}
	// else that version from npm, before the web backend
	if(exact && opts.install !== false && kinds.includes('node') && !npmInstalled(installs, exact)) {
		const web = out.findIndex(b => b instanceof Web);
		out.splice(web < 0 ? out.length : web, 0, new NpmRepl(exact, { timeout, engine: opts.engine, cache, installs }));
	}
	return out;
}

/** the version of a requirement that names exactly one ('2.15.10', '=2.15.10'), else undefined */
export function exactVersion(req) {
	return /^\s*=?\s*v?(\d+\.\d+\.\d+)\s*$/.exec(req ?? '')?.[1];
}

/** cli/flowr.js of flowR of a version that magic-r installed into its cache, else undefined */
export function npmInstalled(cache, version) {
	const cli = path.join(cache, 'flowr', version, 'node_modules', '@eagleoutice', 'flowr', 'cli', 'flowr.js');
	return fs.existsSync(cli) ? cli : undefined;
}

/** installs flowR of a version into the cache with npm */
export function installFlowr(cache, version, timeout) {
	const npm = onPath('npm');
	if(!npm) {
		throw new Error(`no npm to install flowR ${version}`);
	}
	const dir = path.join(cache, 'flowr', version), part = `${dir}.part-${process.pid}`;
	fs.mkdirSync(part, { recursive: true });
	try {
		const res = run([npm, 'install', '--prefix', part, '--no-save', '--no-audit', '--no-fund', '--omit=dev', `@eagleoutice/flowr@${version}`],
			{ timeout: Math.max(timeout ?? 0, 600) });
		if(res.status !== 0) {
			const why = (res.stderr || res.stdout || '').split('\n').find(l => /ERR|error/.test(l)) ?? `exit code ${res.status}`;
			throw new Error(`npm cannot install flowR ${version}: ${texMessage(why)}`);
		}
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(part, dir);
	} finally {
		fs.rmSync(part, { recursive: true, force: true });
	}
	const cli = npmInstalled(cache, version);
	if(!cli) {
		throw new Error(`npm installed flowR ${version} without cli/flowr.js`);
	}
	return cli;
}

/** flowR of a version from npm, installed into the cache when it is first asked for */
export class NpmRepl extends Repl {
	constructor(version, opts) {
		super('node', undefined, opts);
		this.wanted = version;
		this.installs = opts.installs ?? opts.cache;
	}
	version() {
		if(!this.argv) {
			console.error(`magic-r: installing flowR ${this.wanted} into ${this.installs} (once)`);
			const cli = installFlowr(this.installs, this.wanted, this.timeout);
			this.argv = [process.execPath, cli];
		}
		return super.version();
	}
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
	// by the version flowR reports, by name if it reports none (older flowR)
	const file = w => cache && path.join(cache, key, w.version ? `${w.pkg}@${w.version}.cfg` : `${w.pkg}.cfg`);
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
		// R works while flowR searches
		const r = rPackages(opts.rscript, missing.map(w => w.pkg));
		const found = await Promise.resolve().then(() => web ? new Map(missing.map(w => [w.pkg, backend.table.byName.get(w.pkg)]).filter(([, v]) => v))
			: exportsOrNothing(backend, missing, dir)).finally(() => r);
		const { topics, exports: installed, versions } = await r;
		// what flowR does not know, an installed R may
		for(const w of missing) {
			if(!found.get(w.pkg)?.fns.length && installed.has(w.pkg)) {
				found.set(w.pkg, installed.get(w.pkg));
			}
		}
		const shipped = shippedPages();
		for(const w of missing) {
			const s = found.get(w.pkg), help = topics.get(w.pkg);
			// the page of a name: R's help index, else the shipped database (verified), else what flowR
			// says, which names a page after the function, not its topic ('return' is on 'function')
			const page = f => shipped.get(`${w.pkg}::${f.name}`);
			const fns = [...s?.fns ?? [], ...helpAliases(help, s?.fns, installed.get(w.pkg)?.fns), ...(help?.data ?? []).map(name => ({ name }))]
				.map(f => page(f) ? { name: f.name, docUrl: page(f) } : f);
			if(!fns.length) {
				continue;
			}
			// R knows the generics of its own packages, which are never guessed ('freeny.x' is a data set)
			const generics = installed.get(w.pkg)?.generics ?? (BASE_PACKAGES.includes(w.pkg) ? [] : undefined);
			// what is no function: objects R knows (letters, pi) and the data sets of the help index
			const data = [...installed.get(w.pkg)?.data ?? [], ...help?.data ?? []];
			const text = packageEntry(w.pkg, versions.get(w.pkg) ?? s?.version ?? 'unknown', withHelp(fns, help), generics, data);
			entries.set(w.pkg, text);
			const f = file(w);
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
	let todo;
	try {
		todo = web ? [] : planRequests(requests, blocks, dir);
	} catch{ /* they fail below, with a message */ }
	const along = todo?.filter(t => !t.r.instance && satisfiesSafe(backend, `>=${MIN_VERSIONS[t.r.kind] ?? '0'}`)) ?? [];
	const cache = web ? NO_CACHE : AnswerCache.for(backend, opts);
	const plan = web ? undefined : requestPlan(backend, along, dir, cache);
	const { entries, skipped, units = [], more } = web || blocks.length === 0 ? detectByScan(blocks)
		: detectWithFlowr(backend, blocks, dir, plan.cmds, cache);
	if(plan && more) {
		plan.finish(more);
	}
	const wanted = new Map();
	for(const e of entries) {
		const w = wanted.get(e.pkg) ?? wanted.set(e.pkg, { pkg: e.pkg }).get(e.pkg);
		w.version ??= e.version;
		w.symbols ??= e.symbols;
	}
	const pkgs = await packageEntries(backend, [...wanted.values()], opts, dir);
	const ops = operators([...pkgs.values()]);
	const marked = new Set(blocks.filter(b => b.dependencies).map(b => b.id));
	let answered = [];
	if(requests.length) {
		try {
			if(web) {
				throw new Error('the web backend answers no queries');
			}
			const early = plan?.got ?? new Map();
			answered = [...requestTexts(backend, requests, blocks, dir, opts, todo ?? planRequests(requests, blocks, dir), early),
				...sessionTexts(backend, requests, dir)];
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
		...units.flatMap(dependencyLines).filter(l => marked.has(/^\\mrFlowLine\{(.*)@\d+\}/.exec(l)[1])),
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
	if(opts.cleanup !== false) {
		staleSideFiles(input).forEach(f => fs.rmSync(f, { force: true }));
	}
}

/**
 * The side files of older versions of magic-r beside the code of a document ('doc.mr.R'): one per
 * listing, 'doc.mr-play-3.R' and 'doc.mr-slice-3.R'. Now one file of each kind holds all listings.
 */
export function staleSideFiles(input) {
	const dir = path.dirname(input), job = path.basename(input).replace(/\.mr\.R$/, '');
	if(job === path.basename(input)) {
		return [];
	}
	const old = new RegExp(`^${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mr-(play|slice)-\\d+\\.R$`);
	try {
		return fs.readdirSync(dir).filter(f => old.test(f)).map(f => path.join(dir, f));
	} catch{
		return [];
	}
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
	// a package can document pages the sites do not have (yet)
	const r = await checkLinks(text);
	writeAtomic(out, r.text);
	console.error(`wrote ${pkgs.length} packages to ${out}, ${r.failed} of ${r.checked} pages are gone, ${r.moved} of their names have another page`
		+ (r.unreachable ? `, ${r.unreachable} pages did not answer (kept)` : ''));
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

/** the pages of the shipped database: 'pkg::name' -> url */
let shippedCache;
export function shippedPages(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'magic-r-links.cfg')) {
	if(!shippedCache || shippedCache.file !== file) {
		const pages = new Map();
		try {
			for(const [url, names] of databaseUrls(fs.readFileSync(file, 'utf8'))) {
				names.forEach(n => pages.set(n, url));
			}
		} catch{ /* no database */ }
		shippedCache = { file, pages };
	}
	return shippedCache.pages;
}

/** the database without the names whose page is one of `dead`, except the ones `moved` (pkg::name -> url) gives another page */
export function prune(text, dead, moved = new Map()) {
	const out = text.replace(PACKAGE, (all, scheme, pkg, body) => {
		const urls = new Map();
		let kept = body.replace(ENTRY, (entry, kind, arg, names) => {
			const alive = entryNames(names).filter(n => !dead.has(entryUrl(scheme, pkg, kind, arg, untex(n))));
			return alive.length === 0 ? '' : entryText(`\\${kind}${arg === undefined ? '' : `{${arg}}`}`, alive.map(untex));
		});
		for(const [key, url] of moved) {
			if(key.startsWith(`${pkg}::`)) {
				urls.set(url, [...urls.get(url) ?? [], key.slice(pkg.length + 2)]);
			}
		}
		kept = [kept, ...[...urls].sort(byKey).map(([url, names]) => entryText(`\\U{${tex(url)}}`, names))].join('\n')
			.replace(/\n{2,}/g, '\n').replace(/^\n|\n$/g, '');
		return `\\mrPackage[${scheme}]{${pkg}}{${all.match(/^\\mrPackage\[\w+\]\{[^}]*\}\{([^}]*)\}/)[1]}}{%\n${kept}\n}`;
	});
	return out.replace(/\\mrOperators\{[^\n]*\}/, () => `\\mrOperators{${operators([out.replace(/\\mrOperators\{[^\n]*\}/, '')]).join(',')}}`);
}

const MIRRORS = { rman: p => `https://search.r-project.org/R/refmans/${p}/html/`, cran: p => `https://search.r-project.org/CRAN/refmans/${p}/html/` };
/** the pages to try for a name whose page `url` is gone: its own page, then the same pages on search.r-project.org */
export function fallbackUrls(scheme, pkg, url, name) {
	const topic = url.match(SCHEMES[scheme])?.[2];
	const pages = [DOCS[scheme](pkg) + name + '.html', ...[topic, name].filter(Boolean).map(t => MIRRORS[scheme](pkg) + t + '.html')];
	return [...new Set(pages)].filter(u => u !== url);
}

// a page that is gone; any other failure (no answer, 429, 5xx) is the network or the site
const GONE = new Set([404, 410]);
/** the status of a page (0: no answer), asked again after each of `delays` (ms) while it fails otherwise */
async function status(url, delays) {
	let s = 0;
	for(let attempt = 0; ; attempt++) {
		s = await fetch(url, { signal: AbortSignal.timeout(30000) }).then(r => r.status, () => 0);
		if(s === 200 || GONE.has(s) || attempt >= delays.length) {
			return s;
		}
		await new Promise(resolve => setTimeout(resolve, delays[attempt]));
	}
}

/**
 * Requests every page of a database. A name whose page is gone (404, 410) moves to the first
 * fallback page that works and is dropped if none does. A page that does not answer is kept.
 * Returns the fixed database, how many pages are gone, and how many did not answer.
 */
export async function checkLinks(text, log = console.log, delays = [1000, 4000, 15000]) {
	const urls = [...databaseUrls(text)], schemes = new Map();
	for(const [, scheme, pkg] of text.matchAll(PACKAGE)) {
		schemes.set(pkg, scheme);
	}
	const dead = new Set(), moved = new Map(), known = new Map();
	let unreachable = 0;
	const ok = async u => (known.has(u) ? known : known.set(u, status(u, delays))).get(u).then(s => s === 200);
	let next = 0;
	const worker = async() => {
		while(next < urls.length) {
			const [url, names] = urls[next++];
			const s = await status(url, delays);
			if(s === 200) {
				continue;
			}
			if(!GONE.has(s)) {
				unreachable++;
				log(`UNREACHABLE ${s} ${url} (${names.join(', ')}), kept`);
				continue;
			}
			dead.add(url);
			const fixed = [];
			for(const full of names) {
				const pkg = full.slice(0, full.indexOf('::')), name = full.slice(pkg.length + 2);
				for(const alt of fallbackUrls(schemes.get(pkg), pkg, url, name)) {
					if(await ok(alt)) {
						moved.set(full, alt);
						fixed.push(`${full} -> ${alt}`);
						break;
					}
				}
			}
			log(`FAIL ${s} ${url} (${names.join(', ')})${fixed.length ? `, moved ${fixed.join(', ')}` : ''}`);
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	return { text: dead.size ? prune(text, dead, moved) : text, checked: urls.length, failed: dead.size, moved: moved.size, unreachable };
}

export async function verifyCommand(opts, [file]) {
	const root = path.dirname(fileURLToPath(import.meta.url));
	file ??= path.join(root, 'magic-r-links.cfg');
	const r = await checkLinks(fs.readFileSync(file, 'utf8'));
	console.error(`verified ${r.checked} pages, ${r.failed} are gone, ${r.moved} names have another page`
		+ (r.unreachable ? `, ${r.unreachable} did not answer (kept, check again later)` : ''));
	if(opts.prune && r.failed) {
		writeAtomic(file, r.text);
		console.error(`moved or removed their names in ${file}`);
	} else {
		process.exitCode = r.failed ? 1 : 0;
	}
}

export function installCommand(opts, [version]) {
	const v = exactVersion(version);
	const cache = cacheDir({ ...opts, noCache: false });
	if(!v || !cache) {
		throw new Error('usage: magic-r-flowr.mjs install [--cache <dir>] <version, e.g. 2.15.10>');
	}
	const cli = npmInstalled(cache, v) ?? installFlowr(cache, v, opts.timeout);
	const repl = new Repl('node', [process.execPath, cli], { timeout: opts.timeout, engine: opts.engine });
	console.error(`flowR ${repl.version()} is in ${path.dirname(path.dirname(cli))}`);
}

export function parseArgs(argv) {
	const opts = {}, rest = [];
	const keys = { '--flowr': 'flowr', '--rscript': 'rscript', '--cache': 'cache', '--timeout': 'timeout', '-o': 'output', '--backend': 'backend', '--image': 'image', '--require-version': 'requireVersion', '--engine': 'engine' };
	for(let i = 0; i < argv.length; i++) {
		if(argv[i] === '--no-cache') {
			opts.noCache = true;
		} else if(argv[i] === '--no-cleanup') {
			opts.cleanup = false;
		} else if(argv[i] === '--no-install') {
			opts.install = false;
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
	const commands = { document: documentCommand, generate: generateCommand, verify: verifyCommand, install: installCommand };
	if(commands[cmd]) {
		return commands[cmd](opts, rest);
	}
	const usage = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
	console.log(usage.slice(1, usage.findIndex(l => l.startsWith('import'))).map(l => l.slice(3)).join('\n'));
	process.exitCode = cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
}

/**
 * Whether node runs this file (not a test importing it): node gives the module its real path, but
 * argv the path it was called by, which may pass a symlink (a linked TEXMF tree or checkout).
 */
export function isMain(argv1 = process.argv[1], url = import.meta.url) {
	if(!argv1) {
		return false;
	}
	const real = p => {
		try {
			return fs.realpathSync(p);
		} catch{
			return path.resolve(p);
		}
	};
	return real(argv1) === real(fileURLToPath(url));
}

if(isMain()) {
	main().catch(e => {
		console.error(`error: ${e.message}`);
		process.exitCode = 1;
	});
}
