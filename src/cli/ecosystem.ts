import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

/**
 * The timezone to BAKE INTO the generated ecosystem file, as a literal.
 *
 * WHY A LITERAL AND NOT `process.env.TZ || ...`
 * ---------------------------------------------
 * Every other env var in the generated file is written as `process.env.X || 'default'` so PM2 picks up
 * the calling shell's value. For TZ that pattern is not a convenience — it is a live defect.
 *
 * Cron schedules are matched against process-LOCAL time (`nextFireFromCron` compares the cron fields to
 * `d.getHours()`, `d.getDate()`, `d.getDay()`), so THE DAEMON'S TIMEZONE IS THE FLEET'S SCHEDULE. If TZ
 * is read from whoever runs `pm2 start`, then any shell that ever restarts the daemon silently re-times
 * every clock cron in the system.
 *
 * That is not hypothetical. On 2026-09-04 a daemon was restarted from an agent's terminal that had
 * `TZ=UTC` exported. The daemon inherited it, and every `m h * * *` cron in the fleet fired five hours
 * early for nine days before anyone noticed — the schedules were wrong while every status display was
 * green, because each process was internally consistent about its own clock.
 *
 * WHY WE DO NOT JUST READ `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * -------------------------------------------------------------------------
 * That call RESPECTS `process.env.TZ`. Using it here would read the zone off the shell that happens to
 * run `cortextos ecosystem` — reintroducing exactly the contamination this change exists to stop, just
 * one step earlier and far less visibly, because it would be baked in as a literal that LOOKS deliberate.
 *
 * So we read the SYSTEM zone from /etc/localtime, which `TZ` cannot influence, and fall back to `Intl`
 * only where that file does not exist (non-Unix hosts). An explicit `--timezone` always wins: the point
 * is that the value is CHOSEN and reviewable in the file, not inherited by accident.
 */
export function resolveSystemTimezone(explicit?: string): string {
  const validate = (zone: string): string => {
    // Throws RangeError on an invalid identifier, which is what we want: a bad zone should fail at
    // generation time, loudly, rather than produce a daemon that silently falls back to UTC at runtime.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  };

  if (explicit) return validate(explicit);

  // /etc/localtime is a symlink into the zoneinfo database, e.g.
  //   /etc/localtime -> /usr/share/zoneinfo/America/Chicago
  // The zone name is everything after the zoneinfo directory component.
  try {
    const target = realpathSync('/etc/localtime');
    const marker = '/zoneinfo/';
    const idx = target.indexOf(marker);
    if (idx !== -1) {
      const zone = target.slice(idx + marker.length);
      // Some systems interpose a "posix/" or "right/" subdirectory.
      const cleaned = zone.replace(/^(posix|right)\//, '');
      if (cleaned) return validate(cleaned);
    }
  } catch {
    // fall through to Intl
  }

  return validate(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export const ecosystemCommand = new Command('ecosystem')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <name>', 'Organization name (auto-detected if not specified)')
  .option('--output <path>', 'Output file', 'ecosystem.config.js')
  .option('--timezone <zone>', 'IANA timezone to bake into the daemon env as a literal (default: the system zone, read from /etc/localtime so an exported TZ cannot influence it)')
  .description('Generate PM2 ecosystem.config.js from agent configs')
  .action(async (options: { instance: string; org?: string; output: string; timezone?: string }) => {
    const timezone = resolveSystemTimezone(options.timezone);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    // BUG-035 (companion fix): same project-root discovery as enable-agent.ts
    // so `cortextos ecosystem` works from outside ~/cortextos.
    let projectRoot: string;
    if (process.env.CTX_FRAMEWORK_ROOT) {
      projectRoot = process.env.CTX_FRAMEWORK_ROOT;
    } else if (process.env.CTX_PROJECT_ROOT) {
      projectRoot = process.env.CTX_PROJECT_ROOT;
    } else {
      const canonical = join(homedir(), 'cortextos');
      projectRoot = existsSync(join(canonical, 'orgs')) ? canonical : process.cwd();
    }

    // Find all agents
    const agents: Array<{ name: string; dir: string; org?: string }> = [];

    // Scan orgs/*/agents/*
    const orgsDir = join(projectRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agent.isDirectory()) continue;
          agents.push({ name: agent.name, dir: join(agentsDir, agent.name), org: org.name });
        }
      }
    }

    if (agents.length === 0) {
      console.log('No agents found. Add agents first: cortextos add-agent <name>');
      return;
    }

    // Determine org: use --org flag, or auto-detect from first agent found
    const detectedOrg = options.org || agents.find(a => a.org)?.org || '';
    if (!detectedOrg) {
      console.error('Could not determine org. Use --org <name>.');
      return;
    }

    // Use dist/ in project root for all scripts
    const distDir = join(projectRoot, 'dist');
    const daemonScript = join(distDir, 'daemon.js');
    const dashboardDir = join(projectRoot, 'dashboard');
    // BUG-019 + cycle-2 finding: require BOTH package.json AND node_modules/.bin/next.
    // Without the second check, running `cortextos ecosystem` before
    // `npm install` in dashboard/ produces a crash-looped PM2 entry that the
    // user sees as "dashboard keeps restarting". Better to silently skip the
    // dashboard entry if its deps aren't installed yet — the user can re-run
    // `cortextos ecosystem` after `npm install` to add it.
    const hasDashboard = existsSync(join(dashboardDir, 'package.json')) &&
      existsSync(join(dashboardDir, 'node_modules', '.bin', 'next'));

    // BUG-002 fix: emit ecosystem.config.js as raw JS that resolves
    // process.env.CTX_INSTANCE_ID at PM2-startup time, not at generation time.
    // The previous JSON.stringify approach baked the instance id into the
    // generated file, so instance switching required regenerating the file.
    // Now: `CTX_INSTANCE_ID=other pm2 restart cortextos-daemon` just works.
    //
    // BUG-016 fix: bumped max_restarts from 10 to 50. PM2's max_restarts
    // controls how many times PM2 itself restarts cortextos-daemon if it
    // crashes — independent of in-daemon agent crash counting. 10 was too
    // low: a transient infrastructure wobble could exhaust retries before
    // the daemon stabilized. 50 leaves real headroom.
    //
    // BUG-019 fix: emit a cortextos-dashboard PM2 entry alongside the daemon
    // so the dashboard runs under PM2 supervision instead of as an orphan
    // `npm run dev &` background shell job started by /onboarding. Now it
    // gets restart-on-crash, log files in ~/.pm2/logs/, and reboot survival
    // via `pm2 startup`/`pm2 save`. The dashboard PM2 entry is only added
    // if dashboard/package.json exists (to keep the generator working in
    // minimal/test installs).
    // PM2 on Windows can't execute `npm` directly — `npm.cmd` is a Windows
    // .cmd shim that PM2's node-based loader tries to interpret as JS, which
    // fails immediately ("Unexpected token ':'"). Bypass the shim by pointing
    // PM2 at the local Next.js binary that `npm run dev` would run anyway.
    // The `next` entry resolves under dashboard/node_modules/next/dist/bin/next
    // and is just a Node script, so PM2 spawns it cleanly on every platform.
    const isWindows = process.platform === 'win32';
    const nextBin = join(dashboardDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    const dashboardScript = isWindows && existsSync(nextBin) ? nextBin : 'npm';
    const dashboardArgs = isWindows && existsSync(nextBin) ? 'dev' : 'run dev';

    // windowsHide: stops PM2 from attaching a visible "next-server" console
    // window to the dashboard process at boot on Windows. PM2's default
    // CreateProcess flags include the parent console; on Linux/macOS the
    // process is already daemonized so this is invisible. Harmless if true
    // on non-Windows (PM2 ignores the flag). Surfaces as a stray terminal
    // titled "next-server (vX.Y.Z)" after `pm2 resurrect` post-reboot.
    const dashboardAppBlock = hasDashboard
      ? `,
    {
      name: 'cortextos-dashboard',
      script: ${JSON.stringify(dashboardScript)},
      args: ${JSON.stringify(dashboardArgs)},
      cwd: ${JSON.stringify(dashboardDir)},
      env: {
        PORT: process.env.PORT || '3000',
      },
      // Dashboard reads its real config from dashboard/.env.local — populated
      // by /onboarding Phase 7. PM2 just supervises the dashboard process.
      windowsHide: true,
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }`
      : '';

    const content = `// AUTO-GENERATED by \`cortextos ecosystem\`. Do NOT edit by hand.
// Re-run \`cortextos ecosystem\` to regenerate.
//
// Note: env vars use process.env.X || 'default' so PM2 picks up the value
// from the calling shell at startup time. This means \`CTX_INSTANCE_ID=foo
// pm2 restart cortextos-daemon\` switches instances without regenerating.
//
// TZ is the deliberate exception: it is written as a LITERAL so the daemon's
// clock cannot be changed by whoever happens to restart it. See the comment
// on the TZ line itself.
module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: ${JSON.stringify(daemonScript)},
      args: '--instance ' + (process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)}),
      cwd: ${JSON.stringify(projectRoot)},
      env: {
        CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)},
        CTX_ROOT: process.env.CTX_ROOT || ${JSON.stringify(ctxRoot)},
        CTX_FRAMEWORK_ROOT: ${JSON.stringify(projectRoot)},
        CTX_PROJECT_ROOT: ${JSON.stringify(projectRoot)},
        CTX_ORG: process.env.CTX_ORG || ${JSON.stringify(detectedOrg)},
        // TZ is a LITERAL, deliberately NOT \`process.env.TZ || ...\` like the vars above.
        //
        // Cron schedules are matched against process-LOCAL time, so the daemon's timezone IS the
        // fleet's schedule. Reading TZ from the calling shell means any shell that ever restarts the
        // daemon silently re-times every clock cron. That happened here: a daemon restarted from a
        // terminal with TZ=UTC exported ran every \`m h * * *\` cron five hours early for nine days,
        // while every status display stayed green.
        //
        // Baked at generation time from the SYSTEM zone (/etc/localtime), which an exported TZ cannot
        // influence. Change it by re-running \`cortextos ecosystem --timezone <zone>\`, or by editing
        // this line — both are visible and reviewable. Do not turn it back into a shell lookup.
        TZ: ${JSON.stringify(timezone)},
      },
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }${dashboardAppBlock},
  ],
};
`;

    writeFileSync(options.output, content, 'utf-8');
    console.log(`Generated ${options.output} with daemon (manages ${agents.length} agents)${hasDashboard ? ' + dashboard' : ''}`);
    // Say the zone out loud. It is the one baked-in value a reader cannot change by exporting a
    // variable, so it is the one worth seeing at generation time rather than discovering at 3am.
    console.log(`Daemon timezone: ${timezone}${options.timezone ? ' (explicit --timezone)' : ' (system zone)'}`);
    console.log('\nStart with:');
    console.log(`  pm2 start ${options.output}`);
    console.log('  pm2 save');
  });
