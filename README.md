# magic-r: R listings that link to their documentation, with flowR and R

[![made-with-latex](https://img.shields.io/badge/Made%20with-LaTeX-1f425f.svg)](https://www.latex-project.org/) [![LPPL 1.3c](https://img.shields.io/badge/License-LPPL%201.3c-yellow.svg)](https://www.latex-project.org/lppl.txt) [![compile](https://github.com/EagleoutIce/magic-r/actions/workflows/compile.yaml/badge.svg)](https://github.com/EagleoutIce/magic-r/actions/workflows/compile.yaml) [![verify links](https://github.com/EagleoutIce/magic-r/actions/workflows/links.yaml/badge.svg)](https://github.com/EagleoutIce/magic-r/actions/workflows/links.yaml)

Write plain R in your LaTeX documents and slides, and get listings that link themselves: names of packages lead to their help pages (R's manual, [rdrr.io](https://rdrr.io)), and everything you define leads back to its definition. [flowR](https://github.com/flowr-analysis/flowr) finds the packages your code loads while the document compiles, and R can compute values and whole console sessions. See the [documentation](https://github.com/EagleoutIce/magic-r/blob/gh-pages/magic-r-doc.pdf) for all features.

Everything builds on [xlistings](https://github.com/EagleoutIce/xlistings) and works with its styles, environments, inline commands, and `minted` emulation. It is the R sibling of [magic-haskell](https://github.com/EagleoutIce/magic-haskell).

**Always**, with nothing installed:

- **Links to the documentation.** A shipped database of 95 packages (all of R's own and recommended packages, the whole tidyverse, and other popular CRAN packages, with their functions and data sets, generated from flowR's signature database and R's help index, every link verified). A package is only read when a document uses it.
- **Packages attach as in R.** After `library(dplyr)`, `filter` is `dplyr::filter`, before it `stats::filter`. `pkg::name` always links into `pkg`, and `library(p, character.only = TRUE)` does not take `p` for a package.
- **Links to user definitions.** Names assigned with `<-`, `=`, `<<-`, `->`, or `assign()`, and parameters, link to their definition, across listings, beamer overlays, and console sessions. Named arguments and `df$col` do not link. `mrlocallinks=false` (option `locallinks`) turns them off, `mrlinks=false` all links of a listing.
- **Roxygen comments** show their tags and link `[pkg::name()]`.
- **Indices** for plain R (key `mrindex`, option `index`): each use of a symbol numbered (`usage`, the default) or SSA versions (`ssa`), referenced in the text with `\mrUse[label]{x}{2}`, or by place with `\mrUseAt[label]{5@[2]x}` (with its index), in any listing with a name.
- **Names in strings** of `assign()`, `get()`, `get0()`, and `exists()` link to their definitions.
- **Inline code** reads `%`, `#`, and `$` verbatim: `\bmr{x %in% y$z}`. Raw strings (`r"(...)"`) are strings.
- **Operators and keywords** can link to R's help too (option `operators`): `<-`, `|>`, `if`, `::`.
- **Ligatures copy as text.** `x <- y |> f()` can be typeset with tight ligatures or, with the option `symbols`, as arrows and triangles, but copies as the original text.
- **Backtick names** (`` `my var` ``) look like names, and link with flowR.
- **Markers.** `|warn|...|warn|`, `|err|...|err|`, `|info|...|info|` over several lines.

**With [flowR](https://github.com/flowr-analysis/flowr)** (command line, also a local build with `flowr-command`, docker with `flowr-image`, the R package `flowr`, or flowR's [signature browser](https://flowr-analysis.github.io/flowr/wiki/sigdb/), whichever works, or the one the options `flowr-backend` and `flowr-version` require). A listing or graph can name another flowR to compare versions:

- **Code with syntax errors** still counts: flowR parses with tree-sitter's lax parser (option `flowr-engine`), and escapes to LaTeX (`!*\textbf{x}*!`) reach flowR as their text.
- **Every package** the code uses, also through `pacman::p_load` or a loop over `library(p, character.only = TRUE)`.
- **Every name links to the definition it reads**, from flowR's dataflow graph: across listings and in inline code, and a local variable named like a function of a package links to the variable.
- **Lines that read, write, or source files** get a band and their kind at the right (option `dependencies`).
- **Slices** gray out or leave out what does not affect a criterion (`mrslice={5@total}`, `3@[2]v` for the second `v` of line 3, `mrslicemode=hide`).
- **Arrows in the code** from the names of some criteria to the definitions they read (`mrarrows={6@total, 5@[2]count}`), one color per criterion, with overlapping arrows kept apart. With the option `interactive` (optional content, `ocgx2`) and the key `mrinteractive` (or `interactive=all`), a click on a use shows its arrows, a click on a definition the arrows into it, also in beamer.
- **The linter** of flowR underlines its findings with a wave (`\mrLintShape`) and names their rules, linked to flowR's wiki (`mrlint`, option `lint`, `\mrLinterRules`).
- **Dataflow and control flow graphs** with vertex ids, built-ins, and the shapes of flowR's mermaid graphs, laid out by the script with orthogonal edges and drawn with TikZ: `\mrDataflowGraph[legend,rowsep=0.3]{label}`, `\mrControlFlowGraph{label}`, and `\mrCallGraph{label}` (`function=name` for what one function calls, `{a,b}` for several listings as files). The key `mermaid` gives a link to the graph on mermaid.live instead.
- **flowR's playground**: with the option `playground`, a button beside each listing opens its code in [flowR's playground](https://flowr-analysis.github.io/flowr/wiki/playground/), and a linter finding opens it with the finding marked.
- **Any query of flowR**: `\mrFlowrQuery[block=label,path=/json/pointer]{name}{query}` and `\mrFlowrValue{name}`.

**With R**: `\mrValue{mean(x)}`, `\mrEval{summary(x)}`, and the environment `rsession`, animated on beamer slides.

```latex
\usepackage[eval,graphs]{magic-r}
\usepackage{hyperref}
...
\begin{mr}
library(dplyr)
mtcars |> filter(cyl > 4) |> summarise(mpg = mean(mpg))
\end{mr}
```

Compile with `-shell-escape` to let flowR and R answer (otherwise the package prints the commands to run by hand). See [`examples/example.tex`](examples/example.tex) and [`examples/example-beamer.tex`](examples/example-beamer.tex) for examples, and [`magic-r-doc.tex`](magic-r-doc.tex) for the source of the documentation.

## Development

`xlistings` is a git submodule, clone with `--recurse-submodules` (or run `git submodule update --init`).

```sh
latexmk                               # builds the examples and the documentation into build/ (R, flowR)
l3build check                         # runs the regression tests in tests/ (no R or flowR needed)
l3build save NAME                     # updates the expected output tests/NAME.tlg
node --test tests/node                # tests magic-r-flowr.mjs (MAGIC_R_FLOWR=<flowr> adds a real flowR)
node magic-r-flowr.mjs generate       # regenerates magic-r-links.cfg from tools/packages.txt
node magic-r-flowr.mjs verify --prune # requests every documentation page, drops the dead ones
l3build bench                         # times the listings of bench/cases.txt (bench/run.sh) and prints the table
l3build doc                           # typesets the documentation with shell escape (R and flowR)
```

## License

LaTeX Project Public License 1.3c, see [LICENSE](LICENSE).
