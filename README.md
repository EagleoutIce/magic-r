# magic-r

[![LPPL 1.3c](https://img.shields.io/badge/License-LPPL%201.3c-yellow.svg)](https://www.latex-project.org/lppl.txt) [![compile](https://github.com/EagleoutIce/magic-r/actions/workflows/compile.yaml/badge.svg)](https://github.com/EagleoutIce/magic-r/actions/workflows/compile.yaml) [![verify links](https://github.com/EagleoutIce/magic-r/actions/workflows/links.yaml/badge.svg)](https://github.com/EagleoutIce/magic-r/actions/workflows/links.yaml)

Write plain R in your LaTeX documents and slides, and get listings that link themselves: functions and data sets of packages link to their help pages, and everything you define links back to its definition.
With [flowR](https://github.com/flowr-analysis/flowr) the package also finds the packages your code loads, and can draw slices, dataflow graphs, and linter findings. With R it can compute values and whole console sessions.

**The [documentation](https://github.com/EagleoutIce/magic-r/blob/gh-pages/magic-r-doc.pdf) describes every feature and option.**

```latex
\usepackage[eval,graphs]{magic-r}
\usepackage{hyperref}
...
\begin{mr}
library(dplyr)
mtcars |> filter(cyl > 4) |> summarise(mpg = mean(mpg))
\end{mr}
```

Nothing besides LaTeX is required. The links come from a shipped database of 95 packages.
flowR and R are optional and only run with `-shell-escape`. Without them (or without `node`), the document still compiles and magic-r prints a warning with the command it could not run.

The package builds on [xlistings](https://github.com/EagleoutIce/xlistings) and is the R sibling of [magic-haskell](https://github.com/EagleoutIce/magic-haskell).
Examples are in [`examples/`](examples/).

## Development

`xlistings` is a git submodule, so clone with `--recurse-submodules` (or run `git submodule update --init`).

```sh
latexmk                               # examples and documentation into build/
l3build check                         # regression tests (no R or flowR needed)
l3build save NAME                     # update tests/NAME.tlg
node --test tests/node                # tests of magic-r-flowr.mjs (MAGIC_R_FLOWR=<flowr> adds a real flowR)
node magic-r-flowr.mjs generate       # regenerate magic-r-links.cfg from tools/packages.txt
node magic-r-flowr.mjs verify --prune # check every documentation link, drop dead ones
l3build bench                         # benchmark (bench/cases.txt)
```

## License

LaTeX Project Public License 1.3c, see [LICENSE](LICENSE).
