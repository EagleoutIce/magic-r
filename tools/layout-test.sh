#!/bin/sh
# A document as projects set it up: magic-r and xlistings in lib/ (a relative TEXINPUTS), and the
# output in build/ (-output-directory, as latexmk's $out_dir does). pdflatex must finish in time
# and flowR must answer, so the helper finds its script although it runs in build/ and is reached
# through a symlink.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# lib/magic-r is a symlink, as a linked checkout or TEXMF tree: node gets the script by the link
mkdir -p "$dir/checkout" "$dir/lib/xlistings" "$dir/build"
cp "$root/magic-r.sty" "$root/magic-r-links.cfg" "$root/magic-r-flowr.mjs" "$dir/checkout/"
ln -s ../checkout "$dir/lib/magic-r"
cp "$root/xlistings/xlistings.sty" "$root"/xlistings/langs/*.cfg "$dir/lib/xlistings/"
cat > "$dir/doc.tex" <<'TEX'
\documentclass{article}
\usepackage[language=R,playground]{magic-r}
\usepackage{hyperref}
\begin{document}
\begin{minted}[mrarrows={2@x}]{R}
x <- 1
print(x)
\end{minted}
\end{document}
TEX
cd "$dir"
for run in 1 2; do
   TEXINPUTS=./lib/magic-r:./lib/xlistings: timeout 300 pdflatex -output-directory=build -shell-escape \
      -interaction=nonstopmode doc.tex > /dev/null 2>&1 || { echo "layout: pdflatex run $run failed or hung"; tail -n 30 build/doc.log; exit 1; }
done
grep -q 'mrFlowrStatus{ok}' build/doc.mr.cfg || { echo "layout: flowR did not answer"; head -n 3 build/doc.mr.cfg; exit 1; }
printf '%s\n' "layout: ok ($(sed -n 's/.*mrFlowrStatus{ok}{\(.*\)}.*/\1/p' build/doc.mr.cfg))"
