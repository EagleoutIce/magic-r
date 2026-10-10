-- ghosts.lua: counts the glue of width \spaceskip in a box and all boxes in it.
-- The test sets \spaceskip to 1000pt and typesets code without spaces, so every
-- such glue is a space that a macro of magic-r left in the output.
local GLUE, HLIST, VLIST = node.id("glue"), node.id("hlist"), node.id("vlist")
local function count(head, width)
  local n = 0
  for x in node.traverse(head) do
    if x.id == GLUE and x.width == width then
      n = n + 1
    elseif (x.id == HLIST or x.id == VLIST) and x.head then
      n = n + count(x.head, width)
    end
  end
  return n
end
ghosts = { count = function(box) return count(tex.box[box].head, tex.sp("1000pt")) end }
