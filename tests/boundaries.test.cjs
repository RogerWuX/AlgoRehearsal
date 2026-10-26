const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

test('library adapters never import agent, selection, judgment, or session policy', () => {
  const root = path.resolve(__dirname, '../src/features/interview');
  for (const file of files(path.join(root, 'adapters'))) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      assert.ok(!specifier.endsWith('.md'), `${path.relative(root, file)} imports a Markdown prompt`);
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
      assert.ok(!/(?:^|[/\\])(agents|selection|judgment|session)(?:[/\\]|$)/.test(resolved), `${path.relative(root, file)} imports ${specifier}`);
    }
  }
});

test('generic thinking contracts contain no domain imports and each task has one agent construction', () => {
  const root = path.resolve(__dirname, '../src/features/interview');
  const contracts = readFileSync(path.join(root, 'llm/types.ts'), 'utf8');
  assert.doesNotMatch(contracts, /from ['"][^'"]*(?:model\/|judgment\/|selection\/|session\/)/);
  for (const feature of ['selection', 'judgment']) {
    const calls = files(path.join(root, 'agents', feature)).flatMap(file => readFileSync(file, 'utf8').match(/\bcreateAgent\s*\(/g) ?? []);
    assert.equal(calls.length, 1, `${feature} must build a single shared agent`);
  }
});

test('session delegates problem acquisition and persistence to the selector contract', () => {
  const root = path.resolve(__dirname, '../src/features/interview');
  const source = readFileSync(path.join(root, 'session/InterviewSession.ts'), 'utf8');
  const ports = readFileSync(path.join(root, 'session/ports.ts'), 'utf8');
  const composition = readFileSync(path.join(root, 'hooks/useInterviewSession.web.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*(?:agents\/|storage\/problemStorage)/);
  assert.doesNotMatch(source, /\bgenerateRandomNumber\b/);
  assert.doesNotMatch(source, /dependencies\.(?:problems|loadInstructions|selectProblem)\b/);
  assert.doesNotMatch(source, /=== ['"](?:stored|agent)['"]/);
  assert.doesNotMatch(ports, /\b(?:ProblemRepository|loadInstructions|selectProblem)\b/);
  assert.doesNotMatch(composition, /['"][^'"]*agents\/selection\//);
});

test('session delegates grading to the judgment workflow without owning model or phase policy', () => {
  const root = path.resolve(__dirname, '../src/features/interview');
  const source = readFileSync(path.join(root, 'session/InterviewSession.ts'), 'utf8');
  const ports = readFileSync(path.join(root, 'session/ports.ts'), 'utf8');
  const composition = readFileSync(path.join(root, 'hooks/useInterviewSession.web.ts'), 'utf8');
  assert.doesNotMatch(source, /dependencies\.(?:thinking|judge)\b|validateAssessment|JUDGMENT_TIMEOUT_MS|judgmentOperation/);
  assert.doesNotMatch(ports, /\b(?:ThinkingRuntime|ThinkingModel|Assessment|JudgmentRequest)\b/);
  assert.doesNotMatch(composition, /['"][^'"]*agents\/judgment\//);
  for (const file of files(path.join(root, 'judgment'))) {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s*['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
      assert.ok(!/(?:^|[/\\])(?:session|storage|hooks|adapters)(?:[/\\]|$)/.test(resolved), `${path.relative(root, file)} imports ${specifier}`);
    }
  }
});
