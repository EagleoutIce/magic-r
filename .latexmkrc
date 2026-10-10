use Cwd;
@default_files = ('examples/example.tex', 'examples/example-beamer.tex', 'magic-r-doc.tex');
$pdf_mode = 1;
$out_dir = 'build';
$pdflatex = 'pdflatex %O -shell-escape %S';
$clean_ext = 'mr.R mr.cfg mr-eval.R mr-eval.out';
# absolute, as flowR and R run in build/ (and kpsewhich finds magic-r-flowr.mjs there); the empty
# last entry keeps the search path of TeX Live, which TEXINPUTS without it would replace
$ENV{TEXINPUTS} = join($search_path_separator, getcwd(), getcwd() . '/xlistings//', $ENV{TEXINPUTS} // '');
