/** Lab-only launcher plan. Creating this argv does not authorize execution. */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { halogenEnvironment, halogenProfileSchema, type HalogenProfile } from './halogen-profile.js';

export const HALOGEN_MEMORY_BYTES = 96 * 1024 ** 3;
export const HALOGEN_RUNTIME_SECONDS = 1800;
const names = z.string().regex(/^gille-317-halogen-[0-9]{2}$/);
const optionsSchema = z.object({
  name: names,
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  group: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  uid: z.number().int().positive(),
  homeDirectory: z.string().regex(/^\/home\/[a-z_][a-z0-9_-]*$/),
  artifactDirectory: z.string().refine(p => isAbsolute(p) && !p.includes(':') && !p.includes(',')
    && !p.split('/').includes('..') && !/[\r\n\0]/.test(p), 'plain absolute artifact directory required'),
}).strict();
export interface HalogenLaunch { command: string; args: string[]; unit: string; container: string }

export function buildHalogenLaunch(profile: unknown, options: unknown): HalogenLaunch {
  const p = halogenProfileSchema.parse(profile);
  const o = optionsSchema.parse(options);
  if (!o.artifactDirectory.endsWith('/' + p.modelRevision)) throw new Error('artifact revision directory mismatch');
  if (o.user === 'root' || o.group === 'root') throw new Error('unprivileged identity required');
  if (o.homeDirectory !== '/home/' + o.user) throw new Error('user home mismatch');
  const environment = { ...halogenEnvironment(p), PYTHONDONTWRITEBYTECODE: '1' };
  return {
    command: '/usr/bin/sudo', unit: `${o.name}.service`, container: o.name,
    args: ['-n', '/usr/bin/systemd-run', `--unit=${o.name}.service`, '--service-type=exec',
      `--property=User=${o.user}`, `--property=Group=${o.group}`,
      '--property=SupplementaryGroups=render video',
      `--property=Description=gille-317-halogen/${o.runId}`,
      `--property=LimitMEMLOCK=${HALOGEN_MEMORY_BYTES}`,
      `--setenv=HOME=${o.homeDirectory}`, `--setenv=XDG_RUNTIME_DIR=/run/user/${o.uid}`,
      '--setenv=PATH=/usr/bin:/bin',
      `--property=MemoryMax=${HALOGEN_MEMORY_BYTES}`, '--property=MemorySwapMax=0',
      '--property=OOMPolicy=kill', '--property=KillMode=control-group', '--property=TasksMax=512',
      `--property=RuntimeMaxSec=${HALOGEN_RUNTIME_SECONDS}`, '--property=TimeoutStopSec=30',
      '--property=RemainAfterExit=yes',
      '/usr/bin/podman', 'run', `--name=${o.name}`, `--label=gille-inference.run-id=${o.runId}`, '--pull=never', '--network=none',
      '--cgroups=disabled', '--read-only', '--read-only-tmpfs=false', '--image-volume=ignore',
      '--ipc=private', '--shm-size=512m',
      `--ulimit=memlock=${HALOGEN_MEMORY_BYTES}:${HALOGEN_MEMORY_BYTES}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--group-add=keep-groups', '--device=/dev/kfd', '--device=/dev/dri/renderD128',
      '--volume', `${o.artifactDirectory}:/models:ro`,
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m',
      '--tmpfs=/var/tmp:rw,noexec,nosuid,nodev,size=512m',
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      p.image, 'all'],
  };
}

/** Check the actual API allocation report before making qualification requests. */
export function verifyHalogenHealth(profile: unknown, health: unknown): string[] {
  const p: HalogenProfile = halogenProfileSchema.parse(profile);
  const parsed = z.object({
    version: z.object({ api: z.literal('0.9.1'), engine: z.literal('0.9.1'), match: z.literal(true) }),
    engine: z.object({ responds: z.literal(true) }),
    checkpoint_format: z.literal('hgn'),
    slots: z.number().int(), slot_ctx: z.number().int(), kv_pool_positions: z.number().int(),
    max_tokens_cap: z.number().int(), prompt_cache: z.object({ mode: z.number().int() }),
    prompt_lookup: z.unknown(), drafter_default: z.string(), drafters_available: z.array(z.string()),
    server_defaults: z.record(z.unknown()),
  }).safeParse(health);
  if (!parsed.success) return ['malformed-or-wrong-runtime-health'];
  const h = parsed.data;
  const reasons: string[] = [];
  if (h.slots !== p.slots) reasons.push('slot-count-mismatch');
  if (h.slot_ctx !== p.context) reasons.push('context-mismatch');
  if (h.kv_pool_positions !== p.context) reasons.push('kv-pool-mismatch');
  if (h.max_tokens_cap !== p.maxTokens) reasons.push('output-budget-mismatch');
  if (h.prompt_cache.mode !== p.cacheMode) reasons.push('cache-mode-mismatch');
  if (h.drafter_default !== 'mtp' || !h.drafters_available.includes('mtp')) reasons.push('drafter-mismatch');
  if (h.prompt_lookup !== 'off') reasons.push('prompt-lookup-mismatch');
  const defaults: Record<string, unknown> = { HALOGEN_MAX_TOKENS_DEFAULT: p.maxTokens,
    HALOGEN_TEMPERATURE: p.temperature, HALOGEN_TOP_P: p.topP, HALOGEN_TOP_K: p.topK,
    HALOGEN_MIN_P: p.minP, HALOGEN_PRESENCE_PENALTY: p.presencePenalty,
    HALOGEN_ENABLE_THINKING: p.thinking, HALOGEN_REASONING_EFFORT: p.reasoningEffort };
  if (Object.entries(defaults).some(([key, value]) => h.server_defaults[key] !== value)) reasons.push('server-default-mismatch');
  return reasons;
}
