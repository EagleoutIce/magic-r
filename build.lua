#!/usr/bin/env texlua

-- l3build check | tag | ctan | upload | clean
bundle = ""
module = "magic-r"
ctanpkg = module
local tmpdir = os.getenv("TMPDIR")
if tmpdir == nil or tmpdir == "" then tmpdir = os.getenv("TEMP") end
if tmpdir == nil or tmpdir == "" then tmpdir = "/tmp" end
builddir = tmpdir .. "/" .. module

-- the version is the last tag vX.Y, "l3build tag" increments Y
-- no shell syntax beyond redirection, so that it runs in cmd.exe as well
local nullerr = os.type == "windows" and " 2>nul" or " 2>/dev/null"
local function capture(cmd)
    local handle = io.popen(cmd .. nullerr)
    local out = handle:read("*a") or ""
    handle:close()
    return (out:gsub("%s+$", ""))
end
local lasttagged = capture("git rev-list --tags --max-count=1")
local oldtag = lasttagged == "" and "" or capture("git describe --tags " .. lasttagged)
if oldtag == "" then oldtag = "v1.0" end
newsubtag = string.sub(oldtag, 4)
newmajortag = string.sub(oldtag, 0, 3)
if (options["target"] == "tag") then
    newsubtag = newsubtag + 1
end
packageversion = newmajortag .. math.floor(newsubtag)

packagedate = os.date("!%Y-%m-%d")

function git(...)
    local args = {...}
    table.insert(args, 1, 'git')
    local cmd = table.concat(args, ' ')
    print('Executing:', cmd)
    os.execute(cmd)
end

-- stamp the version and date into the .sty and -doc.tex files
tagfiles = {"*.sty", "*-doc.tex"}
function update_tag(file, content, tagname, tagdate)
    tagdate = string.gsub(packagedate, "-", "/")
    if string.match(file, "%.sty$") then
        content = string.gsub(content, "\\ProvidesPackage{(.-)}%[%d%d%d%d%/%d%d%/%d%d version v%d%.%d+",
            "\\ProvidesPackage{%1}[" .. tagdate .. " version " .. packageversion)
        return content
    elseif string.match(file, "%-doc%.tex$") then
        content = string.gsub(content, "\\date{Version v%d%.%d+ \\textendash{} %d%d%d%d%/%d%d%/%d%d",
            "\\date{Version " .. packageversion .. " \\textendash{} " .. tagdate)
        return content
    end
    return content
end

-- commit the retagged files and tag the commit; the release is pushed by hand
function tag_hook(tagname)
    git("add", "*.sty")
    git("add", "*-doc.tex")
    git('commit -m "step version ' .. packageversion .. '"')
    git("tag", packageversion)
end

-- xlistings is a dependency, taken from the submodule
local function copy_xlistings(dir)
    cp("xlistings.sty", "xlistings", dir)
    cp("xlistings-*.cfg", "xlistings/langs", dir)
    return 0
end

typesetfiles = {"magic-r-doc.tex"}
indexstyle = ""  -- the plain style of makeindex, not the one for .dtx files
-- R and flowR answer through shell escape, the runs after read their answers
typesetopts = "-interaction=nonstopmode -shell-escape"
typesetruns = 4
function docinit_hook()
    cp("bench-results.tex", "bench", typesetdir)
    return copy_xlistings(typesetdir)
end

testfiledir = "tests"
testsuppdir = testfiledir .. "/support"
checkengines = {"pdftex"}
checkconfigs = {"build", "config-lua"}  -- config-lua: the tests that need LuaTeX
stdengine = "pdftex"
checkruns = 3  -- definitions and named arguments come from the aux file
function checkinit_hook() return copy_xlistings(testdir) end

textfiles = {"README.md"}
ctanreadme = "README.md"

installfiles = {"magic-r.sty", "magic-r-links.cfg"}
scriptfiles = {"magic-r-flowr.mjs"}
sourcefiles = {"magic-r.sty", "magic-r-links.cfg", "magic-r-flowr.mjs"}
unpackfiles = {}

packtdszip = false
flatten = true

uploadconfig = uploadconfig or {}
uploadconfig = {
    author = uploadconfig.author,
    uploader = uploadconfig.uploader,
    email = uploadconfig.email,
    pkg = ctanpkg,
    version = packageversion .. " " .. packagedate,
    license = "lppl1.3c",
    summary = "R listings for xlistings with documentation links, flowR, and R",
    ctanPath = "/macros/latex/contrib/" .. ctanpkg,
    repository = "https://github.com/EagleoutIce/" .. module,
    home = "https://github.com/EagleoutIce/" .. module,
    note = [[Uploaded automatically by l3build...]],
    bugtracker = "https://github.com/EagleoutIce/" .. module .. "/issues",
    announcement_file = "announcement.txt"
}

cleanfiles = {module .. "-ctan.curlopt", module .. "-ctan.zip"}

-- l3build bench: runs bench/run.sh (flowR for its last columns) and prints the table it wrote
local function bench()
    local status = os.execute("sh bench/run.sh")
    if status ~= true and status ~= 0 then
        print("bench/run.sh failed")
        return 1
    end
    local file = io.open("bench/bench-results.tex", "r")
    if not file then
        print("no bench/bench-results.tex")
        return 1
    end
    local rows = {}
    for line in file:lines() do
        if line:find("&") then
            line = line:gsub("\\qty%s*{([^}]*)}%s*{\\ms%s*}", "%1 ms"):gsub("\\textbf{([^}]*)}", "%1")
            line = line:gsub("%s*\\\\%s*$", ""):gsub("^%s+", "")
            local cells = {}
            for cell in (line .. "&"):gmatch("%s*(.-)%s*&") do table.insert(cells, cell) end
            table.insert(rows, cells)
        end
    end
    file:close()
    local widths = {}
    for _, row in ipairs(rows) do
        for i, cell in ipairs(row) do widths[i] = math.max(widths[i] or 0, #cell) end
    end
    for r, row in ipairs(rows) do
        local out = {}
        for i, cell in ipairs(row) do
            out[i] = i == 1 and cell .. string.rep(" ", widths[i] - #cell) or string.rep(" ", widths[i] - #cell) .. cell
        end
        print(table.concat(out, "  "))
        if r == 1 then print(string.rep("-", #table.concat(out, "  "))) end
    end
    return 0
end
target_list = target_list or {}
target_list.bench = { func = bench, desc = "Runs the benchmark and prints its table" }
