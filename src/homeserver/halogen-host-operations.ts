/** Linux-only operator adapter for the explicitly approved #317 synthetic window. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readlink, stat, lstat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { HALOGEN_PILOT_PROFILE, halogenProfileHash } from './halogen-profile.js';
import { buildHalogenLaunch, HALOGEN_MEMORY_BYTES, verifyHalogenHealth } from './halogen-runtime-plan.js';
import { parseGatewayBaseUrl } from './halogen-gateway-url.js';
import type { HalogenEvaluationOperations } from './halogen-evaluation.js';

const exec = promisify(execFile);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().regex(/^\//).refine(p => !p.split('/').includes('..') && !/[\0\r\n]/.test(p));
export const halogenHostPlanSchema = z.object({
  schemaVersion: z.literal(1), runnerCommit: z.string().regex(/^[a-f0-9]{40}$/),
  expiresAt: z.string().datetime(), profileSha256: z.literal(halogenProfileHash(HALOGEN_PILOT_PROFILE)),
  name: z.string().regex(/^gille-317-halogen-[0-9]{2}$/),
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  gatewayBaseUrl: z.string().refine((value) => {
    try { parseGatewayBaseUrl(value); return true; }
    catch { return false; }
  }, 'approved local gateway address required (http://<this-box>:<port>, checked against this machine)'),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/), group: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  uid: z.number().int().positive(),
  protectedUnits: z.array(z.string().regex(/^[a-zA-Z0-9_.@-]+\.service$/)).min(2),
  qualificationSha256: hex,
  expectedResidentModels: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)).max(1),
  prior: z.object({
    pid: z.number().int().positive(), startTicks: z.string().regex(/^[0-9]+$/),
    argv: z.array(z.string().refine(s => !s.includes('\0'))).min(3), cwd: absolute,
    executableSha256: hex, modelPath: absolute, modelBytes: z.number().int().positive(),
    modelMtimeMs: z.number().positive(),
    restoreName: z.string().regex(/^gille-317-prior-[0-9]{2}$/),
  }).strict(),
}).strict();
export type HalogenHostPlan = z.infer<typeof halogenHostPlanSchema>;

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function properties(text: string): Record<string, string> {
  return Object.fromEntries(text.trim().split('\n').map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function createHalogenHostOperations(input: unknown): HalogenEvaluationOperations {
  const p = halogenHostPlanSchema.parse(input);
  const home = `/home/${p.user}`;
  const root = `${home}/halogen-eval-317`;
  const release = `${root}/releases/${p.runnerCommit}`;
  const artifactDirectory = `${root}/staging/${HALOGEN_PILOT_PROFILE.modelRevision}`;
  const launch = buildHalogenLaunch(HALOGEN_PILOT_PROFILE, { name: p.name, runId: p.runId, user: p.user,
    group: p.group, uid: p.uid, homeDirectory: home, artifactDirectory });
  const childEnv = { PATH: '/usr/bin:/bin', HOME: home, USER: p.user, LOGNAME: p.user,
    XDG_RUNTIME_DIR: `/run/user/${p.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${p.uid}/bus` };
  let baseline: Record<string, Record<string, string>> = {};
  let baselineOom = '';
  let qualificationSource = '';
  let candidateStartedAt = 0;
  let priorWasStopped = false;
  let priorRestoredPid = p.prior.pid;

  async function command(executable: string, args: string[], timeout = 30_000, signal?: AbortSignal, inputText?: string): Promise<string> {
    // execFile has no stdin option; the only stdin user is fixed Python source via an isolated pipe.
    if (inputText !== undefined) {
      const { spawn } = await import('node:child_process');
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(executable, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
        let stdout = '', stderr = '', oversized = false;
        const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
          if (stdout.length + stderr.length + chunk.length > 1024 * 1024) { oversized = true; child.kill('SIGKILL'); return; }
          if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        };
        child.stdout.on('data', (c: Buffer) => append('stdout', c));
        child.stderr.on('data', (c: Buffer) => append('stderr', c));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
          clearTimeout(timer);
          if (code === 0 && !oversized) resolve(stdout);
          else reject(new Error(`operator command failed (${code}): ${stderr.slice(0, 1000)}`));
        });
        child.stdin.on('error', () => { /* close/error above preserves the command failure */ });
        child.stdin.end(inputText);
      });
    }
    return (await exec(executable, args, { env: childEnv, timeout, maxBuffer: 1024 * 1024, signal })).stdout;
  }
  async function systemProperties(unit: string): Promise<Record<string, string>> {
    return properties(await command('/usr/bin/systemctl', ['show', unit,
      '-p', 'Description,LoadState,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestampMonotonic,ControlGroup,MemoryMax,MemorySwapMax,OOMPolicy,KillMode,TasksMax,RuntimeMaxUSec,User,Group,LimitMEMLOCK,Result']));
  }
  async function oomCount(): Promise<string> {
    const value = (await readFile('/proc/vmstat', 'utf8')).match(/^oom_kill (\d+)$/m)?.[1];
    if (value === undefined) throw new Error('cannot observe host OOM counter');
    return value;
  }
  async function availableMemory(): Promise<number> {
    const available = Number((await readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]) * 1024;
    if (!Number.isFinite(available)) throw new Error('cannot observe available memory');
    return available;
  }
  async function protectedUnchanged(): Promise<void> {
    for (const unit of p.protectedUnits) {
      const current = await systemProperties(unit);
      for (const key of ['ActiveState', 'MainPID', 'NRestarts', 'ActiveEnterTimestampMonotonic']) {
        if (current[key] !== baseline[unit]?.[key]) throw new Error(`protected service changed: ${unit}/${key}`);
      }
    }
    if (await availableMemory() < 12 * 1024 ** 3) throw new Error('host memory reserve breached');
    if (await oomCount() !== baselineOom) throw new Error('host OOM counter changed; stop the envelope');
  }
  async function assertGpuUsers(allowPrior: boolean, allowSwap: boolean, allowCandidate: boolean): Promise<void> {
    // fuser needs host visibility; an empty result is exit 1, while diagnostics fail closed.
    let stdout: string;
    try {
      stdout = await command('/usr/bin/sudo', ['-n', '/usr/bin/fuser', '/dev/kfd', '/dev/dri/renderD128']);
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      if (failure.code !== 1 || failure.stdout?.trim() || failure.stderr?.trim()) throw error;
      stdout = '';
    }
    if (!/^[\s0-9]*$/.test(stdout)) throw new Error('unrecognized GPU client inventory');
    const pids = [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
    for (const pid of pids) {
      let group: string;
      try { group = await readFile(`/proc/${pid}/cgroup`, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (allowPrior && pid === p.prior.pid) { await priorIdentity(pid); continue; }
      if (allowSwap && group === '0::/system.slice/llama-swap.service\n') continue;
      if (allowCandidate && group === `0::/system.slice/${launch.unit}\n`) continue;
      const protectedGpuUnit = p.protectedUnits.find(unit => unit !== 'llama-swap.service'
        && unit !== 'home-gateway.service' && group === `0::/system.slice/${unit}\n`);
      if (!protectedGpuUnit) throw new Error(`unexpected GPU client: ${pid}`);
    }
  }
  async function localJson(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:8091${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path === '/v1/chat/completions' ? 300_000 : 15_000),
    });
    if (!response.ok) throw new Error(`swap ${path} HTTP ${response.status}`);
    if (path === '/api/models/unload') { await response.arrayBuffer(); return null; }
    return await response.json();
  }
  async function running(): Promise<Array<{ model: string }>> {
    return z.object({ running: z.array(z.object({ model: z.string() })) }).parse(await localJson('/running')).running;
  }
  async function candidateInspect(): Promise<Record<string, any> | null> {
    const exists = await command('/usr/bin/podman', ['ps', '-a', '--filter', `name=^${p.name}$`, '--format', '{{.Names}}']);
    if (exists.trim() === '') return null;
    if (exists.trim() !== p.name) throw new Error('ambiguous container identity');
    return JSON.parse(await command('/usr/bin/podman', ['inspect', p.name]))[0];
  }
  async function priorIdentity(pid: number): Promise<void> {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = statText.slice(statText.lastIndexOf(') ') + 2).split(' ');
    if (pid === p.prior.pid && fields[19] !== p.prior.startTicks) throw new Error('prior process identity changed');
    if (JSON.stringify(argv) !== JSON.stringify(p.prior.argv)
      || await readlink(`/proc/${pid}/cwd`) !== p.prior.cwd
      || await readlink(`/proc/${pid}/exe`) !== p.prior.argv[0]) throw new Error('prior launch identity changed');
  }
  function priorHealthUrl(): string {
    const host = p.prior.argv[p.prior.argv.indexOf('--host') + 1];
    const port = p.prior.argv[p.prior.argv.indexOf('--port') + 1];
    const localAddresses = Object.values(networkInterfaces()).flatMap(v => v ?? []).map(v => v.address);
    if (!host || !localAddresses.includes(host) || port !== '18099') throw new Error('prior health must target the approved local listener');
    return `http://${host}:18099/health`;
  }
  async function priorHealthy(): Promise<void> {
    await priorIdentity(priorRestoredPid);
    const response = await fetch(priorHealthUrl(), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('prior experiment health failed');
  }

  return {
    async preflight() {
      if (process.platform !== 'linux' || process.getuid?.() !== p.uid) throw new Error('wrong execution host identity');
      const passwd = (await readFile('/etc/passwd', 'utf8')).split('\n').find(line => line.startsWith(p.user + ':'))?.split(':');
      const group = (await readFile('/etc/group', 'utf8')).split('\n').find(line => line.startsWith(p.group + ':'))?.split(':');
      if (p.user === 'root' || p.group === 'root' || Number(passwd?.[2]) !== p.uid || passwd?.[5] !== home
        || Number(group?.[2]) !== process.getgid?.() || Number(passwd?.[3]) !== Number(group?.[2])) throw new Error('unprivileged account mapping mismatch');
      if (Date.parse(p.expiresAt) - Date.now() < 3700_000) throw new Error('insufficient approved time remaining');
      if (!p.protectedUnits.includes('home-gateway.service') || !p.protectedUnits.includes('llama-swap.service')
        || new Set(p.protectedUnits).size !== p.protectedUnits.length) throw new Error('protected service set incomplete');
      for (let path = artifactDirectory; path !== '/'; path = dirname(path)) {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('artifact path contains symlink');
      }
      if ((await stat(artifactDirectory)).uid !== p.uid) throw new Error('artifact owner mismatch');
      for (const name of [launch.unit, `${p.prior.restoreName}.service`]) {
        if ((await systemProperties(name)).LoadState !== 'not-found') throw new Error('evaluation unit already exists');
      }
      if (await candidateInspect() !== null) throw new Error('evaluation container already exists');
      const digest = (await command('/usr/bin/podman', ['image', 'inspect', HALOGEN_PILOT_PROFILE.image, '--format', '{{.Digest}}'])).trim();
      if (digest !== HALOGEN_PILOT_PROFILE.image.split('@')[1]) throw new Error('image digest mismatch');
      if (p.prior.argv[0]?.split('/').at(-1) !== 'llama-server'
        || p.prior.argv[p.prior.argv.indexOf('-m') + 1] !== p.prior.modelPath) throw new Error('unexpected prior executable/model');
      for (const [name, expected] of Object.entries({ 'stage-halogen.py': 'fff0a42b578148c4b0e515ab74d81c0bcd921d60476be1fe0497cc8e075e1b42', 'halogen-candidate.json': '216a59c2262d5080fb7217f74ef064b08e10976a72597c1a216c7fa43d9b2284' })) {
        if (await fileSha256(`${release}/${name}`) !== expected) throw new Error('staging verifier identity mismatch');
      }
      await command('/usr/bin/python3', [`${release}/stage-halogen.py`, '--manifest', `${release}/halogen-candidate.json`, '--directory', `${root}/staging`, '--verify'], 1800_000);
      await priorIdentity(p.prior.pid);
      if (await fileSha256(p.prior.argv[0]!) !== p.prior.executableSha256) throw new Error('prior binary mismatch');
      const model = await stat(p.prior.modelPath);
      if (model.size !== p.prior.modelBytes || Math.abs(model.mtimeMs - p.prior.modelMtimeMs) > 1) throw new Error('prior artifact identity changed');
      qualificationSource = await readFile(`${release}/qualify-halogen.py`, 'utf8');
      if (createHash('sha256').update(qualificationSource).digest('hex') !== p.qualificationSha256) throw new Error('qualification source mismatch');
      await priorHealthy();
      for (const unit of p.protectedUnits) {
        baseline[unit] = await systemProperties(unit);
        if (baseline[unit]!.ActiveState !== 'active') throw new Error(`protected service not active: ${unit}`);
      }
      baselineOom = await oomCount();
      await assertGpuUsers(true, true, false);
      if (Date.parse(p.expiresAt) - Date.now() < 3700_000) throw new Error('approved time exhausted by preflight');
    },
    async stopPriorExperiment() {
      await priorIdentity(p.prior.pid);
      // pidfd binds the signal to this process even if a PID is recycled after the check.
      const code = `import os,signal,sys\npid=int(sys.argv[1]); fd=os.pidfd_open(pid)\nstart=open('/proc/%d/stat'%pid).read().rsplit(') ',1)[1].split()[19]\nif start!=sys.argv[2]: raise RuntimeError('prior start changed')\nsignal.pidfd_send_signal(fd,signal.SIGTERM)\nos.close(fd)\n`;
      priorWasStopped = true;
      await command('/usr/bin/python3', ['-I', '-c', code, String(p.prior.pid), p.prior.startTicks]);
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try { await stat(`/proc/${p.prior.pid}`); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        await pause(250);
      }
      throw new Error('prior process did not exit after TERM');
    },
    async quiesceSwap() {
      await localJson('/api/models/unload', {});
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) { if ((await running()).length === 0) return; await pause(250); }
      throw new Error('swap did not quiesce');
    },
    async assertHeadroom() {
      await protectedUnchanged();
      await assertGpuUsers(false, false, false);
      const available = await availableMemory();
      if (!Number.isFinite(available) || available < HALOGEN_MEMORY_BYTES + 12 * 1024 ** 3) throw new Error('insufficient RAM including 12GiB reserve');
    },
    async startCandidate() {
      if (Date.parse(p.expiresAt) - Date.now() < 2400_000) throw new Error('insufficient approved time for candidate and cleanup');
      candidateStartedAt = Date.now();
      await command(launch.command, launch.args);
    },
    async verifyContainment() {
      const s = await systemProperties(launch.unit);
      if (s.Description !== `gille-317-halogen/${p.runId}`) throw new Error('unit ownership mismatch');
      for (const [key, value] of Object.entries({ MemoryMax: String(HALOGEN_MEMORY_BYTES), MemorySwapMax: '0',
        OOMPolicy: 'kill', KillMode: 'control-group', TasksMax: '512', User: p.user, Group: p.group,
        LimitMEMLOCK: String(HALOGEN_MEMORY_BYTES) })) {
        if (s[key] !== value) throw new Error(`effective unit limit mismatch: ${key}`);
      }
      if (!['30min', '1800s', '1800000000'].includes(s.RuntimeMaxUSec ?? '')) throw new Error('unit hard deadline mismatch');
      if (s.ControlGroup !== `/system.slice/${launch.unit}`) throw new Error('unexpected unit cgroup');
      for (const [file, expected] of Object.entries({ 'memory.max': String(HALOGEN_MEMORY_BYTES),
        'memory.swap.max': '0', 'pids.max': '512', 'memory.oom.group': '1' })) {
        if ((await readFile(`/sys/fs/cgroup${s.ControlGroup}/${file}`, 'utf8')).trim() !== expected) throw new Error(`kernel limit mismatch: ${file}`);
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const c = await candidateInspect();
        if (c && c.State?.Pid > 0) {
          if (c.Config?.Labels?.['gille-inference.run-id'] !== p.runId) throw new Error('container ownership mismatch');
          if (c.HostConfig?.NetworkMode !== 'none' || c.HostConfig?.ReadonlyRootfs !== true) throw new Error('container network/rootfs isolation mismatch');
          const devices = c.HostConfig?.Devices;
          const expectedDevices = ['/dev/dri/renderD128', '/dev/kfd'];
          if (!Array.isArray(devices) || devices.length !== 2
            || JSON.stringify(devices.map((d: any) => d.PathOnHost).sort()) !== JSON.stringify(expectedDevices)
            || devices.some((d: any) => d.PathOnHost !== d.PathInContainer)) throw new Error('GPU device mapping mismatch');
          const group = await readFile(`/proc/${c.State.Pid}/cgroup`, 'utf8');
          if (!group.includes(`/${launch.unit}\n`)) throw new Error('candidate escaped bounded unit cgroup');
          const status = await readFile(`/proc/${c.State.Pid}/status`, 'utf8');
          if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status)) throw new Error('process privilege restriction mismatch');
          const mount = c.Mounts?.find((m: any) => m.Destination === '/models');
          if (!mount || mount.Source !== artifactDirectory || mount.RW !== false) throw new Error('model mount mismatch');
          return;
        }
        await pause(250);
      }
      throw new Error('candidate process not observable');
    },
    async waitForReady(signal) {
      const deadline = Date.now() + 600_000;
      const source = "import json,urllib.request\nprint(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8731/health',timeout=5))))\n";
      let lastError: unknown;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        await protectedUnchanged();
        await assertGpuUsers(false, false, true);
        if ((await candidateInspect())?.State?.Running !== true) throw new Error('candidate exited during startup');
        try {
          const health = JSON.parse(await command('/usr/bin/podman', ['exec', '-i', p.name, 'python3', '-'], 10_000, signal, source));
          const errors = verifyHalogenHealth(HALOGEN_PILOT_PROFILE, health);
          if (errors.length === 0) return;
          lastError = new Error(errors.join(','));
        } catch (error) { lastError = error; }
        await pause(3000);
      }
      throw new Error('candidate readiness failed', { cause: lastError });
    },
    async compatibility(signal) {
      const remaining = Math.min(1800_000 - (Date.now() - candidateStartedAt) - 30_000,
        Date.parse(p.expiresAt) - Date.now() - 600_000);
      if (remaining <= 0) throw new Error('candidate work deadline expired');
      const abort = new AbortController();
      const guardedSignal = AbortSignal.any([signal, abort.signal]);
      let done = false;
      let monitorError: unknown;
      const monitor = (async () => {
        while (!done) { await pause(2000); if (!done) { await protectedUnchanged(); await assertGpuUsers(false, false, true); } }
      })().catch(error => { monitorError = error; abort.abort(error); });
      let text: string;
      try {
        text = await command('/usr/bin/podman', ['exec', '-i', p.name, 'python3', '-',
          '--profile-sha256', p.profileSha256, '--runner-commit', p.runnerCommit], remaining, guardedSignal, qualificationSource);
      } catch (error) { throw monitorError ?? error; }
      finally { done = true; await monitor; }
      if (monitorError !== undefined) throw monitorError;
      const result = JSON.parse(text);
      if (result.profileSha256 !== p.profileSha256 || result.runnerCommit !== p.runnerCommit) throw new Error('qualification identity mismatch');
      await protectedUnchanged();
      return result;
    },
    async ensureCandidateStopped() {
      // Unit and container deadlines are independent. A failed cgroup check must not
      // make cleanup rely solely on the unit that the container may have escaped.
      let lastError: unknown;
      const deadline = Math.max(Date.now() + 60_000, candidateStartedAt + 1830_000);
      while (Date.now() < deadline) {
        let unit: Record<string, string>;
        let container: Record<string, any> | null;
        try { unit = await systemProperties(launch.unit); container = await candidateInspect(); }
        catch (error) { lastError = error; await pause(1000); continue; }
        // Reject conflicting identities before either stop command. Container IDs are
        // immutable, so a later reuse of the human-readable name cannot retarget a stop.
        if (unit.LoadState !== 'not-found' && unit.Description !== `gille-317-halogen/${p.runId}`) throw new Error('refuse to stop an unowned unit');
        if (container && container.Config?.Labels?.['gille-inference.run-id'] !== p.runId) throw new Error('unowned container occupies evaluation name');
        if (container && !/^[a-f0-9]{64}$/.test(container.Id ?? '')) throw new Error('invalid container identity');
        if (unit.LoadState !== 'not-found') {
          try { await command('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', launch.unit], 40_000); }
          catch (error) { lastError = error; }
        }
        if (container?.State?.Running === true) {
          try { await command('/usr/bin/podman', ['stop', '--time', '20', container.Id], 30_000); }
          catch (error) {
            lastError = error;
            try { await command('/usr/bin/podman', ['kill', '--signal', 'KILL', container.Id], 10_000); }
            catch (killError) { lastError = new AggregateError([error, killError], 'container stop and kill failed'); }
          }
        }
        try {
          const after = await systemProperties(launch.unit);
          const remaining = await candidateInspect();
          if (after.LoadState !== 'not-found' && after.Description !== `gille-317-halogen/${p.runId}`) throw new Error('unit ownership changed during cleanup');
          if (remaining && (remaining.Config?.Labels?.['gille-inference.run-id'] !== p.runId
            || remaining.Id !== container?.Id)) throw new Error('container identity changed during cleanup');
          if ((after.LoadState === 'not-found' || (after.MainPID === '0' && ['inactive', 'failed'].includes(after.ActiveState ?? '')))
            && (!remaining || remaining.State?.Running === false)) return;
          lastError ??= new Error('candidate still running');
        } catch (error) { lastError = error; }
        await pause(1000);
      }
      throw new Error('cannot verify candidate shutdown', { cause: lastError });
    },
    async assertSafeToRestore() { await protectedUnchanged(); await assertGpuUsers(false, false, false); },
    async restorePriorExperiment() {
      if (await fileSha256(p.prior.argv[0]!) !== p.prior.executableSha256) throw new Error('prior binary changed before restore');
      const model = await stat(p.prior.modelPath);
      if (model.size !== p.prior.modelBytes || Math.abs(model.mtimeMs - p.prior.modelMtimeMs) > 1) throw new Error('prior model changed before restore');
      if (!priorWasStopped) { await priorHealthy(); return; }
      try { await priorIdentity(p.prior.pid); await priorHealthy(); await protectedUnchanged(); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await command('/usr/bin/sudo', ['-n', '/usr/bin/systemd-run', `--unit=${p.prior.restoreName}.service`,
        '--service-type=exec', `--property=User=${p.user}`, `--property=Group=${p.group}`,
        '--property=SupplementaryGroups=render video', `--property=WorkingDirectory=${p.prior.cwd}`,
        '--property=KillMode=control-group', `--setenv=HOME=${home}`, '--setenv=PATH=/usr/bin:/bin',
        ...p.prior.argv]);
      const deadline = Date.now() + 300_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        await protectedUnchanged();
        try {
          priorRestoredPid = Number((await systemProperties(`${p.prior.restoreName}.service`)).MainPID);
          await priorHealthy(); return;
        } catch (error) { lastError = error; }
        await pause(1000);
      }
      throw new Error('prior experiment restoration failed', { cause: lastError });
    },
    async restoreSwap(residents) {
      const current = await running();
      if (current.some(r => !residents.some(original => original.model === r.model))) throw new Error('unexpected resident during restore');
      if (residents.length === 0) { if (current.length !== 0) throw new Error('expected empty residency'); return; }
      await localJson('/v1/chat/completions', { model: residents[0]!.model,
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 2, temperature: 0 });
      const restored = await running();
      if (restored.length !== 1 || restored[0]!.model !== residents[0]!.model) throw new Error('swap residency not restored');
    },
    async verifyRestoration() { await priorHealthy(); await protectedUnchanged(); },
  };
}
