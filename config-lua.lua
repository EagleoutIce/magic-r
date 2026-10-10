-- The tests that need LuaTeX: they read the nodes of what magic-r typesets.
testfiledir = "tests/lua"
-- the support files of the other tests (l3build replaces exactly "tests/support" with "tests/lua/support")
testsuppdir = "./tests/support"
checkengines = {"luatex"}
stdengine = "luatex"
