#!/bin/sh
# Writes bench/bench-results.tex: every case of bench/cases.txt is typeset in
# four variants (see bench/measure.tex), each in two pdfTeX runs, the second
# one timed. MR_BENCH_RUNS sets how often a listing is typeset (default 5).
# The flowR column needs a backend of flowR (see magic-r-flowr.mjs), without
# one it stays empty; MR_BENCH_FLOWR_OPTIONS passes options to the script.
set -eu
cd "$(dirname "$0")/.."

runs=${MR_BENCH_RUNS:-5}
out=bench/bench-results.tex
rows=bench/rows.tmp
# absolute: flowR runs in bench/, where kpsewhich has to find magic-r-flowr.mjs
export TEXINPUTS="$PWD/:$PWD/xlistings//:"

# BusyBox date ignores %N
now() {
   t=$(date +%s%N)
   case $t in
      *[!0-9]* | ?????????? ) perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1e9' ;;
      *) echo "$t" ;;
   esac
}
# tenths of a ms as milliseconds for siunitx
ms() { awk -v t="$1" 'BEGIN { printf "\\qty{%.1f}{\\ms}", t / 10 }'; }

# n lines of R: blocks of ten lines with definitions, calls, pipes, and loops
sample() {
   awk -v n="$1" 'BEGIN {
      for (i = 0; i * 10 < n; i++) {
         print (i == 0 ? "library(dplyr)" : "# block " i)
         print "scale" i " <- function(x, by = 2) x * by"
         print "data" i " <- data.frame(a = 1:10, b = rnorm(10))"
         print "data" i " |> filter(a > 3) |> mutate(c = scale" i "(b)) -> res" i
         print "summary(res" i "$c)"
         print "if (nrow(res" i ") > 0) print(head(res" i ")) else message(\"empty\")"
         print "for (k in seq_len(3)) total" i " <- sum(res" i "$c, na.rm = TRUE) + k"
         print "assign(\"copy" i "\", total" i ")"
         print "write.csv(res" i ", \"out" i ".csv\")"
         print "paste(\"total\", total" i ", sep = \": \")"
      } }' | head -n "$1"
}

# $1 lines, $2 variant, $3 flowr option of the first run; prints avg|min|max
measure() {
   rm -f bench/measure.aux bench/measure.out bench/measure.mr.R bench/measure.mr.cfg
   for pass in 1 2; do
      flowr=$3
      [ "$pass" = 2 ] && [ "$flowr" != off ] && flowr=never
      start=$(now)
      if ! pdflatex -interaction=nonstopmode -halt-on-error -shell-escape -output-directory=bench \
         -jobname=measure \
         "\\def\\mrbenchruns{$runs}\\def\\mrbenchlines{$1}\\def\\mrbenchvariant{$2}\\def\\mrbenchflowr{$flowr}\\def\\mrbenchflowropts{${MR_BENCH_FLOWR_OPTIONS:-}}\\input{bench/measure.tex}" \
         < /dev/null > bench/measure.stdout 2>&1
      then
         echo "bench: $1 lines ($2, pass $pass) failed, last lines of bench/measure.log:" >&2
         tail -n 40 bench/measure.log >&2 || tail -n 40 bench/measure.stdout >&2
         exit 1
      fi
      [ "$pass" = 1 ] && helper=$(( ($(now) - start) / 100000 ))
   done
   echo "$(cat bench/bench-stat.txt)|$helper"
}

: > "$rows"
grep -ve '^#' -e '^$' bench/cases.txt | while IFS='|' read -r lines label; do
   sample "$lines" > "bench/sample-$lines.R"
   x=$(measure "$lines" xlistings off)
   m=$(measure "$lines" magic-r off)
   d=$(measure "$lines" definitions off)
   f=$(measure "$lines" flowr always)
   avg() { echo "$1" | cut -d'|' -f1; }
   # flowR answered if its answer has facts
   if grep -q '^\\mrFlowBlocks' bench/measure.mr.cfg 2>/dev/null; then
      flowr="$(ms "$(avg "$f")") & $(ms "$(echo "$f" | cut -d'|' -f4)")"
   else
      flowr="n/a & n/a"
   fi
   echo "   $label & $lines & $(ms "$(avg "$x")") & $(ms "$(avg "$m")") & $(ms "$(avg "$d")") & $flowr \\\\" >> "$rows"
done

{
   echo '% written by bench/run.sh, do not edit'
   echo '\begin{tabular}{@{}lrrrrrr@{}}'
   echo '   \toprule'
   echo '   \textbf{Case} & \textbf{Lines} & \textbf{xlistings} & \textbf{magic-r} & \textbf{+ definitions} & \textbf{+ flowR} & \textbf{first run with flowR} \\'
   echo '   \midrule'
   cat "$rows"
   echo '   \bottomrule'
   echo '\end{tabular}'
} > "$out.new"
mv "$out.new" "$out"
rm -f "$rows" bench/bench-stat.txt bench/sample-*.R
for ext in aux log out pdf stdout mr.R mr.cfg; do rm -f "bench/measure.$ext"; done
echo "wrote $out"
