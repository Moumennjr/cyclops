import re
p = "src/public/app.js"
s = open(p).read()

starts = [m.start() for m in re.finditer(r"export function toFlowModel\(", s)]
assert len(starts) == 2, f"expected 2 toFlowModel decls, found {len(starts)}"

first = starts[0]
second = starts[1]

# Delete the FIRST declaration (older byId-only variant) entirely,
# keeping the layout-aware one at `second`.
s = s[:first] + s[second:]

open(p, "w").write(s)
remaining = len(re.findall(r"export function toFlowModel\(", s))
print("remaining toFlowModel decls:", remaining)
assert remaining == 1
