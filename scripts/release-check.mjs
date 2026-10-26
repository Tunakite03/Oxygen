import { readFileSync, existsSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!pkg.license || pkg.license === 'UNLICENSED' || !existsSync(new URL('../LICENSE', import.meta.url))) {
  throw new Error('Public release blocked: the owner has not selected a license. Set the approved SPDX license and add its LICENSE text before publishing.');
}
if (pkg.private) throw new Error('Public release blocked: private must only be removed after the owner approves public distribution.');
if (!pkg.repository?.url || !pkg.exports?.['.']?.types || !pkg.exports?.['./physics']) throw new Error('Release metadata or entry points are incomplete');
console.log('Release contract validated');
