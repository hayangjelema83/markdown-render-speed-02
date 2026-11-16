// The entrypoint the harness runs: `node /bot/main.ts` on Node 22, which
// strips TypeScript types natively. It reads the whole case set from
// /input/cases.json, renders every case's markdown alone with parse() from
// parse.js, and writes the HTML strings, in the cases' order, to
// /output/html.json. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const rendered = cases.map((c) => parse(c.markdown));
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
