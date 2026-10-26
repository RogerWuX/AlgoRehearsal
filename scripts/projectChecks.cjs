const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const respond = (output = {}) => process.stdout.write(`${JSON.stringify(output)}\n`);

async function git(root, args) {
  const { stdout } = await execute('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function fingerprint(root) {
  const files = [...new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');

  for (const file of files) {
    const filename = path.join(root, file);
    let entry;
    try {
      const stat = fs.lstatSync(filename);
      const content = stat.isSymbolicLink() ? fs.readlinkSync(filename) : fs.readFileSync(filename);
      entry = [file, stat.mode & 0o111, stat.isSymbolicLink() ? 'link' : 'file', hash(content)];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entry = [file, 'missing'];
    }
    digest.update(`${JSON.stringify(entry)}\n`);
  }
  return digest.digest('hex');
}

function snapshotPath(root, input) {
  if (!input.session_id || !input.turn_id) return null;
  const directory = path.join(os.tmpdir(), `project-checks-${hash(root)}`);
  const key = hash(JSON.stringify([input.session_id, input.turn_id]));
  return path.join(directory, `${key}.txt`);
}

async function snapshot(root, input) {
  const filename = snapshotPath(root, input);
  if (!filename) throw new Error('Missing session or turn ID.');
  const digest = await fingerprint(root);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filename, digest, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Additional input during a turn must not replace its starting snapshot.
    if (error.code !== 'EEXIST') throw error;
  }
}

async function changed(root, input) {
  const filename = snapshotPath(root, input);
  if (!filename) return true;
  let before;
  try {
    before = fs.readFileSync(filename, 'utf8');
  } catch {
    return true;
  }
  if (!/^[a-f0-9]{64}$/.test(before)) return true;
  try {
    return before !== (await fingerprint(root));
  } catch {
    // An uncertain snapshot must not silently skip validation.
    return true;
  }
}

function cleanupSnapshot(root, input) {
  const filename = snapshotPath(root, input);
  if (!filename) return;
  try {
    fs.unlinkSync(filename);
  } catch {
    // Cleanup is best effort and must not prevent validation.
  }
}

async function runChecks(root, commands) {
  const deadline = Date.now() + 570000;
  const failures = [];
  for (const args of commands) {
    try {
      await execute('npm', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const details = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
      failures.push(`npm ${args.join(' ')} failed (${error.signal || error.code || 'execution error'}):\n${details.slice(-10000)}`);
    }
  }
  return failures;
}

function reportFailure(input, reason) {
  if (input.hook_event_name === 'Stop' && input.stop_hook_active === true) {
    respond({ systemMessage: `Validation still failed after the automatic retry.\n${reason}` });
    return;
  }
  const instruction = input.permission_mode === 'plan'
    ? 'Include these failures and the proposed fixes in the plan. Do not edit repository files in Plan mode.'
    : 'Fix these failures before finishing. The project hooks will rerun the checks automatically.';
  respond({ decision: 'block', reason: `${reason}\n\n${instruction}` });
}

async function main(input) {
  const event = input.hook_event_name;
  if (!['UserPromptSubmit', 'Stop'].includes(event)) {
    throw new Error(`Unsupported hook event: ${event}`);
  }
  const root = (await git(input.cwd || process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
  if (event === 'UserPromptSubmit') {
    await snapshot(root, input);
    respond();
    return;
  }
  let shouldCheck;
  try {
    const dirty = Boolean(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    // Stop-hook continuations can receive a fresh starting snapshot. Retry the
    // failed checks even if that snapshot now matches the dirty working tree.
    shouldCheck = dirty && (input.stop_hook_active === true || await changed(root, input));
  } finally {
    cleanupSnapshot(root, input);
  }
  if (!shouldCheck) {
    respond();
    return;
  }
  const commands = [['run', 'lint'], ['run', 'typecheck'], ['test']];
  const failures = await runChecks(root, commands);
  if (failures.length) {
    reportFailure(input, failures.join('\n\n'));
  } else {
    respond();
  }
}

async function run() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
    await main(input);
  } catch (error) {
    const reason = `Project validation could not complete: ${error.message}`;
    if (!input) {
      respond({ systemMessage: reason });
      process.exitCode = 1;
    } else if (input.hook_event_name === 'UserPromptSubmit') {
      respond({ systemMessage: `${reason} Checks will run conservatively at agent stop if Git has changes.` });
    } else {
      reportFailure(input, reason);
    }
  }
}

run();
