const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function add(a, b) {
  return a + b;
}

async function load(id) {
  await sleep(10);
  return { id, total: id * 2 };
}

async function main() {
  const results = await Promise.all([load(1), load(2)]);
  let sum = 0;
  for await (const r of results) sum = add(sum, r.total);
  return sum;
}

main().then((total) => console.log("total =", total));
