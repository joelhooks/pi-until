"""Zero-model-call interactive Pi proof. No operator settings or sessions.
Run: python3 tests/live-restart.py /absolute/path/to/pi/dist/cli.js [output-directory]
Uses Python's standard-library PTY support (macOS/Linux), not real Herdr panes.
"""
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import sys
import tempfile
import time
import uuid

CLI = str(pathlib.Path(sys.argv[1]).resolve())
ROOT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="until-pty-"))
ROOT.mkdir(parents=True, exist_ok=True)
REPO = pathlib.Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
assert NODE
FIXTURE = ROOT / "fixture.ts"
FIXTURE.write_text("""
import { writeFileSync, appendFileSync } from 'node:fs';
import piUntil from IMPORT;
export default function(pi) {
  let execute;
  const output = process.env.PROOF_OUTPUT;
  const save = async (ctx, suffix) => {
    const result = await execute('fixture', {action:'list'}, undefined, undefined, ctx);
    writeFileSync(output+suffix, JSON.stringify({result, entries:ctx.sessionManager.getBranch(), id:ctx.sessionManager.getSessionId(), session:ctx.sessionManager.getSessionFile()}));
  };
  piUntil({...pi, registerTool(t) { execute=t.execute; pi.registerTool(t); }});
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.PROOF_ROLE === 'parent') {
      await execute('fixture', {action:'start',condition:process.env.PROOF_CASE==='graceful-check' ? 'sleep 30' : 'exit 1', intervalSeconds:300, timeoutSeconds:3600, label:'PTY fixture'}, undefined, undefined, ctx);
      setTimeout(async () => {
        await save(ctx, '.ready');
        if (process.env.PROOF_CASE.startsWith('graceful')) setTimeout(()=>ctx.shutdown(), 700);
        if (process.env.PROOF_CASE==='exit') setTimeout(()=>process.exit(129), 700);
      }, 100);
    } else {
      pi.events.on('pi-until:watches', () => { void save(ctx, '.state'); });
      await save(ctx, '.ready');
    }
  });
  pi.on('before_provider_request', () => { throw new Error('No model calls allowed in this fixture'); });
  pi.on('agent_start', () => appendFileSync(output+'.model-calls', 'unexpected\\n'));
}
""".replace("IMPORT", json.dumps(str(REPO / "extensions/pi-until.ts"))))


class Child:
    def __init__(self, folder, name, args, env):
        self.output = folder / name
        self.log = bytearray()
        self.status = None
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(folder)
            os.execve(NODE, [NODE, CLI, *args, '--no-extensions', '--no-mcp', '--no-skills',
                            '--no-prompt-templates', '--no-themes', '-e', str(FIXTURE), '--approve'],
                      {'HOME': str(folder / 'home'), 'PATH': os.environ['PATH'],
                       'TERM': 'xterm-256color', 'PI_UNTIL_TELEMETRY': '0',
                       'PROOF_OUTPUT': str(self.output), **env})
        # Do not let later successors inherit a predecessor's PTY master.
        # That would keep its terminal alive after this harness closes it.
        os.set_inheritable(fd, False)
        self.pid, self.fd = pid, fd

    def pump(self):
        if self.fd is not None:
            readable, _, _ = select.select([self.fd], [], [], 0.02)
            if readable:
                try:
                    self.log.extend(os.read(self.fd, 65536))
                except OSError:
                    os.close(self.fd)
                    self.fd = None
        if self.status is None:
            done, status = os.waitpid(self.pid, os.WNOHANG)
            if done:
                self.status = status
                self.output.with_suffix('.terminal.log').write_bytes(self.log)

    def ready(self):
        path = pathlib.Path(str(self.output) + '.ready')
        return json.loads(path.read_text()) if path.exists() else None

    def stop(self, sig=signal.SIGTERM):
        if self.status is None:
            os.kill(self.pid, sig)

    def close_terminal(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


CHILDREN = []


def wait(predicate, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for child in CHILDREN:
            child.pump()
        result = predicate()
        if result:
            return result
    raise AssertionError('PTY fixture timed out; artifacts: ' + str(ROOT))


def entries(path):
    return [json.loads(line) for line in pathlib.Path(path).read_text().splitlines()]


def custom(rows, kind):
    return [row for row in rows if row.get('customType') == kind]


def run_case(kind):
    folder = ROOT / kind
    folder.mkdir()
    (folder / 'home').mkdir()
    parent_id = str(uuid.uuid4())
    seed = folder / 'seed.jsonl'
    timestamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    seed.write_text('\n'.join(json.dumps(row) for row in [
        {'type': 'session', 'version': 3, 'id': parent_id, 'cwd': str(folder), 'timestamp': timestamp},
        {'type': 'message', 'id': 'seed', 'parentId': None, 'timestamp': timestamp,
         'message': {'role': 'user', 'content': 'Isolated inert fixture', 'timestamp': int(time.time()*1000)}}]) + '\n')
    parent = Child(folder, 'parent', ['--session', str(seed)], {'PROOF_ROLE': 'parent', 'PROOF_CASE': kind})
    CHILDREN.append(parent)
    armed = wait(parent.ready)
    original = armed['result']['details']['watches'][0]
    snapshot = folder / 'fork.jsonl'
    shutil.copyfile(armed['session'], snapshot)
    successors = []
    for name in ['successor', 'competitor']:
        successor_id = str(uuid.uuid4())
        child = Child(folder, name, ['--fork', str(snapshot), '--session-id', successor_id], {
            'PROOF_ROLE': 'successor', 'PI_UNTIL_SUCCEEDS': parent_id,
            'PI_UNTIL_SUCCESSOR_ID': successor_id})
        CHILDREN.append(child)
        successors.append(child)
    if kind == 'hangup':
        parent.close_terminal()
    elif kind in ['hup', 'term']:
        parent.stop(signal.SIGHUP if kind == 'hup' else signal.SIGTERM)
    wait(lambda: parent.status is not None)
    parent_rows = entries(armed['session'])
    suspended = custom(parent_rows, 'pi-until-suspended')
    assert len(suspended) == 1, (kind, 'missing or duplicate parent suspension', suspended)
    assert suspended[0]['data']['watches'][0]['facts']['id'] == original['id']

    def adopted():
        for child in successors:
            state = pathlib.Path(str(child.output) + '.state')
            if state.exists():
                view = json.loads(state.read_text())
                if len(view['result']['details']['watches']) == 1:
                    return child, view
        return None

    winner, restored = wait(adopted)
    watch = restored['result']['details']['watches'][0]
    assert watch['id'] == original['id']
    assert watch['startedAt'] == original['startedAt']
    assert watch['expiresAt'] == original['expiresAt']
    for child in successors:
        wait(child.ready)
        child.stop()
    wait(lambda: all(child.status is not None for child in successors))
    resumed = sum(len(custom(entries(child.ready()['session']), 'pi-until-resumed')) for child in successors)
    assert resumed == 1, (kind, 'duplicate adoption', resumed)
    assert not list(folder.glob('*.model-calls')), 'Fixture called a model'
    return {'case': kind, 'parentExit': os.waitstatus_to_exitcode(parent.status),
            'suspensions': len(suspended), 'adoptions': resumed, 'watchId': original['id'],
            'winner': winner.output.name, 'paidCalls': 0}


try:
    proof = [run_case(kind) for kind in ['graceful', 'graceful-check', 'hangup', 'hup', 'term', 'exit']]
    (ROOT / 'proof.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps({'root': str(ROOT), 'proof': proof}, indent=2))
finally:
    for child in CHILDREN:
        if child.status is None:
            child.stop(signal.SIGKILL)
            os.waitpid(child.pid, 0)
        child.close_terminal()
