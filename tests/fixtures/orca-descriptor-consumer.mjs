const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1_048_576) process.exit(2);
  chunks.push(chunk);
}
if (!process.env.ORCA_PANE_KEY) process.exit(2);
const bytes = Buffer.concat(chunks);
JSON.parse(bytes.toString('utf8'));
process.stdout.write(bytes);
