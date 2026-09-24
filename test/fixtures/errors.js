function inner() {
  throw new Error("boom");
}

function outer() {
  inner();
}

outer();