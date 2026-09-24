function main() {
  const user = createUser("Moumen");
  const message = buildMessage(user);
  const result = processMessage(message);

  return result;
}

function createUser(name) {
  return {
    name,
    id: generateId(name),
  };
}

function generateId(name) {
  const normalized = normalizeName(name);
  return normalized.length * 42;
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function buildMessage(user) {
  const greeting = createGreeting(user.name);
  const info = createUserInfo(user);

  return `${greeting} ${info}`;
}

function createGreeting(name) {
  return `Hello, ${name}!`;
}

function createUserInfo(user) {
  return `Your ID is ${user.id}.`;
}

function processMessage(message) {
  const words = splitMessage(message);
  const count = countWords(words);

  return {
    message,
    wordCount: count,
  };
}

function splitMessage(message) {
  return message.split(" ");
}

function countWords(words) {
  let count = 0;

  for (const word of words) {
    if (word.length > 0) {
      count++;
    }
  }

  return count;
}

main();