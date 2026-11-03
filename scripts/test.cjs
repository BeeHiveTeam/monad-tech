const fs = require('node:fs');
const path = require('node:path');
for (const name of fs.readdirSync(path.join(__dirname, '../tests')).filter(n => n.endsWith('.test.cjs')).sort()) {
  require(path.join(__dirname, '../tests', name));
}
