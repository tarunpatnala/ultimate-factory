import type { FactoryConfig } from '../config/types.js';
import { pullRecords, pushRecords } from '../runs/sync.js';
import { log } from '../util/log.js';

/** `ufactory records pull|push`: keep run records on a branch so CI history outlives artifacts. */
export async function recordsCommand(cfg: FactoryConfig, o: { cwd: string; sub: 'pull' | 'push'; apply: boolean; days?: number }): Promise<number> {
  const common = { cwd: o.cwd, remote: cfg.github.remote, runsDir: cfg.factory.runs_dir, log };
  if (o.sub === 'pull') await pullRecords({ ...common, days: o.days });
  else await pushRecords({ ...common, apply: o.apply });
  return 0;
}
