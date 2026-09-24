function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

function double(x) {
  return x * 2;
}

function greet(user) {
  return `hi ${user.name}`;
}

const user = { name: "ada", tags: ["math", "pioneer"] };
user.self = user;

console.log("fib(5) =", fib(5));
console.log("double(21) =", double(21));
console.log(greet(user));